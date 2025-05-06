// parser-lathe.js – parser + computeLatheTime corretti

/**
 * 1) Da G-code testuale (ISO) a lista di comandi {code,X,Z,I,K,F,S,P,L,feedMode}
 */
function parseISO(text) {
  const cmds = [];
  // stato modale
  let state = {
    code: 'G0',      // ultimo movimento (G0/G1/G2/G3/G4)
    feedMode: 'G95'  // mm/giro (G95) o mm/min (G94)
  };

  for (const raw of text.split(/\r?\n/)) {
    // strip commenti e numeri di riga
    let line = raw.split(/;|\(/)[0].trim().replace(/^[NO]\d+\s*/i, '');
    if (!line) continue;

    const parts = line.toUpperCase().split(/\s+/);
    const token0 = parts[0];
    let effectiveCode = state.code;

    // ── 1a) Se è movimento G0-G4 ─────────────────────────────────
    if (/^G00$|^G0[1-4]$|^G[1-4]$/.test(token0)) {
      // normalizza G00→G0, G01→G1, ecc.
      effectiveCode = token0
        .replace(/^G00$/, 'G0').replace(/^G01$/, 'G1')
        .replace(/^G02$/, 'G2').replace(/^G03$/, 'G3')
        .replace(/^G04$/, 'G4');
      state.code = effectiveCode;
      parts.shift(); // tolgo il token di movimento

    // ── 1b) Se è feed-mode G94/G95 ───────────────────────────────
    } else if (/^G94$|^G95$/.test(token0)) {
      state.feedMode = token0;
      parts.shift();

    // ── 1c) Se è uno dei modali che devono restare blocchi separati ─
    } else if (/^G26$|^G50$|^G92$|^G96$|^G97$|^M03$|^M3$/.test(token0)) {
      effectiveCode = token0;
      // non tolgo parts[0], così cmd.code = token0 e vedo S/…
    }

    // Costruisco il comando ereditando feedMode
    const cmd = {
      code:       effectiveCode,
      feedMode:   state.feedMode,
      X: null, Z: null, I: null, K: null,
      F: null, S: null, P: null, L: null
    };

    // Estraggo i parametri da tutti i token rimanenti
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
    }

    cmds.push(cmd);
  }

  return cmds;
}

/**
 * 2) Lunghezza di un arco (G2/G3) con I/K incrementali
 */
function arcLen(x0, z0, c) {
  const xc = x0 + (c.I ?? 0), zc = z0 + (c.K ?? 0);
  const r  = Math.hypot(x0 - xc, z0 - zc);
  const x1 = c.X ?? x0, z1 = c.Z ?? z0;
  let dθ = Math.atan2(z1 - zc, x1 - xc) - Math.atan2(z0 - zc, x0 - xc);
  if (c.code === 'G2' && dθ > 0) dθ -= 2 * Math.PI;
  if (c.code === 'G3' && dθ < 0) dθ += 2 * Math.PI;
  return Math.abs(r * dθ);
}

/**
 * 3) Calcola il tempo totale (in secondi)
 */
function computeLatheTime(cmds, userMax = Infinity) {
  const RAPID = 10000;             // mm/min per G0
  let pos = { X: 0, Z: 0 };
  let feedRev = 0, rpm = 0, Vc = 0;
  let rpmMax = Math.min(userMax, 4000); // default 4000 o limite utente
  let tMin = 0;

  for (const c of cmds) {
    // 3a) aggiorno feed modale se presente
    if (c.F != null) feedRev = c.F;

    // 3b) limiti mandrino da G26/G50/G92
    if (['G26','G50','G92'].includes(c.code) && c.S != null) {
      rpmMax = Math.min(userMax, c.S);
    }

    // 3c) RPM costante da G97/M3
    if ((c.code === 'G97' || c.code === 'M3') && c.S != null) {
      rpm = Math.min(c.S, rpmMax);
    }

    // 3d) Velocità di taglio da G96
    if (c.code === 'G96' && c.S != null) {
      Vc = c.S;
    }

    // 3e) Cambio utensile → skip
    if (c.L) continue;

    // 3f) Dwell G4/X=sec o F=sec
    if (c.code === 'G4') {
      const sec = c.X ?? c.F ?? c.P ?? 0;
      tMin += sec / 60;
      continue;
    }

    // 3g) Calcolo distanza del tratto
    let dist = 0;
    if (c.code === 'G0' || c.code === 'G1') {
      dist = Math.hypot((c.X ?? pos.X) - pos.X, (c.Z ?? pos.Z) - pos.Z);
    } else if (c.code === 'G2' || c.code === 'G3') {
      dist = arcLen(pos.X, pos.Z, c);
    }

    // 3h) Rapid
    if (c.code === 'G0') {
      tMin += dist / RAPID;
    }
    // 3i) Feed lineari/arco
    else if (['G1','G2','G3'].includes(c.code)) {
      // se G96 è attivo, ricalcolo rpm dinamico
      if (Vc && pos.X > 0) {
        const rpmCalc = (1000 * Vc) / (Math.PI * pos.X);
        rpm = Math.min(rpmCalc, rpmMax);
      }
      const feedMMmin = (c.feedMode === 'G95') ? feedRev * rpm : feedRev;
      if (feedMMmin > 0) tMin += dist / feedMMmin;
    }

    // aggiorno posizione
    pos = { X: c.X ?? pos.X, Z: c.Z ?? pos.Z };
  }

  // restituisco in secondi
  return tMin * 60;
}

module.exports = { parseISO, computeLatheTime };
