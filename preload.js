'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kbmRelay', {
  setMode: (mode) => ipcRenderer.invoke('set-mode', mode),
  getState: () => ipcRenderer.invoke('get-state'),
  setPairing: (open) => ipcRenderer.invoke('set-pairing', open),
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
});
