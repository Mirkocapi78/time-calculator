const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectFile: () => ipcRenderer.invoke('select-file'),
  calcTime: (path) => ipcRenderer.invoke('calculate-time', path)
});

window.addEventListener('DOMContentLoaded', () => {
  const openBtn = document.getElementById('openBtn');
  const calcBtn = document.getElementById('calcBtn');
  const filePathP = document.getElementById('filePath');
  const resultSpan = document.getElementById('result');

  let currentFile = null;

  openBtn.addEventListener('click', async () => {
    const path = await window.api.selectFile();
    if (path) {
      currentFile = path;
      filePathP.textContent = path;
      calcBtn.disabled = false;
    }
  });

  calcBtn.addEventListener('click', async () => {
    if (!currentFile) return;
    const sec = await window.api.calcTime(currentFile);
    resultSpan.textContent = sec.toFixed(1);
  });
});
