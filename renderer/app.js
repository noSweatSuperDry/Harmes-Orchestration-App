'use strict';
const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) node.append(k?.nodeType ? k : document.createTextNode(String(k)));
  return node;
};

const state = {
  hosts: [],
  selectedId: null,
  profile: 'default',
  profiles: ['default'],
  tab: 'overview',
  statuses: {},          // hostId -> { status, error }
  data: null,            // loaded hermes profile bundle
  overview: null,
  memoryTab: 'memory',
  agents: {},          // hostId -> { state, cpu, procs, oldest }
  termActivity: {},    // hostId -> ms of last PTY output
  telemetry: null,
  autoRefresh: true,
  motion: 'always'
};

let telemetryTimer = null;
let pulseTimer = null;
let telemetryBusy = false;

const terminals = new Map(); // hostId -> { term, fit, wrap, termId, live }

/* --------------------------------- boot ---------------------------------- */

init();

async function init() {
  const ui = unwrap(await window.api.ui.get()) || {};
  state.hosts = unwrap(await window.api.hosts.list()) || [];
  state.tab = ui.lastTab || 'overview';
  state.motion = ui.motion || 'always';
  applyMotion();

  wireChrome();
  wireEvents();
  renderMotionControl();
  renderSidebar();

  const remembered = state.hosts.find((h) => h.id === ui.lastHostId);
  if (remembered) selectHost(remembered.id);
  else if (state.hosts.length) selectHost(state.hosts[0].id);
  else renderShellState();

  syncPolling();
}

const asError = (res) => Object.assign(new Error(res.error), {
  needsPassphrase: res.needsPassphrase,
  needsPassword: res.needsPassword
});

function unwrap(res) {
  if (!res) return null;
  if (res.ok) return res.data;
  throw asError(res);
}

async function call(fn, ...args) {
  const res = await fn(...args);
  if (res && res.ok === false) throw asError(res);
  return res ? res.data : null;
}

/* ------------------------------- chrome ---------------------------------- */

function wireChrome() {
  $('#add-host').onclick = () => openHostModal(null);
  $('#add-host-empty').onclick = () => openHostModal(null);
  $('#connect-btn').onclick = onConnectClick;
  $('#reload-btn').onclick = () => loadHostData({ force: true });

  $('#profile-select').onchange = (e) => {
    state.profile = e.target.value;
    loadHostData({ force: true });
  };

  for (const tab of document.querySelectorAll('.tab')) {
    tab.onclick = () => setTab(tab.dataset.tab);
  }

  $('#host-cancel').onclick = closeHostModal;
  $('#host-form').onsubmit = onHostSubmit;
  $('#host-delete').onclick = onHostDelete;
  $('#pass-cancel').onclick = () => { $('#pass-modal').hidden = true; };
  $('#settings-close').onclick = closeSettings;

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeHostModal(); closeSettings(); $('#pass-modal').hidden = true; }
  });

  window.addEventListener('resize', () => fitActiveTerminal());

  $('#term-restart').onclick = () => restartTerminal();
  for (const btn of document.querySelectorAll('[data-send]')) {
    btn.onclick = () => sendToTerminal(btn.dataset.send);
  }
}

function wireEvents() {
  window.api.ssh.onStatus(({ hostId, status, error }) => {
    state.statuses[hostId] = { status, error };
    renderSidebar();
    syncPolling();
    if (hostId === state.selectedId) {
      renderTopbar();
      if (status === 'disconnected' || status === 'error') {
        state.data = null;
        state.overview = null;
        state.telemetry = null;
        delete state.agents[hostId];
        renderActiveTab();
        dropTerminal(hostId);
      }
    }
  });

  window.api.term.onData(({ hostId, data }) => {
    state.termActivity[hostId] = Date.now();
    const t = terminals.get(hostId);
    if (t) t.term.write(data);
    paintAgents();
  });

  window.api.term.onExit(({ hostId }) => {
    const t = terminals.get(hostId);
    if (t) { t.live = false; t.term.writeln('\r\n\x1b[90m[shell closed]\x1b[0m'); }
    if (hostId === state.selectedId) renderTermStatus();
  });
}

/* ------------------------------- sidebar --------------------------------- */

function renderSidebar() {
  const list = $('#host-list');
  list.textContent = '';
  for (const host of state.hosts) {
    const st = state.statuses[host.id]?.status || 'disconnected';
    const item = el('div', { className: `host-item${host.id === state.selectedId ? ' active' : ''}` },
      el('span', { className: `dot ${st}`, title: st }),
      el('div', { className: 'meta' },
        el('div', { className: 'name' }, host.label || host.hostname),
        el('div', { className: 'addr' }, `${host.username}@${host.hostname}`)),
      agentAvatar(agentStateFor(host.id).state, 20),
      el('button', { className: 'edit', title: 'Edit host', textContent: '⚙' }));
    item.onclick = () => selectHost(host.id);
    item.querySelector('.edit').onclick = (e) => { e.stopPropagation(); openHostModal(host); };
    list.append(item);
  }
}

async function selectHost(id) {
  state.selectedId = id;
  state.data = null;
  state.overview = null;
  const host = currentHost();
  state.profile = host?.defaultProfile || 'default';
  state.profiles = [state.profile];
  window.api.ui.set({ lastHostId: id });

  state.telemetry = null;
  renderSidebar();
  renderShellState();
  renderTopbar();

  const st = await call(window.api.ssh.status, id).catch(() => null);
  if (st) state.statuses[id] = st;
  renderTopbar();
  renderSidebar();

  paintAgents();
  syncPolling();
  if (state.statuses[id]?.status === 'connected') await loadHostData({ force: true });
  else renderActiveTab();
}

function currentHost() {
  return state.hosts.find((h) => h.id === state.selectedId) || null;
}

function currentStatus() {
  return state.statuses[state.selectedId]?.status || 'disconnected';
}

/* -------------------------------- topbar --------------------------------- */

function renderShellState() {
  const has = !!currentHost();
  $('#empty-state').hidden = has;
  $('#tabs').hidden = !has;
  $('#connect-btn').hidden = !has;
  $('#reload-btn').hidden = !has;
  $('#profile-wrap').hidden = !has;
  if (!has) for (const p of document.querySelectorAll('.pane')) p.hidden = true;
}

function renderTopbar() {
  const host = currentHost();
  if (!host) {
    $('#host-title').textContent = 'No host selected';
    $('#host-sub').textContent = '';
    return;
  }
  const st = currentStatus();
  const err = state.statuses[host.id]?.error;
  $('#host-title').textContent = host.label || host.hostname;
  $('#host-sub').textContent = st === 'error' && err
    ? `${host.username}@${host.hostname} — ${err}`
    : `${host.username}@${host.hostname}:${host.port} · ${st}`;

  const slot = $('#topbar-agent');
  slot.textContent = '';
  slot.append(agentAvatar(agentStateFor(host.id).state, 30));

  const btn = $('#connect-btn');
  btn.textContent = st === 'connected' ? 'Disconnect' : st === 'connecting' ? 'Connecting…' : 'Connect';
  btn.className = st === 'connected' ? 'btn ghost' : 'btn';
  btn.disabled = st === 'connecting';
  $('#reload-btn').disabled = st !== 'connected';

  const sel = $('#profile-select');
  sel.textContent = '';
  for (const p of state.profiles) sel.append(el('option', { value: p, textContent: p }));
  sel.value = state.profile;
  sel.disabled = st !== 'connected';
}

async function onConnectClick(secret) {
  const host = currentHost();
  if (!host) return;
  if (currentStatus() === 'connected') {
    await call(window.api.ssh.disconnect, host.id);
    return;
  }
  const typed = typeof secret === 'string' ? secret : undefined;
  try {
    const info = await call(window.api.ssh.connect, host.id, typed);
    if (typed && host.auth === 'password' && host.savePassword) {
      // The keychain entry was missing or stale — refresh it now that one works.
      call(window.api.creds.set, host.id, typed).catch(() => {});
    }
    state.profiles = info.profiles.length ? info.profiles : ['default'];
    if (!state.profiles.includes(state.profile)) state.profile = state.profiles[0];
    renderTopbar();
    toast(`Connected · Hermes home ${info.home}`, 'ok');
    await loadHostData({ force: true });
  } catch (err) {
    if (err.needsPassphrase) return askSecret('passphrase', err.message);
    if (err.needsPassword) return askSecret('password', err.message);
    toast(err.message, 'err');
  }
}

function askSecret(kind, message) {
  const isPassword = kind === 'password';
  const host = currentHost();
  const modal = $('#pass-modal');
  const hint = $('#pass-hint');

  $('#pass-title').textContent = isPassword ? 'SSH password' : 'Key passphrase';
  $('#pass-label').textContent = isPassword ? `Password for ${host?.username}@${host?.hostname}` : 'Passphrase';
  hint.textContent = isPassword
    ? (message && !/^Password required$/i.test(message) ? message : 'This host authenticates with a password.')
    : (message || 'This key is encrypted.');
  const rejected = message && /(did not unlock|rejected)/i.test(message);
  hint.className = rejected ? 'badge err' : 'muted sm';
  modal.hidden = false;
  const form = $('#pass-form');
  form.passphrase.value = '';
  form.passphrase.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const pass = form.passphrase.value;
    form.passphrase.value = '';
    modal.hidden = true;
    await onConnectClick(pass);
  };
}

/* -------------------------------- loading -------------------------------- */

async function loadHostData() {
  const host = currentHost();
  if (!host || currentStatus() !== 'connected') return;
  try {
    state.data = await call(window.api.hermes.load, host.id, state.profile);
    state.profiles = await call(window.api.hermes.profiles, host.id);
    if (!state.profiles.includes(state.profile)) state.profiles.unshift(state.profile);
    renderTopbar();
    renderActiveTab();
    if (state.tab === 'overview') refreshOverview();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function refreshOverview() {
  const host = currentHost();
  if (!host || currentStatus() !== 'connected') return;
  try {
    state.overview = await call(window.api.hermes.overview, host.id, state.profile);
    if (state.tab === 'overview') renderOverview();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ---------------------------------- tabs --------------------------------- */

function setTab(tab) {
  state.tab = tab;
  window.api.ui.set({ lastTab: tab });
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === tab);
  renderActiveTab();
  syncPolling();
}

function renderActiveTab() {
  for (const pane of document.querySelectorAll('.pane')) {
    pane.hidden = pane.id !== `pane-${state.tab}`;
  }
  if (!currentHost()) return;
  switch (state.tab) {
    case 'overview': renderOverview(); if (!state.overview) refreshOverview(); break;
    case 'telemetry': renderTelemetry(); refreshTelemetry(); break;
    case 'model': renderModel(); break;
    case 'keys': renderKeys(); break;
    case 'memory': renderMemory(); break;
    case 'config': renderConfig(); break;
    case 'terminal': renderTerminal(); break;
  }
}

function notConnected(pane) {
  pane.textContent = '';
  pane.append(el('div', { className: 'card' },
    el('h3', {}, 'Not connected'),
    el('p', { className: 'muted', style: 'margin:0 0 12px' },
      'Connect to this host to read and edit its Hermes profile.'),
    (() => { const b = el('button', { className: 'btn', textContent: 'Connect' }); b.onclick = () => onConnectClick(); return b; })()));
}

/* ------------------------------- overview -------------------------------- */

function renderOverview() {
  const pane = $('#pane-overview');
  if (currentStatus() !== 'connected') return notConnected(pane);
  pane.textContent = '';

  const d = state.data;
  const o = state.overview;

  const activity = el('div', { className: 'card' });
  const block = agentBlock(state.selectedId, 52);
  block.dataset.agentBlock = '52';
  activity.append(block);
  pane.append(activity);

  const summary = el('div', { className: 'card' });
  summary.append(el('div', { className: 'card-head' },
    el('h3', {}, 'Profile ', el('span', { className: 'muted' }, `· ${state.profile}`)),
    el('span', { className: `badge ${d?.exists ? 'ok' : 'err'}` }, d?.exists ? 'found' : 'not found')));
  const rows = [
    ['Hermes home', d?.dir || '—'],
    ['Model', pick(d?.config, 'model.default') || '—'],
    ['Provider', pick(d?.config, 'model.provider') || '—'],
    ['API keys in .env', String((d?.env || []).filter((e) => e.type === 'kv').length)],
    ['MEMORY.md', d?.memory == null ? 'missing' : `${d.memory.length} chars`],
    ['USER.md', d?.user == null ? 'missing' : `${d.user.length} chars`]
  ];
  const table = el('table', { className: 'kv' });
  for (const [k, v] of rows) {
    table.append(el('tr', {}, el('td', { className: 'muted', style: 'width:150px' }, k), el('td', {}, v)));
  }
  summary.append(table);
  pane.append(summary);

  pane.append(outCard('hermes profile', o?.profile, !o));
  pane.append(outCard('hermes auth list', o?.auth, !o));
  pane.append(outCard('System', [o?.version, o?.system].filter(Boolean).join('\n'), !o));

  const refresh = el('button', { className: 'btn ghost sm', textContent: 'Refresh probes' });
  refresh.onclick = () => { state.overview = null; renderOverview(); refreshOverview(); };
  pane.append(refresh);
}

function outCard(title, body, loading) {
  return el('div', { className: 'card' },
    el('h3', {}, title),
    el('pre', { className: 'out' }, loading ? 'running…' : (body || '(no output)')));
}

function pick(obj, dotted) {
  return dotted.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

/* --------------------------------- model --------------------------------- */

function renderModel() {
  const pane = $('#pane-model');
  if (currentStatus() !== 'connected') return notConnected(pane);
  pane.textContent = '';
  const d = state.data;

  if (!d || d.configText == null) {
    pane.append(el('div', { className: 'card' }, el('h3', {}, 'config.yaml not found'),
      el('p', { className: 'muted' }, `Looked in ${d?.dir || '?'}/config.yaml`)));
    return;
  }
  if (d.configError) {
    pane.append(el('div', { className: 'card' }, el('h3', {}, 'config.yaml could not be parsed'),
      el('pre', { className: 'out' }, d.configError),
      el('p', { className: 'muted sm' }, 'Fix it under the “Raw config” tab.')));
    return;
  }

  const pending = {};
  const flat = flatten(d.config);

  const primary = el('div', { className: 'card' }, el('h3', {}, 'Model & provider'));
  for (const key of ['model.default', 'model.provider']) {
    primary.append(fieldFor(key, flat[key] ?? '', pending));
  }
  pane.append(primary);

  const rest = Object.keys(flat).filter((k) => !k.startsWith('model.')).sort();
  if (rest.length) {
    const other = el('div', { className: 'card' },
      el('h3', {}, 'All other settings ', el('span', { className: 'muted' }, `· ${rest.length} keys`)));
    const table = el('table', { className: 'kv cfg' });
    table.append(el('tr', {}, el('th', { className: 'k' }, 'Key'), el('th', {}, 'Value')));
    for (const key of rest) table.append(configRow(key, flat[key], pending));
    other.append(table);
    pane.append(other);
  }

  const extraKeys = Object.keys(flat).filter((k) => k.startsWith('model.') && !['model.default', 'model.provider'].includes(k));
  if (extraKeys.length) {
    const more = el('div', { className: 'card' }, el('h3', {}, 'Other model settings'));
    const table = el('table', { className: 'kv cfg' });
    for (const key of extraKeys.sort()) table.append(configRow(key, flat[key], pending));
    more.append(table);
    pane.append(more);
  }

  const save = el('button', { className: 'btn', textContent: 'Save changes', disabled: true });
  save.onclick = async () => {
    save.disabled = true;
    try {
      await call(window.api.hermes.patchConfig, state.selectedId, state.profile, pending);
      toast('config.yaml updated', 'ok');
      await loadHostData();
      refreshOverview();
    } catch (err) {
      toast(err.message, 'err');
      save.disabled = false;
    }
  };
  pane.append(el('div', { className: 'row' }, save,
    el('span', { className: 'muted sm', style: 'align-self:center' },
      'Comments and formatting in config.yaml are preserved.')));
  pane.oninput = () => { save.disabled = Object.keys(pending).length === 0; };
  growAll(pane);
}

function fieldFor(key, value, pending) {
  const input = el('input', { value: value == null ? '' : String(value) });
  input.oninput = () => { pending[key] = input.value; };
  return el('label', { className: 'field' }, el('span', {}, key), input);
}

function configRow(key, value, pending) {
  const isScalar = value === null || ['string', 'number', 'boolean'].includes(typeof value);
  const cell = el('td');
  if (isScalar) {
    const ta = el('textarea', {
      className: 'cfg-val', rows: 1, spellcheck: false,
      value: value == null ? '' : String(value)
    });
    ta.oninput = () => { pending[key] = ta.value; autoGrow(ta); };
    cell.append(ta);
  } else {
    cell.append(el('div', { className: 'readonly-val', title: JSON.stringify(value) }, JSON.stringify(value)));
  }
  return el('tr', {}, el('td', { className: 'muted k' }, key), cell);
}

/** Height follows content, but the user can still drag to resize. */
function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(260, Math.max(32, ta.scrollHeight + 2))}px`;
}

function growAll(root) {
  requestAnimationFrame(() => {
    for (const ta of root.querySelectorAll('textarea.cfg-val')) autoGrow(ta);
  });
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

/* --------------------------------- keys ---------------------------------- */

function renderKeys() {
  const pane = $('#pane-keys');
  if (currentStatus() !== 'connected') return notConnected(pane);
  pane.textContent = '';
  const d = state.data;

  const entries = (d?.env || []).filter((e) => e.type === 'kv').map((e) => ({ key: e.key, value: e.value, deleted: false }));
  const card = el('div', { className: 'card' });
  card.append(el('div', { className: 'card-head' },
    el('h3', {}, '.env ', el('span', { className: 'muted' }, `· ${d?.dir || ''}/.env`)),
    el('span', { className: 'badge' }, 'chmod 600')));

  const table = el('table', { className: 'kv actions' });
  table.append(el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Value'), el('th', {})));
  const body = el('tbody');
  table.append(body);
  card.append(table);

  const markDirty = () => { save.disabled = false; };

  const addRow = (entry) => {
    const keyInput = el('input', { value: entry.key });
    const valInput = el('input', { value: entry.value, type: 'password' });
    keyInput.oninput = () => { entry.key = keyInput.value.trim(); markDirty(); };
    valInput.oninput = () => { entry.value = valInput.value; markDirty(); };

    const eye = el('button', { className: 'icon-btn', textContent: '👁', title: 'Reveal' });
    eye.onclick = () => { valInput.type = valInput.type === 'password' ? 'text' : 'password'; };

    const del = el('button', { className: 'icon-btn', textContent: '✕', title: 'Delete' });
    const row = el('tr', {}, el('td', {}, keyInput), el('td', {}, valInput),
      el('td', {}, eye, del));
    del.onclick = () => {
      entry.deleted = !entry.deleted;
      row.classList.toggle('deleted', entry.deleted);
      del.textContent = entry.deleted ? '↺' : '✕';
      markDirty();
    };
    body.append(row);
  };

  for (const entry of entries) addRow(entry);
  pane.append(card);

  const add = el('button', { className: 'btn ghost sm', textContent: '+ Add key' });
  add.onclick = () => {
    const entry = { key: '', value: '', deleted: false };
    entries.push(entry);
    addRow(entry);
  };

  const save = el('button', { className: 'btn', textContent: 'Save .env', disabled: true });
  save.onclick = async () => {
    save.disabled = true;
    try {
      await call(window.api.hermes.saveEnv, state.selectedId, state.profile,
        entries.map(({ key, value, deleted }) => ({ key, value, deleted })));
      toast('.env written (mode 600)', 'ok');
      await loadHostData();
      renderKeys();
    } catch (err) {
      toast(err.message, 'err');
      save.disabled = false;
    }
  };

  pane.append(el('div', { className: 'row' }, add, el('span', { className: 'grow' }), save));

  if (d?.auth?.entries?.length) {
    const auth = el('div', { className: 'card', style: 'margin-top:14px' },
      el('h3', {}, 'auth.json ', el('span', { className: 'muted' }, '· OAuth credentials (read-only)')));
    const t = el('table', { className: 'kv' });
    t.append(el('tr', {}, el('th', {}, 'Credential'), el('th', {}, 'Expires')));
    for (const c of d.auth.entries) {
      t.append(el('tr', {}, el('td', {}, c.name), el('td', { className: 'muted' }, c.expires || '—')));
    }
    auth.append(t);
    pane.append(auth);
  }
}

/* -------------------------------- memory --------------------------------- */

const MEMORY_TABS = [
  ['memory', 'MEMORY.md', 'Environment facts and learned conventions'],
  ['user', 'USER.md', 'Your preferences, identity, communication style'],
  ['soul', 'SOUL.md', 'Agent personality']
];

function renderMemory() {
  const pane = $('#pane-memory');
  if (currentStatus() !== 'connected') return notConnected(pane);
  pane.textContent = '';
  const d = state.data;

  const subtabs = el('div', { className: 'subtabs' });
  for (const [id, label] of MEMORY_TABS) {
    const b = el('button', { textContent: label, className: state.memoryTab === id ? 'active' : '' });
    b.onclick = () => { state.memoryTab = id; renderMemory(); };
    subtabs.append(b);
  }
  pane.append(subtabs);

  const [, label, hint] = MEMORY_TABS.find(([id]) => id === state.memoryTab);
  const value = d?.[state.memoryTab];

  const area = el('textarea', { value: value ?? '', rows: 22, spellcheck: false });
  const save = el('button', { className: 'btn', textContent: `Save ${label}`, disabled: true });
  area.oninput = () => { save.disabled = false; };
  save.onclick = async () => {
    save.disabled = true;
    try {
      await call(window.api.hermes.saveMemory, state.selectedId, state.profile, state.memoryTab, area.value);
      toast(`${label} saved`, 'ok');
      await loadHostData();
    } catch (err) {
      toast(err.message, 'err');
      save.disabled = false;
    }
  };

  const card = el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('h3', {}, label, ' ', el('span', { className: 'muted' }, `· ${hint}`)),
      el('span', { className: `badge ${value == null ? 'err' : 'ok'}` }, value == null ? 'not created' : 'on disk')),
    area);
  pane.append(card);
  pane.append(el('div', { className: 'row' }, save,
    el('span', { className: 'muted sm', style: 'align-self:center' },
      'Hermes snapshots memory at session start — restart the session to pick this up.')));
}

/* ------------------------------ raw config ------------------------------- */

function renderConfig() {
  const pane = $('#pane-config');
  if (currentStatus() !== 'connected') return notConnected(pane);
  pane.textContent = '';
  const d = state.data;

  const area = el('textarea', { value: d?.configText ?? '', rows: 26, spellcheck: false });
  const save = el('button', { className: 'btn', textContent: 'Save config.yaml', disabled: true });
  area.oninput = () => { save.disabled = false; };
  save.onclick = async () => {
    save.disabled = true;
    try {
      await call(window.api.hermes.saveConfigRaw, state.selectedId, state.profile, area.value);
      toast('config.yaml saved', 'ok');
      await loadHostData();
    } catch (err) {
      toast(`Not saved — ${err.message}`, 'err');
      save.disabled = false;
    }
  };

  pane.append(el('div', { className: 'card' },
    el('div', { className: 'card-head' },
      el('h3', {}, 'config.yaml'),
      el('span', { className: 'muted sm' }, `${d?.dir || ''}/config.yaml`)),
    area));
  pane.append(el('div', { className: 'row' }, save,
    el('span', { className: 'muted sm', style: 'align-self:center' }, 'Validated as YAML before writing.')));
}

/* ------------------------------- terminal -------------------------------- */

function renderTerminal() {
  const pane = $('#pane-terminal');
  const hosts = $('#term-hosts');
  if (currentStatus() !== 'connected') {
    for (const w of hosts.children) w.hidden = true;
    renderTermStatus('not connected');
    return;
  }
  const hostId = state.selectedId;
  for (const w of hosts.children) w.hidden = w.dataset.host !== hostId;

  let t = terminals.get(hostId);
  if (!t) t = createTerminal(hostId);
  t.wrap.hidden = false;
  requestAnimationFrame(() => { fitActiveTerminal(); t.term.focus(); });
  renderTermStatus();
  void pane;
}

function createTerminal(hostId) {
  const wrap = el('div', { className: 'term-host' });
  wrap.dataset.host = hostId;
  $('#term-hosts').append(wrap);

  const term = new window.Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12.5,
    cursorBlink: true,
    theme: { background: '#0b0d12', foreground: '#d6dbe6', cursor: '#6ea8fe', selectionBackground: '#2b3550' }
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(wrap);

  const termId = `t-${hostId}`;
  term.onData((data) => window.api.term.write(hostId, termId, data));
  term.onResize(({ cols, rows }) => window.api.term.resize(hostId, termId, cols, rows));

  const entry = { term, fit, wrap, termId, live: false };
  terminals.set(hostId, entry);

  call(window.api.term.open, hostId, termId, { cols: term.cols || 100, rows: term.rows || 30 })
    .then(() => { entry.live = true; renderTermStatus(); })
    .catch((err) => { term.writeln(`\x1b[31m${err.message}\x1b[0m`); });

  return entry;
}

function fitActiveTerminal() {
  if (state.tab !== 'terminal') return;
  const t = terminals.get(state.selectedId);
  if (!t || t.wrap.hidden) return;
  try { t.fit.fit(); } catch {}
}

function dropTerminal(hostId) {
  const t = terminals.get(hostId);
  if (!t) return;
  t.term.dispose();
  t.wrap.remove();
  terminals.delete(hostId);
}

function renderTermStatus(text) {
  const t = terminals.get(state.selectedId);
  $('#term-status').textContent = text || (t?.live ? `shell open · ${currentHost()?.username}@${currentHost()?.hostname}` : 'no shell');
}

function sendToTerminal(what) {
  const t = terminals.get(state.selectedId);
  if (!t || !t.live) return;
  const line = what === 'clear' ? 'clear' : what;
  window.api.term.write(state.selectedId, t.termId, `${line}\n`);
  t.term.focus();
}

async function restartTerminal() {
  const hostId = state.selectedId;
  const t = terminals.get(hostId);
  if (t) { await call(window.api.term.close, hostId, t.termId).catch(() => {}); dropTerminal(hostId); }
  renderTerminal();
}

/* ------------------------------ host modal ------------------------------- */

function openHostModal(host) {
  const form = $('#host-form');
  form.reset();
  $('#host-modal-title').textContent = host ? 'Edit host' : 'Add host';
  $('#host-delete').hidden = !host;
  form.hostId.value = host?.id || '';
  form.label.value = host?.label || '';
  form.hostname.value = host?.hostname || '';
  form.password.value = '';
  form.savePassword.checked = host?.savePassword ?? true;
  form.auth.value = host?.auth || 'key';
  form.auth.onchange = () => toggleAuthFields(form.auth.value);
  toggleAuthFields(form.auth.value);

  call(window.api.settings.getDefaults).then((d) => {
    form.port.value = host?.port || d.port || 22;
    form.username.value = host?.username || d.username || '';
    form.defaultProfile.value = host?.defaultProfile || d.profile || 'default';
    form.hermesHome.value = host?.hermesHome || d.hermesHome || '';
    form.privateKeyPath.value = host?.privateKeyPath || d.privateKeyPath || '';
    if (!host) {
      form.auth.value = d.auth || 'key';
      toggleAuthFields(form.auth.value);
    }
  }).catch(() => {});

  describeKeychain(host);
  $('#host-modal').hidden = false;
  form.hostname.focus();
}

function toggleAuthFields(mode) {
  $('#auth-key').hidden = mode !== 'key';
  $('#auth-password').hidden = mode !== 'password';
}

/** Say plainly where a password would go, and whether one is already stored. */
async function describeKeychain(host) {
  const note = $('#keychain-note');
  note.textContent = 'Checking OS keychain…';
  note.style.color = 'var(--muted)';
  try {
    const available = await call(window.api.creds.available);
    if (!available) {
      note.style.color = 'var(--warn)';
      note.textContent = 'No OS keychain available here — the password cannot be saved, so you will be asked for it on every connect.';
      $('#host-form').savePassword.checked = false;
      $('#host-form').savePassword.disabled = true;
      return;
    }
    $('#host-form').savePassword.disabled = false;
    const stored = host ? await call(window.api.creds.has, host.id) : false;
    note.textContent = stored
      ? 'A password is already saved for this host. Leave the field blank to keep it.'
      : 'Encrypted by your OS keychain, never written to config.json. Leave unchecked to be asked on every connect.';
  } catch (err) {
    note.textContent = err.message;
  }
}

function closeHostModal() { $('#host-modal').hidden = true; }

async function onHostSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.id = payload.hostId || undefined;
  delete payload.hostId;

  // The password is never part of the host record — pull it out before saving.
  const password = payload.password || '';
  delete payload.password;
  payload.savePassword = form.savePassword.checked;

  try {
    const saved = await call(window.api.hosts.save, payload);
    if (saved.auth === 'password') {
      if (saved.savePassword && password) await call(window.api.creds.set, saved.id, password);
      else if (!saved.savePassword) await call(window.api.creds.remove, saved.id);
    } else {
      await call(window.api.creds.remove, saved.id);
    }
    state.hosts = await call(window.api.hosts.list);
    closeHostModal();
    renderSidebar();
    renderShellState();
    selectHost(saved.id);
    toast('Host saved', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function onHostDelete() {
  const id = $('#host-form').hostId.value;
  if (!id) return;
  await call(window.api.hosts.remove, id);
  dropTerminal(id);
  state.hosts = await call(window.api.hosts.list);
  closeHostModal();
  state.selectedId = null;
  state.data = null;
  renderSidebar();
  renderShellState();
  renderTopbar();
  if (state.hosts.length) selectHost(state.hosts[0].id);
  toast('Host removed', 'ok');
}

/* -------------------------------- toasts --------------------------------- */

function toast(message, kind = '') {
  const node = el('div', { className: `toast ${kind}` }, message);
  $('#toasts').append(node);
  setTimeout(() => node.remove(), 4200);
}

/* -------------------------------- motion --------------------------------- */

/** 'always' | 'off' | 'system' — system defers to prefers-reduced-motion. */
function motionEnabled() {
  if (state.motion === 'always') return true;
  if (state.motion === 'off') return false;
  return !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function applyMotion() {
  document.documentElement.dataset.motion = motionEnabled() ? 'on' : 'off';
}

function setMotion(mode) {
  state.motion = mode;
  window.api.ui.set({ motion: mode });
  applyMotion();
  renderMotionControl();
}

function renderMotionControl() {
  const foot = $('#sidebar-foot');
  if (!foot) return;
  foot.textContent = '';
  const btn = el('button', { className: 'btn ghost sm', textContent: '⚙  Settings' });
  btn.onclick = openSettings;
  foot.append(btn);
}

/* ============================ agent activity ============================== */

const AGENT_LABEL = {
  offline:  ['Offline',  'not connected'],
  asleep:   ['Sleeping', 'no hermes process running'],
  idle:     ['Idle',     'process up, waiting for input'],
  thinking: ['Thinking', 'light CPU activity'],
  working:  ['Working',  'heavy CPU or streaming output']
};

const AVATAR_SVG = `
  <circle class="halo" cx="24" cy="24" r="14"/>
  <circle class="ring" cx="24" cy="24" r="20"/>
  <path    class="arc" d="M24 6 A18 18 0 0 1 42 24"/>
  <circle class="core" cx="24" cy="24" r="8"/>
  <g class="dots">
    <circle class="dot" cx="14" cy="24" r="3.2"/>
    <circle class="dot" cx="24" cy="24" r="3.2"/>
    <circle class="dot" cx="34" cy="24" r="3.2"/>
  </g>
  <g class="zzz"><text x="30" y="15">z</text><text x="37" y="8">z</text></g>`;

function agentAvatar(agentState, size = 40) {
  const wrap = el('span', { className: 'agent', title: AGENT_LABEL[agentState]?.[0] || agentState });
  wrap.dataset.state = agentState;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.innerHTML = AVATAR_SVG;
  wrap.append(svg);
  return wrap;
}

/** Terminal output wins: if bytes are streaming, the agent is demonstrably busy. */
function agentStateFor(hostId) {
  if ((state.statuses[hostId]?.status) !== 'connected') return { state: 'offline' };
  if (Date.now() - (state.termActivity[hostId] || 0) < 2500) {
    return { ...(state.agents[hostId] || {}), state: 'working', viaTerminal: true };
  }
  return state.agents[hostId] || { state: 'offline', pending: true };
}

function agentDetail(info) {
  if (info.viaTerminal) return 'streaming output to the terminal';
  if (info.pending) return 'checking…';
  const base = AGENT_LABEL[info.state]?.[1] || '';
  if (info.state === 'asleep' || info.state === 'offline') return base;
  const bits = [];
  if (info.cpu != null) bits.push(`${info.cpu}% CPU`);
  if (info.procs) bits.push(`${info.procs} process${info.procs > 1 ? 'es' : ''}`);
  if (info.oldest) bits.push(`up ${fmtDuration(info.oldest)}`);
  return bits.join(' · ') || base;
}

function agentBlock(hostId, size = 52) {
  const info = agentStateFor(hostId);
  const [label] = AGENT_LABEL[info.state] || ['Unknown'];
  return el('div', { className: 'agent-block' },
    agentAvatar(info.state, size),
    el('div', {},
      el('div', { className: 'label' }, info.pending ? 'Checking…' : label),
      el('div', { className: 'detail' }, agentDetail(info))));
}

/** Repaint just the avatars — never re-render panes holding user input. */
function paintAgents() {
  renderSidebar();
  const slot = $('#topbar-agent');
  if (slot && currentHost()) {
    slot.textContent = '';
    slot.append(agentAvatar(agentStateFor(state.selectedId).state, 30));
  }
  for (const node of document.querySelectorAll('[data-agent-block]')) {
    const fresh = agentBlock(state.selectedId, Number(node.dataset.agentBlock) || 52);
    fresh.dataset.agentBlock = node.dataset.agentBlock;
    node.replaceWith(fresh);
  }
}

/* ------------------------------- polling --------------------------------- */

function syncPolling() {
  clearInterval(pulseTimer);
  clearInterval(telemetryTimer);

  const anyConnected = state.hosts.some((h) => state.statuses[h.id]?.status === 'connected');
  if (anyConnected) {
    pulseTimer = setInterval(pollPulses, 4000);
    pollPulses();
  }
  if (state.tab === 'telemetry' && state.autoRefresh && currentStatus() === 'connected') {
    telemetryTimer = setInterval(() => refreshTelemetry(), 5000);
  }
}

async function pollPulses() {
  const connected = state.hosts.filter((h) => state.statuses[h.id]?.status === 'connected');
  await Promise.all(connected.map(async (h) => {
    try { state.agents[h.id] = await call(window.api.telemetry.pulse, h.id); }
    catch { delete state.agents[h.id]; }
  }));
  paintAgents();
}

async function refreshTelemetry() {
  if (telemetryBusy || currentStatus() !== 'connected') return;
  telemetryBusy = true;
  const hostId = state.selectedId;
  try {
    const data = await call(window.api.telemetry.collect, hostId);
    if (hostId !== state.selectedId) return;
    state.telemetry = data;
    if (data.hermes) state.agents[hostId] = { ...(state.agents[hostId] || {}), ...deriveFromHermes(data.hermes) };
    if (state.tab === 'telemetry') renderTelemetry();
  } catch (err) {
    if (state.tab === 'telemetry') toast(err.message, 'err');
  } finally {
    telemetryBusy = false;
  }
}

function deriveFromHermes(procs) {
  if (!procs.length) return { state: 'asleep', cpu: 0, procs: 0, oldest: 0 };
  const cpu = Math.round(procs.reduce((a, p) => a + p.cpu, 0) * 10) / 10;
  const oldest = Math.max(...procs.map((p) => p.etimeSeconds || 0));
  return { state: cpu >= 15 ? 'working' : cpu >= 1.5 ? 'thinking' : 'idle', cpu, procs: procs.length, oldest };
}

/* ============================== formatting =============================== */

function fmtBytes(b, digits = 1) {
  if (!b || b < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i ? digits : 0)} ${u[i]}`;
}
const fmtRate = (b) => `${fmtBytes(b)}/s`;

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
}

function meter(name, percent, valueText) {
  const pct = Math.max(0, Math.min(100, percent || 0));
  const cls = pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : '';
  return el('div', { className: 'meter' },
    el('div', { className: 'meter-top' },
      el('span', { className: 'm-name' }, name),
      el('span', { className: 'm-val' }, valueText)),
    el('div', { className: 'meter-track' },
      el('div', { className: `meter-fill ${cls}`, style: `width:${pct}%` })));
}

const stat = (k, v) => el('div', { className: 'stat' }, el('div', { className: 'v' }, v), el('div', { className: 'k' }, k));

function dataTable(headers, rows) {
  const t = el('table', { className: 'data' });
  t.append(el('tr', {}, headers.map((h) => el('th', {}, h))));
  for (const r of rows) {
    t.append(el('tr', {}, r.map((cell) => {
      const c = typeof cell === 'object' && cell !== null ? cell : { text: cell };
      return el('td', { className: c.cls || '' }, String(c.text ?? ''));
    })));
  }
  return t;
}

const card = (title, ...body) => el('div', { className: 'card' }, title ? el('h3', {}, title) : '', ...body);

/* ============================== telemetry UI ============================= */

function renderTelemetry() {
  const pane = $('#pane-telemetry');
  if (currentStatus() !== 'connected') return notConnected(pane);

  const content = $('#content');
  const scroll = content.scrollTop;
  pane.textContent = '';
  const t = state.telemetry;

  const block = agentBlock(state.selectedId, 52);
  block.dataset.agentBlock = '52';

  const auto = el('label', { className: 'field-inline' },
    (() => {
      const cb = el('input', { type: 'checkbox', checked: state.autoRefresh, style: 'width:auto' });
      cb.onchange = () => { state.autoRefresh = cb.checked; syncPolling(); };
      return cb;
    })(),
    el('span', {}, 'Auto-refresh 5s'));

  const now = el('button', { className: 'btn ghost sm', textContent: 'Refresh now' });
  now.onclick = () => refreshTelemetry();

  pane.append(el('div', { className: 'tel-head' }, block,
    el('div', { className: 'tel-actions' },
      t ? el('span', { className: 'muted sm' },
        state.autoRefresh ? el('span', { className: 'dot-live' }) : '', ' ',
        `updated ${new Date(t.at).toLocaleTimeString()}`) : '',
      auto, now)));

  if (!t) {
    pane.append(card('Collecting telemetry…', el('p', { className: 'muted' }, 'One SSH round trip, sampling CPU and network over 600ms.')));
    content.scrollTop = scroll;
    return;
  }

  /* system + load */
  pane.append(card('System',
    el('div', { className: 'stat-row' },
      stat('Uptime', fmtDuration(t.uptimeSeconds)),
      stat('Load 1m', t.load.one),
      stat('Load 5m', t.load.five),
      stat('Load 15m', t.load.fifteen),
      stat('Cores', t.cpu.cores || '—')),
    el('p', { className: 'muted sm', style: 'margin:12px 0 0' },
      [t.os.pretty, t.os.kernel].filter(Boolean).join(' · ') || 'unknown OS')));

  /* cpu + memory + network side by side */
  const grid = el('div', { className: 'grid2' });

  grid.append(card('CPU & memory',
    meter('CPU', t.cpu.percent, `${t.cpu.percent}%`),
    meter('Memory', t.memory.percent, `${fmtBytes(t.memory.used)} / ${fmtBytes(t.memory.total)}`),
    t.memory.swapTotal
      ? meter('Swap', t.memory.swapTotal ? (t.memory.swapUsed / t.memory.swapTotal) * 100 : 0,
          `${fmtBytes(t.memory.swapUsed)} / ${fmtBytes(t.memory.swapTotal)}`)
      : el('p', { className: 'muted sm', style: 'margin:0' }, 'No swap configured')));

  grid.append(card('Network',
    el('div', { className: 'stat-row', style: 'margin-bottom:14px' },
      stat('Down', fmtRate(t.network.rxRate)),
      stat('Up', fmtRate(t.network.txRate)),
      stat('Total in', fmtBytes(t.network.rxTotal)),
      stat('Total out', fmtBytes(t.network.txTotal))),
    t.network.interfaces.length
      ? dataTable(['Interface', 'Down', 'Up', 'In', 'Out'],
          t.network.interfaces.map((i) => [
            { text: i.virtual ? `${i.name} (virtual)` : i.name, cls: 'mono' },
            fmtRate(i.rxRate), fmtRate(i.txRate), fmtBytes(i.rxTotal), fmtBytes(i.txTotal)]))
      : el('p', { className: 'muted sm' }, 'No interface counters available')));

  pane.append(grid);

  /* storage */
  pane.append(card('Storage',
    t.disks.length
      ? t.disks.map((d) => meter(`${d.mount}  ${d.source}`, d.percent,
          `${fmtBytes(d.used)} / ${fmtBytes(d.total)} · ${fmtBytes(d.available)} free`))
      : el('p', { className: 'muted sm' }, 'No filesystems reported')));

  /* processes */
  pane.append(card(`Top processes  ·  ${t.processes.length}`,
    el('div', { className: 'scroll-y' },
      dataTable(['PID', 'User', 'CPU %', 'MEM %', 'RSS', 'Command'],
        t.processes.map((p) => [
          p.pid, p.user, p.cpu.toFixed(1), p.mem.toFixed(1), fmtBytes(p.rss),
          { text: p.command, cls: 'mono' }])))));

  /* hermes processes */
  pane.append(card('Hermes processes',
    t.hermes.length
      ? dataTable(['PID', 'CPU %', 'Uptime', 'Command'],
          t.hermes.map((p) => [p.pid || '—', p.cpu.toFixed(1), fmtDuration(p.etimeSeconds),
            { text: p.args, cls: 'mono wrap' }]))
      : el('p', { className: 'muted sm', style: 'margin:0' }, 'No hermes process running — the agent is asleep.')));

  /* docker */
  pane.append(renderDockerCard(t.docker));

  /* supabase */
  pane.append(renderSupabaseCard(t.supabase));

  content.scrollTop = scroll;
}

function renderDockerCard(d) {
  const c = el('div', { className: 'card' });
  c.append(el('div', { className: 'card-head' },
    el('h3', {}, 'Docker'),
    el('span', { className: `badge ${d.available ? 'ok' : ''}` }, d.available ? 'available' : 'unavailable')));

  if (!d.available) {
    c.append(el('p', { className: 'muted sm', style: 'margin:0' }, d.reason || 'not reachable'));
    return c;
  }

  c.append(el('h3', { style: 'margin:4px 0 8px' }, `Containers · ${d.containers.length}`));
  c.append(d.containers.length
    ? dataTable(['Name', 'Image', 'State', 'Status'],
        d.containers.map((x) => [x.name, { text: x.image, cls: 'mono' },
          { text: x.state, cls: /run/i.test(x.state) ? '' : 'muted' }, x.status]))
    : el('p', { className: 'muted sm' }, 'No running containers'));

  c.append(el('h3', { style: 'margin:16px 0 8px' }, `Images · ${d.images.length}`));
  c.append(d.images.length
    ? el('div', { className: 'scroll-y' },
        dataTable(['Repository', 'Tag', 'Size', 'Created'],
          d.images.map((x) => [{ text: x.repository, cls: 'mono' }, x.tag, x.size, x.created])))
    : el('p', { className: 'muted sm' }, 'No images'));

  if (d.usage.length) {
    c.append(el('h3', { style: 'margin:16px 0 8px' }, 'Disk usage'));
    c.append(dataTable(['Type', 'Total', 'Active', 'Size', 'Reclaimable'],
      d.usage.map((u) => [u.type, u.count, u.active, u.size, u.reclaimable])));
  }
  return c;
}

function renderSupabaseCard(sb) {
  const badge = !sb.detected ? '' : sb.health === 'healthy' ? 'ok' : 'err';
  const c = el('div', { className: 'card' });
  c.append(el('div', { className: 'card-head' },
    el('h3', {}, 'Supabase'),
    el('span', { className: `badge ${badge}` }, sb.detected ? sb.health : 'not detected')));

  if (sb.containers.length) {
    c.append(dataTable(['Service', 'Image', 'Status'],
      sb.containers.map((x) => [x.name, { text: x.image, cls: 'mono' }, x.status])));
  }

  const probed = sb.ports.filter((p) => p.code);
  c.append(el('h3', { style: 'margin:16px 0 8px' }, 'Port probes ', el('span', { className: 'muted' }, '· localhost')));
  c.append(dataTable(['Port', 'Service', 'HTTP'],
    sb.ports.map((p) => [
      { text: p.port, cls: 'mono' },
      p.label || '—',
      { text: p.code ? p.code : 'closed', cls: p.code ? '' : 'muted' }])));

  if (sb.cli) {
    c.append(el('h3', { style: 'margin:16px 0 8px' }, 'supabase status'));
    c.append(el('pre', { className: 'out' }, sb.cli));
  }
  if (!sb.detected) {
    c.append(el('p', { className: 'muted sm', style: 'margin:12px 0 0' },
      `No Supabase containers, CLI or responding ports found. ${probed.length} of ${sb.ports.length} probed ports answered.`));
  }
  return c;
}

/* =============================== settings ================================ */

function closeSettings() { $('#settings-modal').hidden = true; }

async function openSettings() {
  $('#settings-modal').hidden = false;
  await renderSettings();
}

async function renderSettings() {
  const body = $('#settings-body');
  body.textContent = '';

  let defaults = {};
  let info = { path: '', exists: false };
  try {
    defaults = await call(window.api.settings.getDefaults);
    info = await call(window.api.settings.configInfo);
  } catch (err) {
    body.append(el('p', { className: 'muted' }, `Could not read settings: ${err.message}`));
    return;
  }

  /* --- connection defaults --- */
  const defs = el('div', { className: 'settings-section' },
    el('h3', {}, 'Connection defaults'),
    el('p', { className: 'hint' }, 'Pre-filled whenever you add a host. Existing hosts keep their own values.'));

  const fields = {};
  const addField = (name, label, value, placeholder) => {
    const input = el('input', { value: value ?? '', placeholder: placeholder || '', autocomplete: 'off' });
    fields[name] = input;
    return el('label', { className: 'field' }, el('span', {}, label), input);
  };

  defs.append(el('div', { className: 'row' },
    el('div', { className: 'grow' }, addField('username', 'SSH username', defaults.username, 'your-ssh-user')),
    el('div', { className: 'w-90' }, addField('port', 'Port', defaults.port, '22'))));
  const authSel = el('select', {});
  for (const [v, label] of [['key', 'SSH key'], ['password', 'Password']]) {
    authSel.append(el('option', { value: v, textContent: label }));
  }
  authSel.value = defaults.auth === 'password' ? 'password' : 'key';
  defs.append(el('label', { className: 'field' }, el('span', {}, 'Default authentication'), authSel));

  defs.append(addField('privateKeyPath', 'Private key path', defaults.privateKeyPath, '~/.ssh/id_ed25519'));

  const keychain = el('p', { className: 'hint', style: 'margin:-4px 0 12px' });
  call(window.api.creds.available).then((ok) => {
    keychain.style.color = ok ? 'var(--muted)' : 'var(--warn)';
    keychain.textContent = ok
      ? 'Passwords are encrypted by your OS keychain and stored outside config.json.'
      : 'No OS keychain on this system — password hosts will prompt on every connect.';
  }).catch(() => {});
  defs.append(keychain);
  defs.append(el('div', { className: 'row' },
    el('div', { className: 'grow' }, addField('profile', 'Default Hermes profile', defaults.profile, 'default')),
    el('div', { className: 'grow' }, addField('hermesHome', 'Hermes home override', defaults.hermesHome, '$HERMES_HOME or ~/.hermes'))));

  const saveDefaults = el('button', { className: 'btn', textContent: 'Save defaults' });
  saveDefaults.onclick = async () => {
    saveDefaults.disabled = true;
    try {
      await call(window.api.settings.setDefaults, {
        username: fields.username.value.trim(),
        port: Number(fields.port.value) || 22,
        auth: authSel.value,
        privateKeyPath: fields.privateKeyPath.value.trim(),
        profile: fields.profile.value.trim() || 'default',
        hermesHome: fields.hermesHome.value.trim()
      });
      toast('Defaults saved', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      saveDefaults.disabled = false;
    }
  };
  defs.append(saveDefaults);
  body.append(defs);

  /* --- appearance --- */
  const appearance = el('div', { className: 'settings-section' },
    el('h3', {}, 'Appearance'),
    el('p', { className: 'hint' }, 'Agent activity animations — sleeping, thinking, working.'));

  const sel = el('select', { style: 'width:auto' });
  for (const [v, label] of [['always', 'Always on'], ['system', 'Follow system setting'], ['off', 'Off']]) {
    sel.append(el('option', { value: v, textContent: label }));
  }
  sel.value = state.motion;

  const note = el('div', { className: 'sm', style: 'margin-top:8px' });
  const refreshNote = () => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    note.textContent = '';
    note.style.color = 'var(--muted)';
    if (state.motion === 'system' && reduced) {
      note.style.color = 'var(--warn)';
      note.textContent = 'Your OS has "Reduce motion" enabled, so animations are currently off.';
    } else if (state.motion === 'always' && reduced) {
      note.textContent = 'This overrides your OS "Reduce motion" setting.';
    }
  };
  sel.onchange = () => { setMotion(sel.value); refreshNote(); };
  refreshNote();

  appearance.append(el('label', { className: 'field-inline' }, el('span', {}, 'Animation'), sel), note);
  body.append(appearance);

  /* --- config file --- */
  const cfg = el('div', { className: 'settings-section' },
    el('h3', {}, 'Config file'),
    el('p', { className: 'hint' },
      'Hosts and defaults live here as plain JSON. Edit it by hand, copy it to another machine, or keep it in a private repo. It holds key paths, never key material.'),
    el('div', { className: 'path-box' }, info.path || 'unknown'));

  const reveal = el('button', { className: 'btn ghost sm', textContent: 'Reveal in Finder' });
  reveal.onclick = () => call(window.api.settings.reveal).catch((e) => toast(e.message, 'err'));

  const reload = el('button', { className: 'btn ghost sm', textContent: 'Reload from disk' });
  reload.onclick = async () => {
    try {
      const fresh = await call(window.api.settings.reload);
      state.hosts = fresh.hosts;
      state.motion = fresh.ui.motion || 'always';
      applyMotion();
      renderSidebar();
      renderShellState();
      await renderSettings();
      toast(`Reloaded — ${fresh.hosts.length} host(s)`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  cfg.append(el('div', { className: 'row' }, reveal, reload));
  body.append(cfg);

  /* --- import --- */
  const imp = el('div', { className: 'settings-section' },
    el('h3', {}, 'Import from ~/.ssh/config'),
    el('p', { className: 'hint' },
      'Adds a host for each Host entry that names a real machine. Wildcard patterns such as "Host *" are skipped, and hosts you already have are left alone.'));

  const result = el('div', { className: 'sm muted', style: 'margin-top:10px' });
  const importBtn = el('button', { className: 'btn ghost sm', textContent: 'Scan and import' });
  importBtn.onclick = async () => {
    importBtn.disabled = true;
    try {
      const r = await call(window.api.hosts.importSshConfig);
      state.hosts = await call(window.api.hosts.list);
      renderSidebar();
      renderShellState();
      result.textContent = r.error
        ? `Nothing imported — ${r.error}`
        : `Found ${r.found}, added ${r.added}, already present ${r.skipped}.`;
      if (r.added) toast(`Imported ${r.added} host(s)`, 'ok');
    } catch (err) {
      result.textContent = err.message;
    } finally {
      importBtn.disabled = false;
    }
  };
  imp.append(importBtn, result);
  body.append(imp);
}
