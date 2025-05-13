// main.js  – processo principale Electron
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const {
 parseISO:   parseLathe,
  computeLatheTime
} = require('./parser-lathe');

const {
  parseISO:   parseMill,
  expandProgram,
  computeMillTime
} = require('./parser-mill');

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
 
   // Aggiungi questa riga per far partire le DevTools
  win.webContents.openDevTools({ mode: 'bottom' });
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
ipcMain.handle('calculate-time', async (_, { path, mode, rpmMax }) => {
  const fs   = require('fs');
  const text = fs.readFileSync(path, 'utf8');

  if (mode === 'lathe') {
    // → rimane come prima
    const cmds = parseLathe(text);
    return computeLatheTime(cmds, rpmMax);
  }
  else if (mode === 'mill') {
    // ← qui entra il nuovo parser‐mill
    const rawLines = parseMill(text);
    const cmds     = expandProgram(rawLines);
    const secs     = computeMillTime(cmds);
    return secs;
  }
  else {
    throw new Error(`Modalità sconosciuta: ${mode}`);
  }
});
