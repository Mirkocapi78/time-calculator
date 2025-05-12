// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Apre la finestra di dialogo sul canale "select-file"
  selectFile: () =>
    ipcRenderer.invoke('select-file'),

   // Calcola il tempo sul canale "calculate-time"
   // ora include anche la modalità ('lathe' o 'mill')
   calculateTime: (filePath, mode, rpmMax) =>
     ipcRenderer.invoke('calculate-time', {
       path:    filePath,
       mode:    mode,
       rpmMax:  rpmMax
     })
