const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['overlay:visibility', 'overlay:hover', 'overlay:blur', 'browser:open', 'update:status', 'hotkey', 'state:click-through', 'state:failed-hotkeys', 'accounts:status', 'accounts:browser-login'];

contextBridge.exposeInMainWorld('ds', {
  getState: () => ipcRenderer.invoke('state:get'),
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  setHotkey: (action, accel) => ipcRenderer.invoke('hotkey:set', action, accel),
  resetHotkeys: () => ipcRenderer.invoke('hotkeys:reset'),
  suspendHotkeys: (on) => ipcRenderer.send('hotkeys:suspend', on),
  toggleClickThrough: () => ipcRenderer.send('window:click-through'),
  resetBounds: () => ipcRenderer.send('window:reset-bounds'),
  sizePreset: (preset) => ipcRenderer.send('window:size', preset),
  quit: () => ipcRenderer.send('app:quit'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  accounts: () => ipcRenderer.invoke('accounts:get'),
  pageScript: (name) => ipcRenderer.invoke('page-script', name),
  logout: (site) => ipcRenderer.invoke('accounts:logout', site),
  browserLogin: (site) => ipcRenderer.invoke('accounts:browser-login', site),
  cancelBrowserLogin: () => ipcRenderer.send('accounts:browser-login-cancel'),
  focusOverride: (on) => ipcRenderer.send('window:focus-override', on),
  on: (channel, fn) => {
    if (EVENTS.includes(channel)) ipcRenderer.on(channel, (_e, ...args) => fn(...args));
  },
});
