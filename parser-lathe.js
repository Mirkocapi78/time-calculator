// parser-lathe.js – parser modale + calcolo tempo con limite RPM

/* ------------------------------------------------------------------
 * 1) PARSE ISO → array di comandi normalizzati
 * ------------------------------------------------------------------ */
function parseISO(text) {
  const cmds = [];
  let state = {
    code: 'G0',      // movimento modale corrente
    feedMode: 'G95'  // mm/giro (default)
  };

  for (const raw of text.split(/\r?\n/)) {
    // rimuove commenti e numeri di riga
    let line = raw.split(/;|\(/)[0].trim().replace(/^[NO]\d+\s*/i, '');
    if (!line) continue;

    const parts = line.toUpperCase().split(/\s+/);
    let token0 = parts[0];

    /* ── se è un G/M-code, aggiorna lo stato modale ──────────── */
    if (/^[GM]\d+/.test(token0)) {
      const c = token0.replace(/^G0([0-4])$/, 'G$1');
      // gruppo MOVIMENTO (G0-G4)
      if (/^G0[1234]|^G[01234]/.test(c)) {
        state.code = c
          .replace('G00','G0').replace('G01','G1')
          .replace('G02','G2').replace('G03','G3')
          .replace('G04','G4');
        parts.shift();
      }
      // gruppo FEED (G94/G95)
      else if (c === 'G94' || c === 'G95') {
        state.feedMode = c;
        parts.shift();
      }
      // G96/G97 (velocità di taglio / RPM costante): resta per cmd.code
      else if (c === 'G96' || c === 'G97') {
        // non rimuovere, serve a identificare il blocco
      }
      // M3 = G97
      else if (c === 'M03' || c === 'M3') {
        // trattato in computeLatheTime, ma possiamo rimuoverlo
        parts.shift();
      }
      // G26/G50/G92 restano per leggere S-limite
    }

    /* ── determina il codice effettivo del blocco ─────────────── */
    let effectiveCode = state.code;
    if (/^G(26|50|92)$/i.test(token0)) {
      effectiveCode = token0.toUpperCase();  // G26, G50 o G92
    }

    /* ── costruisci il comando ereditando lo stato corrente ───── */
    const cmd = {
      code: effectiveCode,
      feedMode: state.feedMode,
      X: null, Z: null, I: null, K: null,
      F: null, S: null, P: null, L: null
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
    }

    cmds.push(cmd);
  }

  return cmds;
}

/* ------------------------------------------------------------------
 * 2) SUPPORT: calcolo lunghezza arco G2/G3 con I/K incrementali
 * ------------------------------------------------------------------ */
function arcLen(x0, z0, c) {
  const xc = x0 + (c.I ?? 0);
  const zc = z0 + (c.K ?? 0);
  const r  = Math.hypot(x0 - xc, z0 - zc);
  const x1 = c.X ?? x0;
  const z1 = c.Z ?? z0;
  let dθ   = Math.atan2(z1 - zc, x1 - xc) - Math.atan2(z0 - zc, x0 - xc);
  if (c.code === 'G2' && dθ > 0) dθ -= 2 * Math.PI;
  if (c.code === 'G3' && dθ < 0) dθ += 2 * Math.PI;
  return Math.abs(r * dθ);
}

/* ------------------------------------------------------------------
 * 3) CALCOLO TEMPO → ritorna secondi totali
 * ------------------------------------------------------------------ */
function computeLatheTime(cmds, userMax = Infinity) {
  const RAPID = 10000;               // mm/min per G0
  let pos = { X: 0, Z: 0 };
  let feedRev = 0, rpm = 0, Vc = 0;
  let rpmMax = Math.min(userMax, 4000);
  let tMin = 0;

  for (const c of cmds) {
    // aggiorna feed modale
    if (c.F != null) feedRev = c.F;

    // imposta limite RPM da G26/G50/G92
    if (['G26','G50','G92'].includes(c.code) && c.S != null) {
      rpmMax = Math.min(userMax, c.S);
    }

    // M3/G97 impostano rpm costante
    if (c.code === 'G97' && c.S != null) {
      rpm = Math.min(c.S, rpmMax);
    }
    if (c.code === 'M3' && c.S != null) {
      rpm = Math.min(c.S, rpmMax);
    }

    // G96 imposta velocità di taglio (m/min)
    if (c.code === 'G96' && c.S != null) {
      Vc = c.S;
    }

    // skip cambio utensile
    if (c.L) continue;

    // dwell G4
    if (c.code === 'G4') {
      const sec = c.X ?? c.F ?? c.P ?? 0;
      tMin += sec / 60;
      continue;
    }

    // calcola distanza
    let dist = 0;
    if (c.code === 'G0' || c.code === 'G1') {
      dist = Math.hypot((c.X ?? pos.X) - pos.X, (c.Z ?? pos.Z) - pos.Z);
    } else if (c.code === 'G2' || c.code === 'G3') {
      dist = arcLen(pos.X, pos.Z, c);
    }

    // rapido
    if (c.code === 'G0') {
      tMin += dist / RAPID;
    }
    // avanzamenti lineari e ad arco
    else if (['G1','G2','G3'].includes(c.code)) {
      // rpm dinamico se G96 attivo
      if (Vc && pos.X > 0) {
        const rpmCalc = (1000 * Vc) / (Math.PI * pos.X);
        rpm = Math.min(rpmCalc, rpmMax);
      }
      const feedMMmin = (c.feedMode === 'G95') ? feedRev * rpm : feedRev;
      if (feedMMmin > 0) tMin += dist / feedMMmin;
    }

    // aggiorna posizione
    pos = { X: c.X ?? pos.X, Z: c.Z ?? pos.Z };
  }

  return tMin * 60;  // in secondi
}

module.exports = { parseISO, computeLatheTime };
