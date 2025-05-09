// main.js  – processo principale Electron
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const parser = require('./parser-lathe');

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), // ← carica il bridge
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);

/* ---- IPC: dialogo di apertura file ---- */
ipcMain.handle('select-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'ISO CNC Files', extensions: ['txt', 'iso', 'm', 'cnc'] }
    ]
  });
  if (canceled) return null;
  return filePaths[0];
});

/* ---- IPC: calcolo tempo ---- */
ipcMain.handle('calculate-time', async (event, { path, rpmMax }) => {
  const fs = require('fs');
  const content = fs.readFileSync(path, 'utf8');
  const cmds = parser.parseISO(content);
  const sec  = parser.computeLatheTime(cmds, rpmMax);
  return sec;
});
