// Bridge between the scoreboard screen and the app (no Node access for the page itself).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sbApi', {
  displays:    ()   => ipcRenderer.invoke('displays'),
  setTarget:   (id) => ipcRenderer.invoke('set-target', id),
  setPractice: (on) => ipcRenderer.invoke('set-practice', on),
  clubs:       ()   => ipcRenderer.invoke('clubs'),
  badge:       (f)  => ipcRenderer.invoke('badge', f),
  globalKeys:  (on) => ipcRenderer.invoke('global-keys', on),
  onDisplays:  (cb) => ipcRenderer.on('displays-changed', (_e, info) => cb(info)),
  onGlobalKey: (cb) => ipcRenderer.on('global-key', (_e, code) => cb(code)),
});
