// preload.js  – bridge sicuro renderer ↔ main
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFile: () => ipcRenderer.invoke('select-file'),

  // accetta path + limite giri (rpmMax)
  calcTime:  (path, rpmMax) =>
    ipcRenderer.invoke('calculate-time', { path, rpmMax })
});
