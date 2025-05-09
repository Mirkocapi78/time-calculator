// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;

// parser-lathe.js ora in root
const { parseISO: parseLathe, computeLatheTime }
  = require(path.join(__dirname, 'parser-lathe.js'));

// parser-mill.js in root
const { parseISO: parseMill, expandProgram, computeMillTime }
  = require(path.join(__dirname, 'parser-mill.js'));


let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  mainWindow.loadFile('index.html');
  // mainWindow.webContents.openDevTools(); // se ti serve il DevTools
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // Su macOS è comune restare aperti finché l'utente non fa Cmd+Q
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  // Su macOS ricrea finestra quando clicchi sull'icona del dock
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// --- IPC Handlers ---

// 1) Apri finestra di dialogo per selezionare il file
ipcMain.handle('show-open-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'ISO / G-Code Files', extensions: ['iso','txt','ngc','nc'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (canceled || filePaths.length === 0) return null;
  return filePaths[0];
});

// 2) Leggi il contenuto del file come testo
ipcMain.handle('read-file', async (event, filePath) => {
  return await fs.readFile(filePath, 'utf-8');
});

// 3) Calcola il tempo in base alla modalità
ipcMain.handle('calc-time', async (event, { text, mode, rpmMax }) => {
  if (mode === 'lathe') {
    // Tornio
    const cmds = parseLathe(text);
    const seconds = computeLatheTime(cmds, rpmMax);
    return seconds;
  } else {
    // Centro di lavoro
    const raw      = parseMill(text);
    const expanded = expandProgram(raw);
    const seconds  = computeMillTime(expanded);
    return seconds;
  }
});
