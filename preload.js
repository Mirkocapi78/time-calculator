// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Apre la finestra di dialogo per selezionare un file
  selectFile: () =>
    ipcRenderer.invoke('select-file'),

  // Calcola il tempo: filePath = percorso, mode = 'lathe'|'mill', rpmMax = numero
  calculateTime: (filePath, mode, rpmMax) =>
    ipcRenderer.invoke('calculate-time', { path: filePath, mode, rpmMax })
});
