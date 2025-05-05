module.exports = {
  parseISO,
  computeLatheTime
};

/**
 * Estrae un array di comandi da un file ISO (tornio)
 * Ritorna array di oggetti { code, X, Z, F, S }
 */
function parseISO(text) {
  const lines = text.split(/\r?\n/);
  const cmds = [];
  for (let line of lines) {
    line = line.split(/;|\(/)[0].trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const cmd = { code: parts[0], X: null, Z: null, F: null, S: null };
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      const letter = p[0];
      const value = parseFloat(p.slice(1));
      if (letter === 'X') cmd.X = value;
      if (letter === 'Z') cmd.Z = value;
      if (letter === 'F') cmd.F = value;
      if (letter === 'S') cmd.S = value;
    }
    cmds.push(cmd);
  }
  return cmds;
}

/**
 * Calcola tempo totale per tornio in secondi
 */
function computeLatheTime(commands) {
  const RAPID_RATE = 10000; // mm/min per G0
  let feedRev = 0;
  let cuttingSpeed = 0;
  let rpm = 0;
  let pos = { X: 0, Z: 0 };
  let totalMin = 0;

  for (const cmd of commands) {
    switch (cmd.code) {
      case 'G96':
        cuttingSpeed = cmd.S;
        if (pos.X > 0) rpm = (1000 * cuttingSpeed) / (Math.PI * pos.X);
        if (cmd.F != null) feedRev = cmd.F;
        break;
      case 'G0': {
        const dx = (cmd.X ?? pos.X) - pos.X;
        const dz = (cmd.Z ?? pos.Z) - pos.Z;
        const dist = Math.hypot(dx, dz);
        totalMin += dist / RAPID_RATE;
        pos.X = cmd.X ?? pos.X;
        pos.Z = cmd.Z ?? pos.Z;
        break;
      }
      case 'G1':
        if (cmd.F != null) feedRev = cmd.F;
        {
          const dx = (cmd.X ?? pos.X) - pos.X;
          const dz = (cmd.Z ?? pos.Z) - pos.Z;
          const dist = Math.hypot(dx, dz);
          const feedMMperMin = feedRev * rpm;
          totalMin += dist / feedMMperMin;
          pos.X = cmd.X ?? pos.X;
          pos.Z = cmd.Z ?? pos.Z;
        }
        break;
      default:
        break;
    }
  }
  return totalMin * 60;
}
