// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Apre la finestra di dialogo sul canale "select-file"
  selectFile: () =>
    ipcRenderer.invoke('select-file'),

  // Calcola il tempo sul canale "calculate-time"
  calculateTime: (filePath, rpmMax) =>
    ipcRenderer.invoke('calculate-time', { path: filePath, rpmMax })
});
