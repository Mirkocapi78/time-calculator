// parser-lathe.js

/**
 * Estrae un array di comandi da un file ISO (tornio)
 * Ritorna array di oggetti { code, X, Z, F, S }
 */
function parseISO(text) {
  return text
    .split(/\r?\n/)
    .map(line => line.split(/;|\(/)[0].trim())
    .filter(line => !!line)
    .map(line => {
      const parts = line.split(/\s+/);
      // normalizzo il G-code
      let code = parts[0].toUpperCase();
      if (code === 'G00') code = 'G0';
      if (code === 'G01') code = 'G1';
      if (code === 'M03' || code === 'M3') code = 'M3';
      const cmd = { code, X: null, Z: null, F: null, S: null };
      for (let p of parts.slice(1)) {
        const letter = p[0].toUpperCase();
        const val = parseFloat(p.slice(1));
        if (letter === 'X') cmd.X = val;
        else if (letter === 'Z') cmd.Z = val;
        else if (letter === 'F') cmd.F = val;
        else if (letter === 'S') cmd.S = val;
      }
      return cmd;
    });
}

/**
 * Calcola tempo totale per tornio in secondi
 */
function computeLatheTime(commands) {
  const RAPID_RATE = 10000; // mm/min per G0
  let feedRev = 0;          // mm/rev (F)
  let cuttingSpeed = 0;     // m/min (G96)
  let rpm = 0;              // rev/min
  let pos = { X: 0, Z: 0 };
  let totalMin = 0;

  for (const cmd of commands) {
    switch (cmd.code) {
      case 'G96':
        // imposta velocità di taglio e ricalcola rpm
        if (cmd.S != null) cuttingSpeed = cmd.S;
        if (pos.X > 0 && cuttingSpeed) {
          rpm = (1000 * cuttingSpeed) / (Math.PI * pos.X);
        }
        if (cmd.F != null) feedRev = cmd.F;
        break;

      case 'M3':
        // imposta rpm costante
        if (cmd.S != null) rpm = cmd.S;
        break;

      case 'G0': {
        // rapido
        const dx = (cmd.X != null ? cmd.X : pos.X) - pos.X;
        const dz = (cmd.Z != null ? cmd.Z : pos.Z) - pos.Z;
        const dist = Math.hypot(dx, dz);
        totalMin += dist / RAPID_RATE;
        pos.X = cmd.X != null ? cmd.X : pos.X;
        pos.Z = cmd.Z != null ? cmd.Z : pos.Z;
        break;
      }

      case 'G1': {
        // avanzamento
        if (cmd.F != null) feedRev = cmd.F;
        const dx = (cmd.X != null ? cmd.X : pos.X) - pos.X;
        const dz = (cmd.Z != null ? cmd.Z : pos.Z) - pos.Z;
        const dist = Math.hypot(dx, dz);
        const feedMMperMin = feedRev * rpm;
        if (feedMMperMin > 0) {
          totalMin += dist / feedMMperMin;
        }
        pos.X = cmd.X != null ? cmd.X : pos.X;
        pos.Z = cmd.Z != null ? cmd.Z : pos.Z;
        break;
      }

      default:
        // ignoro tutti gli altri comandi
        break;
    }
  }

  return totalMin * 60; // ritorna in secondi
}

module.exports = { parseISO, computeLatheTime };
