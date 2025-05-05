const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const parser = require('./parser-lathe');

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
-     preload: path.join(__dirname, 'renderer.js'),
+     preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);

ipcMain.handle('select-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    filters: [{ name: 'ISO CNC Files', extensions: ['txt', 'iso', 'm', 'cnc'] }],
    properties: ['openFile']
  });
  if (canceled) return null;
  return filePaths[0];
});

ipcMain.handle('calculate-time', async (event, filepath) => {
  const fs = require('fs');
  const content = fs.readFileSync(filepath, 'utf8');
  const commands = parser.parseISO(content);
  const seconds = parser.computeLatheTime(commands);
  return seconds;
});
