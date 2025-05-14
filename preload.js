// preload.js
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  selectFile: () =>
    ipcRenderer.invoke('select-file'),
  calculateTime: (filePath, rpmMax, mode) =>
    ipcRenderer.invoke('calculate-time', { path: filePath, rpmMax, mode })
});
