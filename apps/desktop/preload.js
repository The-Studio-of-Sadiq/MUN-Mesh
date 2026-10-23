// The UI is sandboxed; these are the only Node services it gets, all over IPC.
const { contextBridge, ipcRenderer } = require('electron');

// Small key-value files (identity, profile, settings), written immediately.
contextBridge.exposeInMainWorld('munStore', {
  get: (key) => ipcRenderer.invoke('store:get', key),
  set: (key, value) => ipcRenderer.invoke('store:set', key, value),
  remove: (key) => ipcRenderer.invoke('store:remove', key),
});

// Append-only event log.
contextBridge.exposeInMainWorld('munLog', {
  append: (text) => ipcRenderer.invoke('log:append', text),
  read: () => ipcRenderer.invoke('log:read'),
  clear: () => ipcRenderer.invoke('log:clear'),
});

contextBridge.exposeInMainWorld('munNet', {
  listen: (port) => ipcRenderer.invoke('net:listen', port),
  unlisten: () => ipcRenderer.invoke('net:unlisten'),
  connect: (host, port, timeoutMs) => ipcRenderer.invoke('net:connect', host, port, timeoutMs),
  write: (id, data) => ipcRenderer.send('net:write', id, data),
  end: (id) => ipcRenderer.send('net:end', id),
  destroy: (id) => ipcRenderer.send('net:destroy', id),
  addresses: () => ipcRenderer.invoke('net:addresses'),
  onEvent: (cb) => {
    const handler = (_e, event) => cb(event);
    ipcRenderer.on('net:event', handler);
    return () => ipcRenderer.removeListener('net:event', handler);
  },
});

contextBridge.exposeInMainWorld('munDiscovery', {
  start: () => ipcRenderer.invoke('discovery:start'),
  announce: (text) => ipcRenderer.invoke('discovery:announce', text),
  stop: () => ipcRenderer.invoke('discovery:stop'),
  onBeacon: (cb) => {
    const handler = (_e, beacon) => cb(beacon);
    ipcRenderer.on('discovery:beacon', handler);
    return () => ipcRenderer.removeListener('discovery:beacon', handler);
  },
});
