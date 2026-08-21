'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const store = require('./store');
const ssh = require('./ssh-manager');
const hermes = require('./hermes');
const telemetry = require('./telemetry');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#0f1115',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Surface renderer errors in the terminal you launched `npm start` from.
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer] ${message} (${source}:${line})`);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  store.init(app.getPath('userData'));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* Relay SSH events to the renderer. */
const relay = (channel) => (payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};
ssh.bus.on('status', relay('ssh:status'));
ssh.bus.on('term-data', relay('term:data'));
ssh.bus.on('term-exit', relay('term:exit'));

/* ------------------------------- IPC wiring ------------------------------ */

const handle = (channel, fn) => {
  ipcMain.handle(channel, async (_evt, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err), needsPassphrase: !!err.needsPassphrase };
    }
  });
};

const hostOf = (id) => {
  const h = store.getHost(id);
  if (!h) throw new Error('Unknown host');
  return h;
};

handle('hosts:list', () => store.listHosts());
handle('hosts:save', (input) => store.saveHost(input));
handle('hosts:delete', (id) => { ssh.disconnect(id); hermes.forgetHome(id); store.deleteHost(id); return true; });
handle('hosts:defaultKey', () => store.defaultKeyPath());
handle('hosts:importSshConfig', () => store.importSshConfig());
handle('defaults:get', () => store.getDefaults());
handle('defaults:set', (patch) => store.setDefaults(patch));
handle('config:info', () => store.configInfo());
handle('config:reload', () => store.reload());
handle('config:reveal', () => {
  const { path: p } = store.configInfo();
  shell.showItemInFolder(p);
  return true;
});
handle('ui:get', () => store.getUi());
handle('ui:set', (patch) => store.setUi(patch));

handle('ssh:connect', (id, passphrase) => connectAndDescribe(id, passphrase));
handle('ssh:disconnect', (id) => { ssh.disconnect(id); hermes.forgetHome(id); return true; });
handle('ssh:status', (id) => ssh.statusFor(id));
handle('ssh:exec', (id, cmd) => ssh.exec(id, cmd));

async function connectAndDescribe(id, passphrase) {
  const host = hostOf(id);
  await ssh.connect(host, { passphrase });
  hermes.forgetHome(id);
  const home = await hermes.resolveHome(id, host.hermesHome);
  const profiles = await hermes.listProfiles(id, host.hermesHome);
  return { home, profiles };
}

handle('hermes:profiles', (id) => hermes.listProfiles(id, hostOf(id).hermesHome));
handle('hermes:load', (id, profile) => hermes.loadProfile(id, profile, hostOf(id).hermesHome));
handle('hermes:overview', (id, profile) => hermes.overview(id, profile, hostOf(id).hermesHome));
handle('hermes:patchConfig', (id, profile, patches) =>
  hermes.patchConfig(id, profile, patches, hostOf(id).hermesHome));
handle('hermes:saveConfigRaw', (id, profile, text) =>
  hermes.saveConfigRaw(id, profile, text, hostOf(id).hermesHome));
handle('hermes:saveEnv', (id, profile, entries) =>
  hermes.saveEnv(id, profile, entries, hostOf(id).hermesHome));
handle('hermes:saveMemory', (id, profile, which, text) =>
  hermes.saveMemory(id, profile, which, text, hostOf(id).hermesHome));

handle('telemetry:collect', (id) => telemetry.collect(id));
handle('telemetry:pulse', (id) => telemetry.pulse(id));

handle('term:open', (id, termId, opts) => ssh.openShell(id, termId, opts));
handle('term:close', (id, termId) => { ssh.closeShell(id, termId); return true; });
ipcMain.on('term:write', (_e, id, termId, data) => ssh.writeShell(id, termId, data));
ipcMain.on('term:resize', (_e, id, termId, cols, rows) => ssh.resizeShell(id, termId, cols, rows));
