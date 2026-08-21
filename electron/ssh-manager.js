'use strict';
const fs = require('fs');
const { Client, utils: { parseKey } } = require('ssh2');
const { EventEmitter } = require('events');

const bus = new EventEmitter();

/** hostId -> { client, status, error, shells:Map<termId, stream> } */
const sessions = new Map();

function stateOf(hostId) {
  if (!sessions.has(hostId)) {
    sessions.set(hostId, { client: null, status: 'disconnected', error: null, shells: new Map(), connecting: null });
  }
  return sessions.get(hostId);
}

function setStatus(hostId, status, error) {
  const s = stateOf(hostId);
  s.status = status;
  s.error = error || null;
  bus.emit('status', { hostId, status, error: s.error });
}

function statusFor(hostId) {
  const s = stateOf(hostId);
  return { status: s.status, error: s.error };
}

/**
 * Classify a key file before we ever open a socket, so "needs a passphrase"
 * is a fact about the key rather than a guess about an error string.
 * Returns { key, encrypted } or throws a message worth showing the user.
 */
function loadKey(keyPath, passphrase) {
  let raw;
  try {
    raw = fs.readFileSync(keyPath);
  } catch (err) {
    throw new Error(`Cannot read key ${keyPath}: ${err.code === 'ENOENT' ? 'file not found' : err.message}`);
  }

  const bare = parseKey(raw);
  const encrypted = bare instanceof Error && /encrypted|passphrase/i.test(bare.message);

  if (!encrypted) {
    if (bare instanceof Error) throw new Error(`Key ${keyPath} is unusable: ${bare.message}`);
    return { key: raw, encrypted: false };
  }

  if (!passphrase) {
    const err = new Error('Key is passphrase-protected');
    err.needsPassphrase = true;
    throw err;
  }

  const unlocked = parseKey(raw, passphrase);
  if (unlocked instanceof Error) {
    const err = new Error('That passphrase did not unlock the key');
    err.needsPassphrase = true;
    throw err;
  }
  return { key: raw, encrypted: true };
}

/** Turn ssh2's terse failures into something you can act on. */
function describeFailure(err, host, keyLoaded) {
  const msg = err.message || String(err);
  if (err.level === 'client-authentication' || /authentication methods failed/i.test(msg)) {
    if (host.auth === 'password') {
      return `Password rejected by ${host.hostname}. Check the password, and that the server allows password login (PasswordAuthentication yes).`;
    }
    return keyLoaded
      ? `Server rejected the key. Is this key's public half in ~${host.username}/.ssh/authorized_keys on ${host.hostname}?`
      : `Authentication failed and no usable key was loaded for ${host.username}@${host.hostname}.`;
  }
  if (err.code === 'ENOTFOUND' || /getaddrinfo/i.test(msg)) return `Host not found: ${host.hostname}`;
  if (err.code === 'ECONNREFUSED') return `Connection refused on ${host.hostname}:${host.port || 22}`;
  if (err.code === 'ETIMEDOUT' || /timed out/i.test(msg)) return `Timed out reaching ${host.hostname}:${host.port || 22}`;
  return msg;
}

function connect(host, opts = {}) {
  const s = stateOf(host.id);
  if (s.client && s.status === 'connected') return Promise.resolve(s.client);
  if (s.connecting) return s.connecting;

  const attempt = doConnect(host, opts, s);
  s.connecting = attempt;
  attempt.catch(() => {}).then(() => { if (s.connecting === attempt) s.connecting = null; });
  return attempt;
}

function doConnect(host, opts, s) {
  return new Promise((resolve, reject) => {
    setStatus(host.id, 'connecting');

    const config = {
      host: host.hostname,
      port: host.port || 22,
      username: host.username,
      keepaliveInterval: 15000,
      readyTimeout: 20000
    };

    const usePassword = host.auth === 'password';
    let keyLoaded = false;

    if (usePassword) {
      if (!opts.password) {
        const err = new Error('Password required');
        err.needsPassword = true;
        setStatus(host.id, 'error', 'Password required');
        return reject(err);
      }
      config.password = opts.password;
      // Many sshd configs answer with keyboard-interactive rather than plain
      // password auth; without this they look like an outright rejection.
      config.tryKeyboard = true;
    } else {
      if (host.privateKeyPath) {
        let loaded;
        try {
          loaded = loadKey(host.privateKeyPath, opts.passphrase);
        } catch (err) {
          setStatus(host.id, 'error', err.message);
          return reject(err);
        }
        config.privateKey = loaded.key;
        // Only hand ssh2 a passphrase when the key actually wants one.
        if (loaded.encrypted && opts.passphrase) config.passphrase = opts.passphrase;
        keyLoaded = true;
      }
      // The agent is a fallback, never a replacement for an explicit key.
      if (process.env.SSH_AUTH_SOCK) config.agent = process.env.SSH_AUTH_SOCK;
    }

    const client = new Client();

    if (usePassword) {
      client.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
        finish(prompts.map(() => opts.password));
      });
    }
    let settled = false;

    client.on('ready', () => {
      settled = true;
      s.client = client;
      setStatus(host.id, 'connected');
      resolve(client);
    });

    client.on('error', (err) => {
      console.error(`[ssh:${host.hostname}] ${err.level || 'error'}: ${err.message}`);
      const friendly = describeFailure(err, host, keyLoaded);
      if (settled) { setStatus(host.id, 'error', friendly); return; }
      settled = true;
      s.client = null;
      try { client.end(); } catch {}
      setStatus(host.id, 'error', friendly);
      reject(new Error(friendly));
    });

    client.on('close', () => {
      for (const stream of s.shells.values()) { try { stream.end(); } catch {} }
      s.shells.clear();
      s.client = null;
      if (s.status !== 'error') setStatus(host.id, 'disconnected');
    });

    client.connect(config);
  });
}

function disconnect(hostId) {
  const s = stateOf(hostId);
  if (s.client) { try { s.client.end(); } catch {} }
  s.client = null;
  setStatus(hostId, 'disconnected');
}

function requireClient(hostId) {
  const s = stateOf(hostId);
  if (!s.client || s.status !== 'connected') throw new Error('Not connected');
  return s.client;
}

/** Runs through a login shell so PATH picks up hermes. */
function exec(hostId, command) {
  const client = requireClient(hostId);
  return new Promise((resolve, reject) => {
    client.exec(`bash -lc ${shq(command)}`, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (d) => { stdout += d.toString('utf8'); });
      stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      stream.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    });
  });
}

function shq(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function sftp(hostId) {
  const client = requireClient(hostId);
  return new Promise((resolve, reject) => {
    client.sftp((err, sf) => (err ? reject(err) : resolve(sf)));
  });
}

async function readFile(hostId, remotePath) {
  const sf = await sftp(hostId);
  return new Promise((resolve, reject) => {
    sf.readFile(remotePath, 'utf8', (err, data) => {
      sf.end();
      if (err) {
        if (err.code === 2 || /no such file/i.test(err.message)) return resolve(null);
        return reject(err);
      }
      resolve(data);
    });
  });
}

async function writeFile(hostId, remotePath, content, mode) {
  const sf = await sftp(hostId);
  return new Promise((resolve, reject) => {
    sf.writeFile(remotePath, content, { encoding: 'utf8', mode: mode || 0o644 }, (err) => {
      if (err) { sf.end(); return reject(err); }
      sf.chmod(remotePath, mode || 0o644, () => { sf.end(); resolve(true); });
    });
  });
}

async function listDir(hostId, remotePath) {
  const sf = await sftp(hostId);
  return new Promise((resolve) => {
    sf.readdir(remotePath, (err, list) => {
      sf.end();
      resolve(err ? [] : list.map((e) => ({ name: e.filename, dir: e.longname.startsWith('d') })));
    });
  });
}

function openShell(hostId, termId, { cols = 100, rows = 30, initialCommand } = {}) {
  const client = requireClient(hostId);
  const s = stateOf(hostId);
  return new Promise((resolve, reject) => {
    client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
      if (err) return reject(err);
      s.shells.set(termId, stream);
      stream.on('data', (d) => bus.emit('term-data', { hostId, termId, data: d.toString('utf8') }));
      stream.stderr.on('data', (d) => bus.emit('term-data', { hostId, termId, data: d.toString('utf8') }));
      stream.on('close', () => {
        s.shells.delete(termId);
        bus.emit('term-exit', { hostId, termId });
      });
      if (initialCommand) stream.write(`${initialCommand}\n`);
      resolve(true);
    });
  });
}

function writeShell(hostId, termId, data) {
  const stream = stateOf(hostId).shells.get(termId);
  if (stream) stream.write(data);
}

function resizeShell(hostId, termId, cols, rows) {
  const stream = stateOf(hostId).shells.get(termId);
  if (stream) try { stream.setWindow(rows, cols, 0, 0); } catch {}
}

function closeShell(hostId, termId) {
  const stream = stateOf(hostId).shells.get(termId);
  if (stream) { try { stream.end(); } catch {} stateOf(hostId).shells.delete(termId); }
}

module.exports = {
  bus, connect, disconnect, statusFor, exec, readFile, writeFile, listDir,
  openShell, writeShell, resizeShell, closeShell, shq
};
