// parser-lathe.js – parser completo + calcolo combinato asse C per G1 e gestione G76

/** 1) PARSE ISO → array di comandi normalizzati */
function parseISO(text) {
  const cmds = [];
  let state = { code: 'G0', feedMode: 'G95', cAxis: false };

  for (const raw of text.split(/\r?\n/)) {
    let line = raw.split(/;|\(/)[0].trim().replace(/^[NO]\d+\s*/i, '');
    if (!line) continue;
    const parts = line.toUpperCase().split(/\s+/);
    const token0 = parts[0];
    let effectiveCode = state.code;

    // Movimenti modali G0–G4
    if (/^G00$|^G0[1-4]$|^G[1-4]$/.test(token0)) {
      effectiveCode = token0
        .replace(/^G00$/, 'G0')
        .replace(/^G01$/, 'G1')
        .replace(/^G02$/, 'G2')
        .replace(/^G03$/, 'G3')
        .replace(/^G04$/, 'G4');
      state.code = effectiveCode;
      parts.shift();
    }
    // Feed-mode G94/G95
    else if (/^G94$|^G95$/.test(token0)) {
      state.feedMode = token0;
      parts.shift();
    }
    // RPM limits G26/G50/G92
    else if (/^G26$|^G50$|^G92$/.test(token0)) {
      effectiveCode = token0;
    }
    // Cutting speed G96
    else if (/^G96$/.test(token0)) {
      effectiveCode = 'G96';
    }
    // Constant RPM G97/M3
    else if (/^G97$|^M03$|^M3$/.test(token0)) {
      effectiveCode = 'G97';
    }
    // Dwell G4/G04
    if (/^G04$/.test(token0)) {
      effectiveCode = 'G4';
      state.code = 'G4';
      parts.shift();
    }
    // C-axis ON (modalità fresatura)
    if (/^M34$|^M35$/.test(token0)) {
      state.cAxis = true;
      effectiveCode = 'M34';
      parts.shift();
    }
    // Spindle OFF disabilita C-axis
    if (/^M05$|^M5$/.test(token0)) {
      state.cAxis = false;
      effectiveCode = 'M5';
      parts.shift();
    }

    const cmd = {
      code: effectiveCode,
      feedMode: state.feedMode,
      X: null, Z: null, I: null, K: null,
      F: null, S: null, P: null, L: null,
      C: null
    };
    for (const p of parts) {
      const k = p[0], v = parseFloat(p.slice(1));
      if (isNaN(v)) continue;
      if (k==='X') cmd.X = v;
      else if (k==='Z') cmd.Z = v;
      else if (k==='I') cmd.I = v;
      else if (k==='K') cmd.K = v;
      else if (k==='F') cmd.F = v;
      else if (k==='S') cmd.S = v;
      else if (k==='P') cmd.P = v;
      else if (k==='L') cmd.L = v;
      else if (k==='C') cmd.C = v;
    }
    cmds.push(cmd);
  }
  return cmds;
}

/** 2) Calcola lunghezza di arco G2/G3 con I/K incrementali */
function arcLen(x0, z0, cmd) {
  const xr0 = x0 / 2;
  const zr0 = z0;
  const xc  = xr0 + (cmd.I ?? 0) / 2;
  const zc  = zr0 + (cmd.K ?? 0);
  const r   = Math.hypot(xr0 - xc, zr0 - zc);
  const xr1 = (cmd.X ?? x0) / 2;
  const zr1 = cmd.Z ?? z0;
  let dθ   = Math.atan2(zr1 - zc, xr1 - xc) - Math.atan2(zr0 - zc, xr0 - xc);
  if (cmd.code === 'G2' && dθ > 0) dθ -= 2 * Math.PI;
  if (cmd.code === 'G3' && dθ < 0) dθ += 2 * Math.PI;
  return Math.abs(r * dθ);
}

/** 3) Calcolo tempo totale (in secondi) con espansione G76 */
function computeLatheTime(cmds, userMax = Infinity) {
  const RAPID = 10000; // mm/min per G0
  let pos = { X: 0, Z: 0, C: 0 };
  let feedRev = 0, rpm = 0, Vc = 0;
  let rpmMax = Math.min(userMax, 4000);
  let tMin = 0;
  let g76Count = 0;

  for (const c of cmds) {
    // aggiornamenti modali
    if (c.F != null) feedRev = c.F;
    if (['G26','G50','G92'].includes(c.code) && c.S != null) rpmMax = Math.min(userMax, c.S);
    if (c.code === 'G97' && c.S != null) rpm = Math.min(c.S, rpmMax);
    if (c.code === 'G96' && c.S != null) Vc = c.S;

    // skip tool change
    if (c.L) continue;

    // dwell G4
    if (c.code === 'G4') {
      const sec = c.X ?? c.F ?? c.P ?? 0;
      tMin += sec / 60;
      pos.X = c.X ?? pos.X;
      pos.Z = c.Z ?? pos.Z;
      continue;
    }

    // rapid G0
    if (c.code === 'G0') {
      const dr = ((c.X ?? pos.X) - pos.X) / 2;
      const dz = (c.Z ?? pos.Z) - pos.Z;
      const dist = Math.hypot(dr, dz);
      tMin += dist / RAPID;
      pos.X = c.X ?? pos.X;
      pos.Z = c.Z ?? pos.Z;
      continue;
    }

    // espansione G76
    if (c.code === 'G76') {
      g76Count++;
      const feedMMmin = (c.feedMode === 'G95') ? feedRev * rpm : feedRev;
      if (g76Count === 1) {
        // primo G76: Q = profondità ultima passata (mm)
        const depth = c.P != null ? (c.P / 1000) : (c.Q ?? 0);
        if (feedMMmin > 0) tMin += depth / feedMMmin;
      } else if (g76Count === 2) {
        // secondo G76: P profondità totale in µm, Q incremento in µm
        const totalDepth = (c.P ?? 0) / 1000;
        const stepDepth  = (c.Q ?? totalDepth * 1000) / 1000;
        const passes = Math.ceil(totalDepth / stepDepth);
        for (let i = 1; i <= passes; i++) {
          const d = Math.min(i * stepDepth, totalDepth);
          if (feedMMmin > 0) tMin += d / feedMMmin;
        }
      }
      pos.Z = c.Z ?? pos.Z;
      continue;
    }

    // movimenti di taglio G1/G2/G3
    let dr = ((c.X ?? pos.X) - pos.X) / 2;
    let dz = (c.Z ?? pos.Z) - pos.Z;
    let dist = 0;
    if (c.code === 'G1') {
      dist = Math.hypot(dr, dz);
    } else if (c.code === 'G2' || c.code === 'G3') {
      dist = arcLen(pos.X, pos.Z, c);
    }
    if (dist > 0) {
      if (Vc && pos.X > 0) {
        const rpmCalc = (1000 * Vc) / (Math.PI * pos.X);
        rpm = Math.min(rpmCalc, rpmMax);
      }
      const feedMMmin = (c.feedMode === 'G95') ? feedRev * rpm : feedRev;
      if (feedMMmin > 0) tMin += dist / feedMMmin;
    }

    pos.X = c.X ?? pos.X;
    pos.Z = c.Z ?? pos.Z;
  }

  return tMin * 60;
}

module.exports = { parseISO, computeLatheTime };
