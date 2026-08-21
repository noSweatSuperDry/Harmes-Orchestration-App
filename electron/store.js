'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * Config lives in the user's home, not inside Electron's opaque userData dir,
 * so it can be hand-edited, backed up, and documented for a public repo.
 * Override with HERMES_ORCHESTRATOR_CONFIG=/path/to/config.json
 */
const CONFIG_PATH = process.env.HERMES_ORCHESTRATOR_CONFIG
  ? path.resolve(expandTilde(process.env.HERMES_ORCHESTRATOR_CONFIG))
  : path.join(os.homedir(), '.hermes-orchestrator', 'config.json');

const DEFAULTS = () => ({
  defaults: {
    username: os.userInfo().username,
    privateKeyPath: defaultKeyPath(),
    port: 22,
    profile: 'default',
    hermesHome: '',
    auth: 'key'
  },
  ui: { motion: 'always', lastHostId: null, lastTab: 'overview' },
  hosts: []
});

let cache = null;

function expandTilde(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function defaultKeyPath() {
  for (const name of ['id_ed25519', 'id_rsa', 'id_ecdsa']) {
    const p = path.join(os.homedir(), '.ssh', name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(os.homedir(), '.ssh', 'id_ed25519');
}

function init(legacyUserDataDir) {
  load();
  if (!cache.hosts.length && legacyUserDataDir) migrateLegacy(legacyUserDataDir);
  if (!fs.existsSync(CONFIG_PATH)) persist();
  return cache;
}

function load() {
  const base = DEFAULTS();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    cache = {
      defaults: { ...base.defaults, ...(raw.defaults || {}) },
      ui: { ...base.ui, ...(raw.ui || {}) },
      hosts: Array.isArray(raw.hosts) ? raw.hosts : []
    };
  } catch {
    cache = base;
  }
  return cache;
}

/** One-time lift of hosts written by pre-0.2 builds. */
function migrateLegacy(userDataDir) {
  const legacy = path.join(userDataDir, 'hosts.json');
  try {
    const raw = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    if (Array.isArray(raw.hosts) && raw.hosts.length) {
      cache.hosts = raw.hosts;
      persist();
    }
  } catch { /* nothing to migrate */ }
}

function persist() {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
}

/* --------------------------------- hosts --------------------------------- */

/** Paths are stored as the user wrote them; consumers get them expanded. */
function hydrate(host) {
  if (!host) return host;
  return { ...host, privateKeyPath: expandTilde(host.privateKeyPath) };
}

const listHosts = () => cache.hosts.map(hydrate);
const getHost = (id) => hydrate(cache.hosts.find((h) => h.id === id) || null);

function saveHost(input) {
  const d = cache.defaults;
  const auth = input.auth === 'password' ? 'password' : 'key';
  const host = {
    id: input.id || crypto.randomUUID(),
    label: (input.label || '').trim() || (input.hostname || '').trim(),
    hostname: (input.hostname || '').trim(),
    port: Number(input.port) || d.port || 22,
    username: (input.username || '').trim() || d.username,
    auth,
    // Never a password — only whether one was saved to the OS keychain.
    savePassword: auth === 'password' ? Boolean(input.savePassword) : false,
    privateKeyPath: auth === 'password' ? '' : ((input.privateKeyPath || '').trim() || d.privateKeyPath),
    hermesHome: (input.hermesHome || '').trim() || d.hermesHome || '',
    defaultProfile: (input.defaultProfile || '').trim() || d.profile || 'default'
  };
  const idx = cache.hosts.findIndex((h) => h.id === host.id);
  if (idx >= 0) cache.hosts[idx] = { ...cache.hosts[idx], ...host };
  else cache.hosts.push(host);
  persist();
  return hydrate(host);
}

function deleteHost(id) {
  cache.hosts = cache.hosts.filter((h) => h.id !== id);
  persist();
}

/* ------------------------------- settings -------------------------------- */

const getDefaults = () => ({ ...cache.defaults });

function setDefaults(patch) {
  cache.defaults = { ...cache.defaults, ...patch };
  if (!cache.defaults.port) cache.defaults.port = 22;
  if (cache.defaults.auth !== 'password') cache.defaults.auth = 'key';
  persist();
  return getDefaults();
}

const getUi = () => ({ ...cache.ui });

function setUi(patch) {
  cache.ui = { ...cache.ui, ...patch };
  persist();
  return getUi();
}

const configInfo = () => ({ path: CONFIG_PATH, exists: fs.existsSync(CONFIG_PATH) });
const reload = () => { load(); return { hosts: listHosts(), ui: getUi(), defaults: getDefaults() }; };

/* --------------------------- ~/.ssh/config import ------------------------- */

function parseSshConfig(text) {
  const entries = [];
  let current = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\w+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'host') {
      // A pattern is a rule, not a machine you can connect to.
      const alias = value.split(/\s+/).find((a) => !/[*?!]/.test(a));
      current = alias ? { alias, hostname: '', username: '', port: 0, identityFile: '' } : null;
      if (current) entries.push(current);
      continue;
    }
    if (!current) continue;
    if (key === 'hostname') current.hostname = value;
    else if (key === 'user') current.username = value;
    else if (key === 'port') current.port = Number(value) || 0;
    else if (key === 'identityfile') current.identityFile = value.replace(/^["']|["']$/g, '');
  }
  return entries.filter((e) => e.hostname || e.alias);
}

function importSshConfig() {
  const file = path.join(os.homedir(), '.ssh', 'config');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { added: 0, skipped: 0, found: 0, file, error: 'no ~/.ssh/config on this machine' };
    return { added: 0, skipped: 0, found: 0, file, error: err.message };
  }

  const entries = parseSshConfig(text);
  let added = 0;
  let skipped = 0;
  for (const e of entries) {
    const hostname = e.hostname || e.alias;
    if (cache.hosts.some((h) => h.hostname === hostname && h.username === (e.username || cache.defaults.username))) {
      skipped++;
      continue;
    }
    saveHost({
      label: e.alias,
      hostname,
      port: e.port || cache.defaults.port,
      username: e.username || cache.defaults.username,
      auth: 'key',
      privateKeyPath: e.identityFile || cache.defaults.privateKeyPath
    });
    added++;
  }
  return { added, skipped, found: entries.length, file, error: null };
}

module.exports = {
  init, listHosts, getHost, saveHost, deleteHost,
  getUi, setUi, getDefaults, setDefaults,
  configInfo, reload, importSshConfig, parseSshConfig,
  defaultKeyPath, expandTilde, CONFIG_PATH
};
