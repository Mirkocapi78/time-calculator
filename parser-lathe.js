// parser-lathe.js

/**
 * Estrae e normalizza i comandi G-code da un file ISO di tornio.
 */
function parseISO(text) {
  const cmds = [];
  for (let raw of text.split(/\r?\n/)) {
    // rimuovo commenti
    let line = raw.split(/;|\(/)[0].trim();
    // rimuovo numeri di sequenza Nxxx o Oxxx
    line = line.replace(/^[NO]\d+\s*/i, '');
    if (!line) continue;

    const parts = line.split(/\s+/);
    // normalizzo il codice principale
    let code = parts[0].toUpperCase();
    if (code === 'G00') code = 'G0';
    if (code === 'G01') code = 'G1';
    if (code === 'M03') code = 'M3';

    const cmd = { code, X: null, Z: null, F: null, S: null };
    for (let p of parts.slice(1)) {
      const letter = p[0].toUpperCase();
      const val = parseFloat(p.slice(1));
      if (letter === 'X') cmd.X = val;
      else if (letter === 'Z') cmd.Z = val;
      else if (letter === 'F') cmd.F = val;
      else if (letter === 'S') cmd.S = val;
    }
    cmds.push(cmd);
  }
  return cmds;
}

/**
 * Calcola il tempo di lavorazione (in secondi) sui comandi estratti.
 */
function computeLatheTime(commands) {
  const RAPID_RATE = 10000; // mm/min per G0
  let feedRev = 0, cuttingSpeed = 0, rpm = 0;
  let pos = { X: 0, Z: 0 }, totalMin = 0;

  for (const cmd of commands) {
    switch (cmd.code) {
      case 'G96':
        if (cmd.S != null) cuttingSpeed = cmd.S;
        if (pos.X > 0 && cuttingSpeed) {
          rpm = (1000 * cuttingSpeed) / (Math.PI * pos.X);
        }
        if (cmd.F != null) feedRev = cmd.F;
        break;

      case 'M3':
        if (cmd.S != null) rpm = cmd.S;
        break;

      case 'G0': {
        const dx = (cmd.X ?? pos.X) - pos.X;
        const dz = (cmd.Z ?? pos.Z) - pos.Z;
        totalMin += Math.hypot(dx, dz) / RAPID_RATE;
        pos.X = cmd.X ?? pos.X;
        pos.Z = cmd.Z ?? pos.Z;
        break;
      }

      case 'G1': {
        if (cmd.F != null) feedRev = cmd.F;
        const dx = (cmd.X ?? pos.X) - pos.X;
        const dz = (cmd.Z ?? pos.Z) - pos.Z;
        const dist = Math.hypot(dx, dz);
        const feedMMperMin = feedRev * rpm;
        if (feedMMperMin > 0) {
          totalMin += dist / feedMMperMin;
        }
        pos.X = cmd.X ?? pos.X;
        pos.Z = cmd.Z ?? pos.Z;
        break;
      }

      // altri G-code ignorati
    }
  }
  return totalMin * 60;
}

module.exports = { parseISO, computeLatheTime };
