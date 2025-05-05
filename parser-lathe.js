// parser-lathe.js  (v3) – normalizza G0x, gestisce G4 dwell

function parseISO(text) {
  const cmds = [];
  for (let raw of text.split(/\r?\n/)) {
    let line = raw.split(/;|\(/)[0].trim();
    line = line.replace(/^[NO]\d+\s*/i, '');          // rimuove N… / O…
    if (!line) continue;

    const parts = line.toUpperCase().split(/\s+/);
    let code = parts[0];

    // ➜ normalizzazione zero-pad
    if (code === 'G00') code = 'G0';
    if (code === 'G01') code = 'G1';
    if (code === 'G02') code = 'G2';
    if (code === 'G03') code = 'G3';
    if (code === 'G04') code = 'G4';
    if (code === 'M03') code = 'M3';

    const cmd = { code, X: null, Z: null, I: null, K: null, F: null, S: null };
    for (let p of parts.slice(1)) {
      const k = p[0];
      const v = parseFloat(p.slice(1));
      switch (k) {
        case 'X': cmd.X = v; break;
        case 'Z': cmd.Z = v; break;
        case 'I': cmd.I = v; break;
        case 'K': cmd.K = v; break;
        case 'F': cmd.F = v; break;
        case 'S': cmd.S = v; break;
      }
    }
    cmds.push(cmd);
  }
  return cmds;
}

function arcLength(x0, z0, cmd) {
  const xc = x0 + (cmd.I ?? 0);
  const zc = z0 + (cmd.K ?? 0);
  const r  = Math.hypot(x0 - xc, z0 - zc);
  const x1 = cmd.X ?? x0;
  const z1 = cmd.Z ?? z0;
  const a0 = Math.atan2(z0 - zc, x0 - xc);
  const a1 = Math.atan2(z1 - zc, x1 - xc);
  let dθ = a1 - a0;
  if (cmd.code === 'G2' && dθ > 0) dθ -= 2 * Math.PI;
  if (cmd.code === 'G3' && dθ < 0) dθ += 2 * Math.PI;
  return Math.abs(r * dθ);
}

function computeLatheTime(cmds) {
  const RAPID = 10000;         // mm/min per G0
  let feedRev = 0, rpm = 0, vc = 0;
  let rpmMin = 0, rpmMax = Infinity;
  let pos = { X: 0, Z: 0 }, tMin = 0;

  for (const c of cmds) {
    if (c.L) continue;         // L-n di cambio utensile: ignorato

    switch (c.code) {
      case 'G50':
      case 'G92':
      case 'G26':
        if (c.S != null) rpmMax = c.S;
        break;

      case 'M3':
        if (c.S != null) rpm = Math.min(Math.max(c.S, rpmMin), rpmMax);
        break;

      case 'G96':
        if (c.S != null) vc = c.S;
        break;

      case 'G4': {             // dwell: X o F ⇒ secondi
        const sec = (c.X ?? c.F ?? 0);
        tMin += sec / 60;
        break;
      }

      case 'G0': {
        const dx = (c.X ?? pos.X) - pos.X;
        const dz = (c.Z ?? pos.Z) - pos.Z;
        tMin += Math.hypot(dx, dz) / RAPID;
        pos = { X: c.X ?? pos.X, Z: c.Z ?? pos.Z };
        break;
      }

      case 'G1':
      case 'G2':
      case 'G3': {
        if (c.F != null) feedRev = c.F;

        // rpm dinamico se Vc attivo
        if (vc && pos.X > 0) {
          rpm = (1000 * vc) / (Math.PI * pos.X);
          rpm = Math.min(Math.max(rpm, rpmMin), rpmMax);
        }

        const dist = (c.code === 'G1')
          ? Math.hypot((c.X ?? pos.X) - pos.X, (c.Z ?? pos.Z) - pos.Z)
          : arcLength(pos.X, pos.Z, c);

        const feedMMmin = feedRev * rpm;
        if (feedMMmin > 0) tMin += dist / feedMMmin;

        pos = { X: c.X ?? pos.X, Z: c.Z ?? pos.Z };
        break;
      }
    }
  }
  return tMin * 60;            // secondi
}

module.exports = { parseISO, computeLatheTime };
