// preload.js
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  selectFile: () => ipcRenderer.invoke('select-file'),
  calcTime: (path) => ipcRenderer.invoke('calculate-time', path)
});
contextBridge.exposeInMainWorld('api', {
  selectFile: () => ipcRenderer.invoke('select-file'),
  calcTime:  (path, rpmMax) => ipcRenderer.invoke('calculate-time', { path, rpmMax })
});
