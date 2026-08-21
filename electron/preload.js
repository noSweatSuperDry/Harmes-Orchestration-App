'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const on = (channel) => (handler) => {
  const listener = (_evt, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  hosts: {
    list: () => invoke('hosts:list'),
    save: (host) => invoke('hosts:save', host),
    remove: (id) => invoke('hosts:delete', id),
    defaultKey: () => invoke('hosts:defaultKey')
  },
  ui: {
    get: () => invoke('ui:get'),
    set: (patch) => invoke('ui:set', patch)
  },
  ssh: {
    connect: (id, passphrase) => invoke('ssh:connect', id, passphrase),
    disconnect: (id) => invoke('ssh:disconnect', id),
    status: (id) => invoke('ssh:status', id),
    exec: (id, cmd) => invoke('ssh:exec', id, cmd),
    onStatus: on('ssh:status')
  },
  hermes: {
    profiles: (id) => invoke('hermes:profiles', id),
    load: (id, profile) => invoke('hermes:load', id, profile),
    overview: (id, profile) => invoke('hermes:overview', id, profile),
    patchConfig: (id, profile, patches) => invoke('hermes:patchConfig', id, profile, patches),
    saveConfigRaw: (id, profile, text) => invoke('hermes:saveConfigRaw', id, profile, text),
    saveEnv: (id, profile, entries) => invoke('hermes:saveEnv', id, profile, entries),
    saveMemory: (id, profile, which, text) => invoke('hermes:saveMemory', id, profile, which, text)
  },
  term: {
    open: (id, termId, opts) => invoke('term:open', id, termId, opts),
    close: (id, termId) => invoke('term:close', id, termId),
    write: (id, termId, data) => ipcRenderer.send('term:write', id, termId, data),
    resize: (id, termId, cols, rows) => ipcRenderer.send('term:resize', id, termId, cols, rows),
    onData: on('term:data'),
    onExit: on('term:exit')
  }
});
