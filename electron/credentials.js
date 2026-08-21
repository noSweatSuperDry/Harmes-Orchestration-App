'use strict';
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

/**
 * Passwords never touch config.json — that file is meant to be readable,
 * hand-editable and copied between machines. Secrets go here instead,
 * encrypted by the OS keychain (Keychain / DPAPI / libsecret).
 */
let filePath = null;
let cache = null;

function file() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'credentials.enc.json');
  return filePath;
}

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2), { mode: 0o600 });
}

function available() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function set(hostId, password) {
  if (!password) return remove(hostId);
  if (!available()) {
    throw new Error('OS keychain unavailable — this system cannot store the password securely');
  }
  load();
  cache[hostId] = safeStorage.encryptString(password).toString('base64');
  persist();
  return true;
}

function get(hostId) {
  load();
  const blob = cache[hostId];
  if (!blob || !available()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'));
  } catch {
    // Keychain rotated or the entry was written on another machine.
    return null;
  }
}

function has(hostId) {
  load();
  return Boolean(cache[hostId]);
}

function remove(hostId) {
  load();
  if (!(hostId in cache)) return false;
  delete cache[hostId];
  persist();
  return true;
}

module.exports = { available, set, get, has, remove };
