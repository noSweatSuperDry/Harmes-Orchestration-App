'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Finds machines you have already reached over SSH from this computer.
 * Everything here is read-only and stays local — only hostnames, usernames
 * and ports are extracted, never the rest of a history line.
 */

const { parseSshConfig } = require('./store');

const HOME = () => os.homedir();

/* ----------------------------- known_hosts ------------------------------- */

/** Lines look like: `host[,host2] keytype base64`, or `[host]:2222 keytype …`. */
function parseKnownHosts(text) {
  const out = [];
  for (const raw of (text || '').split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Marker lines carry the real entry after the marker.
    if (line.startsWith('@')) line = line.replace(/^@\S+\s+/, '');
    // Hashed entries are HMACs — the hostname cannot be recovered.
    if (line.startsWith('|1|')) continue;

    const first = line.split(/\s+/)[0];
    if (!first) continue;
    for (const pattern of first.split(',')) {
      const bracket = /^\[(.+?)\]:(\d+)$/.exec(pattern);
      const hostname = bracket ? bracket[1] : pattern;
      const port = bracket ? Number(bracket[2]) : 22;
      // Wildcards are rules, not machines.
      if (!hostname || /[*?!]/.test(hostname)) continue;
      out.push({ hostname, port });
    }
  }
  return out;
}

/* ---------------------------- shell history ------------------------------ */

const SSH_LIKE = /^(ssh|sftp|ssh-copy-id|scp|rsync)$/;

/** Pull `[user@]host` and `-p PORT` out of an ssh-ish command line. */
function parseCommand(cmd) {
  const tokens = cmd.trim().split(/\s+/);
  if (!tokens.length) return null;
  const bin = path.basename(tokens[0]);
  if (!SSH_LIKE.test(bin)) return null;

  let port = 0;
  let target = null;

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-p' || t === '-P') { port = Number(tokens[++i]) || 0; continue; }
    if (/^-[pP]\d+$/.test(t)) { port = Number(t.slice(2)) || 0; continue; }
    // Options that consume the next token.
    if (/^-[oiJlFbcEDLRWw]$/.test(t)) { i++; continue; }
    if (t.startsWith('-')) continue;
    if (target) continue;

    // scp/rsync targets look like host:/path — the path is not ours to keep.
    let candidate = t.includes(':') && !t.startsWith('[') ? t.split(':')[0] : t;
    if (!candidate || candidate.includes('/')) continue;
    target = candidate;
  }
  if (!target) return null;

  let username = '';
  let hostname = target;
  const at = target.lastIndexOf('@');
  if (at > 0) { username = target.slice(0, at); hostname = target.slice(at + 1); }

  if (!hostname || !/^[A-Za-z0-9._-]+$/.test(hostname)) return null;
  if (!hostname.includes('.') && !/^[A-Za-z0-9-]+$/.test(hostname)) return null;
  return { hostname, username, port: port || 22 };
}

/** Handles plain histories and zsh extended format (`: 1699999999:0;cmd`). */
function parseHistory(text) {
  const out = [];
  for (const raw of (text || '').split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    const zsh = /^:\s*\d+:\d+;(.*)$/.exec(line);
    if (zsh) line = zsh[1];
    // fish stores `- cmd: ssh host`
    const fish = /^-\s*cmd:\s*(.*)$/.exec(line);
    if (fish) line = fish[1];
    // A single history entry can chain several commands.
    for (const part of line.split(/&&|\|\||;|\|/)) {
      const hit = parseCommand(part);
      if (hit) out.push(hit);
    }
  }
  return out;
}

/* -------------------------------- scan ----------------------------------- */

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

function scan(existingHosts = [], defaults = {}) {
  const candidates = new Map(); // "user@host:port" -> record
  const stats = { sources: [], hashedSkipped: 0 };

  const add = ({ hostname, username, port }, source, extra = {}) => {
    if (!hostname) return;
    const key = `${username || ''}@${hostname}:${port || 22}`;
    const rec = candidates.get(key) || {
      hostname, username: username || '', port: port || 22,
      label: '', privateKeyPath: '', sources: [], count: 0
    };
    if (!rec.sources.includes(source)) rec.sources.push(source);
    // ~/.ssh/config is the only source that knows a friendly name or key file.
    if (extra.label && !rec.label) rec.label = extra.label;
    if (extra.privateKeyPath && !rec.privateKeyPath) rec.privateKeyPath = extra.privateKeyPath;
    rec.count++;
    candidates.set(key, rec);
  };

  /* ~/.ssh/config — aliases, explicit users, per-host identity files */
  {
    const file = path.join(HOME(), '.ssh', 'config');
    const text = read(file);
    if (text != null) {
      const entries = parseSshConfig(text);
      for (const e of entries) {
        add(
          { hostname: e.hostname || e.alias, username: e.username, port: e.port || 22 },
          'ssh_config',
          { label: e.alias, privateKeyPath: e.identityFile }
        );
      }
      stats.sources.push({ file, entries: entries.length });
    }
  }

  /* known_hosts — the definitive record of what you have connected to */
  for (const name of ['known_hosts', 'known_hosts.old']) {
    const file = path.join(HOME(), '.ssh', name);
    const text = read(file);
    if (text == null) continue;
    stats.hashedSkipped += (text.match(/^\|1\|/gm) || []).length;
    const found = parseKnownHosts(text);
    for (const h of found) add(h, name);
    stats.sources.push({ file, entries: found.length });
  }

  /* shell history — the only place the username shows up */
  const histories = [
    ['.zsh_history', path.join(HOME(), '.zsh_history')],
    ['.bash_history', path.join(HOME(), '.bash_history')],
    ['fish_history', path.join(HOME(), '.local/share/fish/fish_history')]
  ];
  for (const [label, file] of histories) {
    const text = read(file);
    if (text == null) continue;
    const found = parseHistory(text);
    for (const h of found) add(h, label);
    stats.sources.push({ file, entries: found.length });
  }

  /* A hostname with a known username subsumes the same host without one. */
  for (const [key, rec] of [...candidates]) {
    if (rec.username) continue;
    const named = [...candidates.values()].find(
      (o) => o.username && o.hostname === rec.hostname && o.port === rec.port
    );
    if (named) {
      named.count += rec.count;
      for (const s of rec.sources) if (!named.sources.includes(s)) named.sources.push(s);
      if (rec.label && !named.label) named.label = rec.label;
      if (rec.privateKeyPath && !named.privateKeyPath) named.privateKeyPath = rec.privateKeyPath;
      candidates.delete(key);
    }
  }

  const isLocal = (h) => /^(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)$/i.test(h);

  return {
    stats,
    candidates: [...candidates.values()]
      .filter((c) => !isLocal(c.hostname))
      .map((c) => ({
        ...c,
        username: c.username || defaults.username || '',
        existing: existingHosts.some(
          (h) => h.hostname === c.hostname && (!c.username || h.username === c.username)
        )
      }))
      .sort((a, b) => (a.existing === b.existing ? b.count - a.count : a.existing ? 1 : -1))
  };
}

module.exports = { scan, parseKnownHosts, parseHistory, parseCommand };
