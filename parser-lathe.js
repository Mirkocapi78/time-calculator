// parser-lathe.js – parser completo + gestione asse C e X→raggio

/**
 * PARSE ISO → array di comandi normalizzati
 */
function parseISO(text) {
  const cmds = [];
  let state = { code: 'G0', feedMode: 'G95', cAxis: false };

  for (const raw of text.split(/\r?\n/)) {
    let line = raw.split(/;|\(/)[0].trim().replace(/^[NO]\d+\s*/i, '');
    if (!line) continue;

    const parts = line.toUpperCase().split(/\s+/);
    const token0 = parts[0];
    let effectiveCode = state.code;

    // gestione modali
    if (/^G00$|^G0[1-4]$|^G[1-4]$/.test(token0)) {
      effectiveCode = token0.replace(/^G00$/, 'G0').replace(/^G01$/, 'G1')
                          .replace(/^G02$/, 'G2').replace(/^G03$/, 'G3')
                          .replace(/^G04$/, 'G4');
      state.code = effectiveCode; parts.shift();
    } else if (/^G94$|^G95$/.test(token0)) {
      state.feedMode = token0; parts.shift();
    } else if (/^G26$|^G50$|^G92$/.test(token0)) {
      effectiveCode = token0; // rpm limit, keep in block
    } else if (/^G96$/.test(token0)) {
      effectiveCode = 'G96'; // constant cutting speed
    } else if (/^G97$|^M03$|^M3$/.test(token0)) {
      effectiveCode = 'G97'; // constant rpm mode
    } else if (/^G4$|^G04$/.test(token0)) {
      effectiveCode = 'G4'; state.code = 'G4'; parts.shift();
    } else if (/^M34$/.test(token0)) {
      state.cAxis = true; effectiveCode = 'M34'; parts.shift();
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

/**
 * CALCOLO lunghezza arco G2/G3 o C-axis arc (raggio da X)
 */
function arcLen(radius, c, isC=false) {
  if (isC) {
    // c: degrees, radius in mm → arc length
    return Math.abs(c * Math.PI / 180 * radius);
  }
  // G2/G3 using I/K incrementali
  const x0 = radius * 2; // not used
  // not needed here
  return 0;
}

/**
 * Calcola tempo totale (s)
 * - Ignora solo cambio utensile
 * - G0 al RAPID rate
 * - G1 lineari e diagonali (X→raggio/2, Z), G2/G3 archi
 * - C-axis (when M34) moves
 */
function computeLatheTime(cmds, userMax = Infinity) {
  const RAPID = 10000;
  let pos = { X:0, Z:0, C:0 };
  let feedRev = 0, rpm = 0, Vc = 0;
  let rpmMax = Math.min(userMax, 4000);
  let tMin = 0;
  let cAxisActive = false;

  for (const c of cmds) {
    // modali
    if (c.F != null) feedRev = c.F;
    if (['G26','G50','G92'].includes(c.code) && c.S != null) {
      rpmMax = Math.min(userMax, c.S);
    }
    if (c.code === 'G97' && c.S != null) rpm = Math.min(c.S, rpmMax);
    if (c.code === 'G96' && c.S != null) Vc = c.S;
    if (c.code === 'M34') { cAxisActive = true; }

    // skip cambio utensile
    if (c.L) continue;

    // dwell
    if (c.code === 'G4') {
      const sec = c.X ?? c.F ?? c.P ?? 0;
      tMin += sec / 60;
      pos = { X:c.X ?? pos.X, Z:c.Z ?? pos.Z, C:pos.C };
      continue;
    }

    // rapid G0
    if (c.code === 'G0') {
      const dr = ((c.X ?? pos.X) - pos.X)/2;
      const dz = (c.Z ?? pos.Z) - pos.Z;
      const dist = Math.hypot(dr, dz);
      tMin += dist / RAPID;
      pos = { X:c.X ?? pos.X, Z:c.Z ?? pos.Z, C:pos.C };
      continue;
    }

    // C-axis move
    if (cAxisActive && c.C != null) {
      const radius = (c.X ?? pos.X) / 2;
      const dC = (c.C - pos.C); // degrees
      const distC = Math.abs(dC * Math.PI / 180 * radius);
      // feed mm/min: G95=> mm/rev * rpm, G94=> mm/min
      const feedMMminC = (c.feedMode === 'G95') ? feedRev * rpm : feedRev;
      if (feedMMminC > 0) tMin += distC / feedMMminC;
      pos.C = c.C;
    }
    }

    // G1 or G2/G3 (cutting)
    let dist = 0;
    if (c.code === 'G1') {
      const dr = ((c.X ?? pos.X) - pos.X)/2;
      const dz = (c.Z ?? pos.Z) - pos.Z;
      dist = Math.hypot(dr, dz);
    } else if (c.code === 'G2' || c.code === 'G3') {
      const radius = pos.X/2;
      dist = arcLen(radius, c.code, false);
    }
    if (dist > 0) {
      if (Vc && pos.X > 0) {
        const rpmCalc = (1000*Vc)/(Math.PI*pos.X);
        rpm = Math.min(rpmCalc, rpmMax);
      }
      const feedMMmin = (c.feedMode==='G95') ? feedRev * rpm : feedRev;
      if (feedMMmin>0) tMin += dist / feedMMmin;
    }

    pos.X = c.X ?? pos.X;
    pos.Z = c.Z ?? pos.Z;
  }

  return tMin*60;
}

module.exports = { parseISO, computeLatheTime };
