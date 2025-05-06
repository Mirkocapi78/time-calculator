// parser-lathe.js  – versione modale con limite giri impostabile

/* ------------------------------------------------------------------
 * 1.  PARSER  →  trasforma il testo ISO in un array di comandi
 * ------------------------------------------------------------------ */
function parseISO(text) {
  const cmds = [];
  let state = { code: 'G0', feedMode: 'G95', speedMode: 'G97' };

  for (let raw of text.split(/\r?\n/)) {
    let line = raw.split(/;|\(/)[0].trim();      // togli commenti
    line = line.replace(/^[NO]\d+\s*/i, '');     // togli numeri di riga
    if (!line) continue;

    const parts = line.toUpperCase().split(/\s+/);
    let token0 = parts[0];

    /* ── gestione primo token se è G / M ─────────────────────────── */
    if (/^[GM]\d+/.test(token0)) {
      const c = token0.replace(/^G0([0-4])$/, 'G$1');

      // gruppo MOVIMENTO (G0-G4)
      if (/^G0[1234]|^G[01234]/.test(c)) {
        state.code = c.replace('G00','G0').replace('G01','G1')
                      .replace('G02','G2').replace('G03','G3')
                      .replace('G04','G4');
        parts.shift();                         // rimuovo il codice

      // gruppo FEED-MODE (G94 / G95)
      } else if (c === 'G94' || c === 'G95') {
        state.feedMode = c;
        parts.shift();                         // rimuovo il token

      // gruppo SPEED-MODE (G96 / G97) – M3 trattato come G97
      } else if (c === 'G96' || c === 'G97' || c === 'M03' || c === 'M3') {
        state.speedMode = (c === 'G96') ? 'G96' : 'G97';
        // **NON** tolgo il token: deve restare per cmd.code = 'G96'/'G97'

      // G26 / G50 / G92 devono restare per portare la S-limite
      }
    }

    /* ── costruisci il blocco cmd, ereditando lo stato corrente ──── */
    const cmd = {
      code: state.code,
      feedMode: state.feedMode,
      X:null, Z:null, I:null, K:null, F:null, S:null, P:null, L:null
    };

    for (const p of parts) {
      const k = p[0];
      const v = parseFloat(p.slice(1));
      if (isNaN(v)) continue;
      if (k==='X') cmd.X=v; else if(k==='Z') cmd.Z=v;
      else if(k==='I') cmd.I=v; else if(k==='K') cmd.K=v;
      else if(k==='F') cmd.F=v; else if(k==='S') cmd.S=v;
      else if(k==='P') cmd.P=v; else if(k==='L') cmd.L=v;
    }
    cmds.push(cmd);
  }
  return cmds;
}

/* ------------------------------------------------------------------
 * 2.  FUNZIONI DI SUPPORTO
 * ------------------------------------------------------------------ */
function arcLen(x0,z0,c){
  const xc = x0 + (c.I ?? 0);
  const zc = z0 + (c.K ?? 0);
  const r  = Math.hypot(x0 - xc, z0 - zc);
  const x1 = c.X ?? x0;
  const z1 = c.Z ?? z0;
  let dθ = Math.atan2(z1 - zc, x1 - xc) - Math.atan2(z0 - zc, x0 - xc);
  if (c.code === 'G2' && dθ > 0) dθ -= 2 * Math.PI;
  if (c.code === 'G3' && dθ < 0) dθ += 2 * Math.PI;
  return Math.abs(r * dθ);
}

/* ------------------------------------------------------------------
 * 3.  CALCOLO TEMPO  →  ritorna secondi
 * ------------------------------------------------------------------ */
function computeLatheTime(cmds, userMax = Infinity) {
  const RAPID = 10000;               // mm/min per G0
  let feedRev = 0;                   // mm/giro
  let rpm = 0, Vc = 0;               // rpm costante o da G96
  let rpmMax = Math.min(userMax, 4000); // default 4000 oppure limite UI
  let pos = { X: 0, Z: 0 };
  let tMin = 0;

  for (const c of cmds) {
    if (c.F != null) feedRev = c.F;

    // limiti mandrino
    if (c.code === 'G26' || c.code === 'G50' || c.code === 'G92') {
      if (c.S != null) rpmMax = Math.min(userMax, c.S);
    }

    // RPM costante (G97 o M3 con S)
    if ((c.code === 'G97' || c.code === 'M3') && c.S != null) {
      rpm = Math.min(c.S, rpmMax);
    }

    // velocità di taglio costante (G96 S..)
    if (c.code === 'G96' && c.S != null) Vc = c.S;

    // cambio utensile (L-blocco) → salta
    if (c.L) continue;

    // dwell G4
    if (c.code === 'G4') {
      const sec = c.X ?? c.F ?? c.P ?? 0;
      tMin += sec / 60;
      continue;
    }

    // distanza spostamento
    let dist = 0;
    if (c.code === 'G1' || c.code === 'G0') {
      dist = Math.hypot((c.X ?? pos.X) - pos.X, (c.Z ?? pos.Z) - pos.Z);
    } else if (c.code === 'G2' || c.code === 'G3') {
      dist = arcLen(pos.X, pos.Z, c);
    }

    // rapido
    if (c.code === 'G0') {
      tMin += dist / RAPID;

    // avanzamenti (G1/G2/G3)
    } else if (c.code === 'G1' || c.code === 'G2' || c.code === 'G3') {
      if (Vc && pos.X > 0) {
        const rpmRaw = (1000 * Vc) / (Math.PI * pos.X);
        rpm = Math.min(rpmRaw, rpmMax);
      }
      const feedMMmin = (c.feedMode === 'G95') ? feedRev * rpm : feedRev;
      if (feedMMmin > 0) tMin += dist / feedMMmin;
    }

    pos = { X: c.X ?? pos.X, Z: c.Z ?? pos.Z };
  }

  return tMin * 60;   // -> secondi
}

module.exports = { parseISO, computeLatheTime };
