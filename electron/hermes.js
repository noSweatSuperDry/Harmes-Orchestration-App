'use strict';
const YAML = require('yaml');
const ssh = require('./ssh-manager');

const homeCache = new Map(); // hostId -> base hermes home

/** Resolve the active Hermes home exactly the way the docs prescribe. */
async function resolveHome(hostId, override) {
  if (override) {
    const clean = override.replace(/\/+$/, '');
    if (!clean.startsWith('~')) return clean;
    const { stdout } = await ssh.exec(hostId, 'printf %s "$HOME"');
    return clean.replace(/^~/, stdout.trim());
  }
  if (homeCache.has(hostId)) return homeCache.get(hostId);
  const { stdout } = await ssh.exec(hostId, 'printf %s "${HERMES_HOME:-$HOME/.hermes}"');
  const base = stdout.trim() || '~/.hermes';
  homeCache.set(hostId, base);
  return base;
}

function forgetHome(hostId) { homeCache.delete(hostId); }

async function profileDir(hostId, profile, override) {
  const base = await resolveHome(hostId, override);
  if (!profile || profile === 'default') return base;
  return `${base}/profiles/${profile}`;
}

async function listProfiles(hostId, override) {
  const base = await resolveHome(hostId, override);
  const names = new Set(['default']);
  const entries = await ssh.listDir(hostId, `${base}/profiles`);
  for (const e of entries) if (e.dir) names.add(e.name);
  return [...names];
}

/** Everything the dashboard needs for one profile, in one round trip. */
async function loadProfile(hostId, profile, override) {
  const dir = await profileDir(hostId, profile, override);
  const [configText, envText, memory, user, soul, authJson] = await Promise.all([
    ssh.readFile(hostId, `${dir}/config.yaml`),
    ssh.readFile(hostId, `${dir}/.env`),
    ssh.readFile(hostId, `${dir}/memories/MEMORY.md`),
    ssh.readFile(hostId, `${dir}/memories/USER.md`),
    ssh.readFile(hostId, `${dir}/SOUL.md`),
    ssh.readFile(hostId, `${dir}/auth.json`)
  ]);

  let config = null;
  let configError = null;
  if (configText != null) {
    try { config = YAML.parse(configText) || {}; }
    catch (err) { configError = err.message; }
  }

  return {
    dir,
    profile: profile || 'default',
    configText,
    config,
    configError,
    envText,
    env: parseEnv(envText),
    memory,
    user,
    soul,
    auth: summarizeAuth(authJson),
    exists: configText != null || envText != null
  };
}

/* ------------------------------ config.yaml ------------------------------ */

/** Patch dotted paths in place so comments and formatting survive. */
async function patchConfig(hostId, profile, patches, override) {
  const dir = await profileDir(hostId, profile, override);
  const path = `${dir}/config.yaml`;
  const current = (await ssh.readFile(hostId, path)) ?? '';
  const doc = YAML.parseDocument(current);
  for (const [dotted, value] of Object.entries(patches)) {
    const keys = dotted.split('.');
    if (value === '' || value == null) doc.deleteIn(keys);
    else doc.setIn(keys, coerce(value));
  }
  const text = doc.toString();
  await ssh.writeFile(hostId, path, text, 0o600);
  return text;
}

async function saveConfigRaw(hostId, profile, text, override) {
  YAML.parse(text); // throws on invalid YAML before we clobber the remote file
  const dir = await profileDir(hostId, profile, override);
  await ssh.writeFile(hostId, `${dir}/config.yaml`, text, 0o600);
  return true;
}

function coerce(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && !Number.isNaN(Number(t)) && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return v;
}

/* ---------------------------------- .env --------------------------------- */

function parseEnv(text) {
  if (text == null) return [];
  return text.split('\n').map((line, i) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) return { type: 'raw', raw: line, index: i };
    return { type: 'kv', key: m[1], value: unquote(m[2]), raw: line, index: i };
  });
}

function unquote(v) {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"') && t.length > 1) ||
      (t.startsWith("'") && t.endsWith("'") && t.length > 1)) {
    return t.slice(1, -1);
  }
  return t;
}

function quote(v) {
  return /[\s#"'$`\\]/.test(v) ? `"${v.replace(/(["\\$`])/g, '\\$1')}"` : v;
}

/** entries: [{key, value, deleted?}] merged back over the original file. */
function serializeEnv(originalText, entries) {
  const lines = originalText == null ? [] : originalText.split('\n');
  const seen = new Set();

  for (const e of entries) {
    if (!e.key) continue;
    seen.add(e.key);
    const idx = lines.findIndex((l) =>
      new RegExp(`^\\s*(?:export\\s+)?${e.key}\\s*=`).test(l));
    if (e.deleted) {
      if (idx >= 0) lines.splice(idx, 1);
      continue;
    }
    const rendered = `${e.key}=${quote(e.value ?? '')}`;
    if (idx >= 0) lines[idx] = rendered;
    else lines.push(rendered);
  }

  let text = lines.join('\n');
  if (!text.endsWith('\n')) text += '\n';
  return text.replace(/\n{3,}$/, '\n');
}

async function saveEnv(hostId, profile, entries, override) {
  const dir = await profileDir(hostId, profile, override);
  const path = `${dir}/.env`;
  const original = await ssh.readFile(hostId, path);
  const text = serializeEnv(original, entries);
  await ssh.writeFile(hostId, path, text, 0o600);
  return parseEnv(text);
}

/* --------------------------------- memory -------------------------------- */

const MEMORY_FILES = {
  memory: 'memories/MEMORY.md',
  user: 'memories/USER.md',
  soul: 'SOUL.md'
};

async function saveMemory(hostId, profile, which, text, override) {
  const rel = MEMORY_FILES[which];
  if (!rel) throw new Error(`Unknown memory file: ${which}`);
  const dir = await profileDir(hostId, profile, override);
  if (rel.includes('/')) {
    await ssh.exec(hostId, `mkdir -p ${ssh.shq(`${dir}/memories`)}`);
  }
  await ssh.writeFile(hostId, `${dir}/${rel}`, text, 0o644);
  return true;
}

/* ---------------------------------- auth --------------------------------- */

function summarizeAuth(json) {
  if (json == null) return null;
  let data;
  try { data = JSON.parse(json); } catch { return { error: 'auth.json is not valid JSON' }; }
  const walk = (obj, prefix = '') => {
    const out = [];
    for (const [k, v] of Object.entries(obj || {})) {
      const label = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const expiry = v.expires_at ?? v.expiresAt ?? v.expiry ?? null;
        out.push({ name: label, kind: 'credential', expires: fmtExpiry(expiry) });
        out.push(...walk(v, label).filter((c) => c.kind !== 'credential'));
      }
    }
    return out;
  };
  return { entries: walk(data) };
}

function fmtExpiry(v) {
  if (v == null) return null;
  const ms = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

/* -------------------------------- overview ------------------------------- */

async function overview(hostId, profile, override) {
  const script = [
    'echo "___VERSION___"; timeout 10 hermes --version 2>&1 | head -3',
    'echo "___PROFILE___"; timeout 10 hermes profile 2>&1 | head -20',
    'echo "___AUTH___"; timeout 10 hermes auth list 2>&1 | head -30',
    'echo "___SYS___"; uptime 2>&1 | head -1; echo "--"; df -h / 2>/dev/null | tail -1'
  ].join('; ');
  const { stdout } = await ssh.exec(hostId, script);
  const section = (name) => {
    const m = new RegExp(`___${name}___\\n([\\s\\S]*?)(?=___[A-Z]+___|$)`).exec(stdout);
    return m ? m[1].trim() : '';
  };
  return {
    version: section('VERSION'),
    profile: section('PROFILE'),
    auth: section('AUTH'),
    system: section('SYS')
  };
}

module.exports = {
  resolveHome, forgetHome, profileDir, listProfiles, loadProfile,
  patchConfig, saveConfigRaw, saveEnv, saveMemory, overview, parseEnv
};
