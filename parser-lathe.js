// parser-lathe.js – parser completo + G0 e G76 con P/Q corretti

/** 1) PARSE ISO → array di comandi normalizzati */
function parseISO(text) {
  const cmds = [];
  let state = { code: 'G0', feedMode: 'G95', cAxis: false };

  for (const raw of text.split(/\r?\n/)) {
    let line = raw.split(/;|\(/)[0].trim().replace(/^[NO]\d+\s*/i, '');
    if (!line) continue;
    const parts = line.toUpperCase().split(/\s+/);
    const token0 = parts[0];
    let code = state.code;

    // Movimenti modali G0–G4
    if (/^G00$|^G0[1-4]$|^G[1-4]$/.test(token0)) {
      code = token0
        .replace(/^G00$/, 'G0')
        .replace(/^G01$/, 'G1')
        .replace(/^G02$/, 'G2')
        .replace(/^G03$/, 'G3')
        .replace(/^G04$/, 'G4');
      state.code = code; parts.shift();
    }
    // Feed-mode G94/G95
    else if (/^G94$/.test(token0)) { state.feedMode = 'G94'; parts.shift(); }
    else if (/^G95$/.test(token0)) { state.feedMode = 'G95'; parts.shift(); }
    // RPM limits
    else if (/^G26$|^G50$|^G92$/.test(token0)) { code = token0; }
    // Cutting speed
    else if (/^G96$/.test(token0)) { code = 'G96'; }
    // Constant RPM
    else if (/^G97$|^M03$|^M3$/.test(token0)) { code = 'G97'; }
    // Dwell
    if (/^G04$/.test(token0)) { code = 'G4'; state.code = 'G4'; parts.shift(); }
    // C-axis ON
    if (/^M34$|^M35$/.test(token0)) { state.cAxis = true; code = 'M34'; parts.shift(); }
    // C-axis OFF
    if (/^M05$|^M5$/.test(token0)) { state.cAxis = false; code = 'M5'; parts.shift(); }

    const cmd = { code: code, feedMode: state.feedMode,
                  X:null, Z:null, I:null, K:null,
                  F:null, S:null, P:null, Q:null, R:null, L:null, C:null };
    for (const p of parts) {
      const k = p[0], v = parseFloat(p.slice(1));
      if (isNaN(v)) continue;
      if ('XZIKFS'.includes(k)) cmd[k] = v;
      else if (k === 'P') cmd.P = v;
      else if (k === 'Q') cmd.Q = v;
      else if (k === 'R') cmd.R = v;
      else if (k === 'L') cmd.L = v;
      else if (k === 'C') cmd.C = v;
    }
    cmds.push(cmd);
  }
  return cmds;
}

/** 2) Lunghezza arco G2/G3 */
function arcLen(x0, z0, cmd) {
  const xr0 = x0/2, zr0 = z0;
  const xc  = xr0 + (cmd.I||0)/2, zc = zr0 + (cmd.K||0);
  const r   = Math.hypot(xr0-xc, zr0-zc);
  const xr1 = (cmd.X||x0)/2, zr1 = cmd.Z||z0;
  let dθ = Math.atan2(zr1-zc, xr1-xc) - Math.atan2(zr0-zc, xr0-xc);
  if (cmd.code==='G2' && dθ>0) dθ -= 2*Math.PI;
  if (cmd.code==='G3' && dθ<0) dθ += 2*Math.PI;
  return Math.abs(r*dθ);
}

/** 3) Calcolo tempo totale (s) */
function computeLatheTime(cmds, userMax=Infinity) {
  const RAPID = 10000;
  let pos = { X:0, Z:0, C:0 };
  let feedRev = 0, rpm = 0, Vc = 0;
  let rpmMax = Math.min(userMax, 4000);
  let tMin = 0;
  let g76Count = 0;

  for (const c of cmds) {
    // Modals
    if (c.F!=null) feedRev = c.F;
    if (['G26','G50','G92'].includes(c.code) && c.S!=null) rpmMax = Math.min(userMax, c.S);
    if (c.code==='G97' && c.S!=null) rpm = Math.min(c.S, rpmMax);
    if (c.code==='G96' && c.S!=null) Vc = c.S;

    // Skip tool change
    if (c.L) continue;

    // Dwell
    if (c.code==='G4') {
      const sec = (c.X||c.F||c.P||0);
      tMin += sec/60;
      pos.X = c.X||pos.X; pos.Z = c.Z||pos.Z;
      continue;
    }

    // Rapid moves G0
    if (c.code==='G0') {
      const dr = ((c.X||pos.X)-pos.X)/2;
      const dz = (c.Z||pos.Z)-pos.Z;
      const dist = Math.hypot(dr, dz);
      tMin += dist / RAPID;
      pos.X = c.X||pos.X; pos.Z = c.Z||pos.Z;
      continue;
    }

    // G76 cycle expansion
    if (c.code==='G76') {
      g76Count++;
      // feed for threads (use G95 or G94)
      const feedMMmin = (c.feedMode==='G95') ? feedRev*rpm : feedRev;
      if (g76Count===1) {
        // Q = last finishing pass depth (mm)
        const depth = c.Q||0;
        if (feedMMmin>0) tMin += depth / feedMMmin;
      } else if (g76Count===2) {
        // P = total depth in µm, Q = depth/pass in µm
        const total = (c.P||0)/1000;
        const step  = (c.Q||total)/1000;
        const passes= Math.ceil(total/step);
        for (let i=1; i<=passes; i++) {
          const d = Math.min(i*step, total);
          if (feedMMmin>0) tMin += d / feedMMmin;
        }
      }
      pos.Z = c.Z||pos.Z;
      continue;
    }

    // Cutting moves G1, G2, G3
    let dist = 0;
    if (c.code==='G1') {
      const dr = ((c.X||pos.X)-pos.X)/2;
      const dz = (c.Z||pos.Z)-pos.Z;
      dist = Math.hypot(dr, dz);
    } else if (c.code==='G2'||c.code==='G3') {
      dist = arcLen(pos.X, pos.Z, c);
    }
    if (dist>0) {
      if (Vc && pos.X>0) {
        const rpmCalc = (1000*Vc)/(Math.PI*pos.X);
        rpm = Math.min(rpmCalc, rpmMax);
      }
      const feedMMmin = (c.feedMode==='G95') ? feedRev*rpm : feedRev;
      if (feedMMmin>0) tMin += dist / feedMMmin;
    }

    pos.X = c.X||pos.X; pos.Z = c.Z||pos.Z;
  }
  return tMin * 60;
}

module.exports = { parseISO, computeLatheTime };
