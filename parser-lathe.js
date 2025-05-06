// parser-lathe.js – parser + computeLatheTime con asse C e X→raggio

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

    // Movimento modale G0–G4
    if (/^G00$|^G0[1-4]$|^G[1-4]$/.test(token0)) {
      effectiveCode = token0
        .replace(/^G00$/, 'G0')
        .replace(/^G01$/, 'G1')
        .replace(/^G02$/, 'G2')
        .replace(/^G03$/, 'G3')
        .replace(/^G04$/, 'G4');
      state.code = effectiveCode;
      parts.shift();

    // Feed-mode G94/G95
    } else if (/^G94$|^G95$/.test(token0)) {
      state.feedMode = token0;
      parts.shift();

    // RPM-limits G26/G50/G92
    } else if (/^G26$|^G50$|^G92$/.test(token0)) {
      effectiveCode = token0;

    // Cutting speed / constant RPM G96/G97/M3
    } else if (/^G96$/.test(token0)) {
      effectiveCode = 'G96';
    } else if (/^G97$|^M03$|^M3$/.test(token0)) {
      effectiveCode = 'G97';
    }

    // Dwell G4
    if (/^G04$/.test(token0)) {
      effectiveCode = 'G4';
      state.code = 'G4';
      parts.shift();
    }

    // C-axis mode M34
    if (/^M34$/.test(token0)) {
      state.cAxis = true;
      effectiveCode = 'M34';
      parts.shift();
    }

    const cmd = {
      code:     effectiveCode,
      feedMode: state.feedMode,
      X: null, Z: null, I: null, K: null,
      F: null, S: null, P: null, L: null,
      C: null
    };

    for (const p of parts) {
      const k = p[0], v = parseFloat(p.slice(1));
      if (isNaN(v)) continue;
      if (k === 'X') cmd.X = v;
      else if (k === 'Z') cmd.Z = v;
      else if (k === 'I') cmd.I = v;
      else if (k === 'K') cmd.K = v;
      else if (k === 'F') cmd.F = v;
      else if (k === 'S') cmd.S = v;
      else if (k === 'P') cmd.P = v;
      else if (k === 'L') cmd.L = v;
      else if (k === 'C') cmd.C = v;
    }

    cmds.push(cmd);
  }

  return cmds;
}

/** 2) Lunghezza arco G2/G3 (riuso arcLen) e C-axis arc */
function arcLen(x0, z0, cmd) {
  if (cmd.code === 'M34' && cmd.C != null) {
    // C-axis arc: arc length = delta°, in radianti * radius
    // handled separately in computeLatheTime
    return 0;
  }
  // G2/G3 arc with I/K incrementali
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

/** 3) Calcolo tempo totale (secondi) */
function computeLatheTime(cmds, userMax = Infinity) {
  const RAPID = 10000;
  let pos = { X: 0, Z: 0, C: 0 };
  let feedRev = 0, rpm = 0, Vc = 0;
  let rpmMax  = Math.min(userMax, 4000);
  let tMin    = 0;
  let cAxisActive = false;

  for (const c of cmds) {
    // Modal updates
    if (c.F != null) feedRev = c.F;
    if (['G26','G50','G92'].includes(c.code) && c.S != null) {
      rpmMax = Math.min(userMax, c.S);
    }
    if (c.code === 'G97' && c.S != null) {
      rpm = Math.min(c.S, rpmMax);
    }
    if (c.code === 'G96' && c.S != null) {
      Vc = c.S;
    }
    if (c.code === 'M34') {
      cAxisActive = true;
    }

    // Skip tool-change
    if (c.L) continue;

    // Dwell
    if (c.code === 'G4') {
      const sec = c.X ?? c.F ?? c.P ?? 0;
      tMin += sec / 60;
      pos = { X: c.X ?? pos.X, Z: c.Z ?? pos.Z, C: pos.C };
      continue;
    }

    // Rapid
    if (c.code === 'G0') {
      const dr   = ((c.X ?? pos.X) - pos.X) / 2;
      const dz   = (c.Z ?? pos.Z) - pos.Z;
      const dist = Math.hypot(dr, dz);
      tMin += dist / RAPID;
      pos = { X: c.X ?? pos.X, Z: c.Z ?? pos.Z, C: pos.C };
      continue;
    }

    // C-axis move
    if (cAxisActive && c.C != null) {
      const radius  = (c.X ?? pos.X) / 2;
      const dCdeg   = (c.C - pos.C);
      const distC   = Math.abs(dCdeg * Math.PI/180 * radius);
      const feedC   = (c.feedMode === 'G95')
                        ? feedRev * rpm
                        : feedRev;
      if (feedC > 0) tMin += distC / feedC;
      pos.C = c.C;
    }

    // Cutting moves
    let dist = 0;
    if (c.code === 'G1') {
      const dr = ((c.X ?? pos.X) - pos.X) / 2;
      const dz = (c.Z ?? pos.Z) - pos.Z;
      dist = Math.hypot(dr, dz);
    } else if (c.code === 'G2' || c.code === 'G3') {
      dist = arcLen(pos.X, pos.Z, c);
    }

    if (dist > 0) {
      if (Vc && pos.X > 0) {
        const rpmCalc = (1000 * Vc) / (Math.PI * pos.X);
        rpm = Math.min(rpmCalc, rpmMax);
      }
      const feedMMmin = (c.feedMode === 'G95')
                        ? feedRev * rpm
                        : feedRev;
      if (feedMMmin > 0) tMin += dist / feedMMmin;
    }

    pos = { X: c.X ?? pos.X, Z: c.Z ?? pos.Z, C: pos.C };
  }

  return tMin * 60;
}

module.exports = { parseISO, computeLatheTime };
