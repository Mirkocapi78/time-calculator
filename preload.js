// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Apre la finestra di dialogo e restituisce il percorso del file
  selectFile: () => ipcRenderer.invoke('show-open-dialog'),
  // Legge il contenuto del file come testo
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  // Calcola il tempo: text = contenuto ISO, mode = 'lathe'|'mill', rpmMax = numero
  calcTime: ({ text, mode, rpmMax }) =>
    ipcRenderer.invoke('calc-time', { text, mode, rpmMax })
});
