'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let filePath = null;
let cache = null;

const DEFAULTS = {
  hosts: [],
  ui: { lastHostId: null, lastTab: 'overview' }
};

function init(userDataDir) {
  filePath = path.join(userDataDir, 'hosts.json');
  load();
  return cache;
}

function load() {
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch {
    cache = JSON.parse(JSON.stringify(DEFAULTS));
  }
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

function defaultKeyPath() {
  for (const name of ['id_ed25519', 'id_rsa', 'id_ecdsa']) {
    const p = path.join(os.homedir(), '.ssh', name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(os.homedir(), '.ssh', 'id_ed25519');
}

function listHosts() {
  return cache.hosts;
}

function getHost(id) {
  return cache.hosts.find((h) => h.id === id) || null;
}

function saveHost(input) {
  const host = {
    id: input.id || crypto.randomUUID(),
    label: (input.label || '').trim() || input.hostname,
    hostname: (input.hostname || '').trim(),
    port: Number(input.port) || 22,
    username: (input.username || '').trim() || 'zahid',
    privateKeyPath: (input.privateKeyPath || '').trim() || defaultKeyPath(),
    hermesHome: (input.hermesHome || '').trim(),
    defaultProfile: (input.defaultProfile || '').trim() || 'default',
    color: input.color || '#6ea8fe'
  };
  const idx = cache.hosts.findIndex((h) => h.id === host.id);
  if (idx >= 0) cache.hosts[idx] = { ...cache.hosts[idx], ...host };
  else cache.hosts.push(host);
  persist();
  return host;
}

function deleteHost(id) {
  cache.hosts = cache.hosts.filter((h) => h.id !== id);
  persist();
}

function setUi(patch) {
  cache.ui = { ...cache.ui, ...patch };
  persist();
  return cache.ui;
}

function getUi() {
  return cache.ui;
}

module.exports = { init, listHosts, getHost, saveHost, deleteHost, setUi, getUi, defaultKeyPath };
