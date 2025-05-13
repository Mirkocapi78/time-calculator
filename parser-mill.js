// parser-mill.js – parser per centro di lavoro con drill‐cycles Siemens

/**
 * 1) parseISO → array di stringhe G-code “pulite”
 */
function parseISO(text) {
  const lines = [];
  for (let rawLine of text.split(/\r?\n/)) {
    // rimuovi commenti ( ; oppure ( ... ) )
    let line = rawLine.split(';')[0].replace(/\(.*?\)/g, '').trim();
    // togli prefisso N123 o O123
    line = line.replace(/^[NO]\d+\s*/i, '').trim();
    if (!line) continue;
    lines.push(line);
  }
  return lines;
}

/**
 * 2) expandProgram → array di stringhe G-code espanse
 *    - gestisce drill-cycles Siemens (MCALL CYCLExx)
 *    - risolve REPEAT ... P=... / ENDLABEL
 */
function expandProgram(rawLines) {
  const labels = {};
  const raw = [];

  // prima passata: cattura etichette
  rawLines.forEach((l, i) => {
    const m = l.match(/^([A-Z_]\w*):$/i);
    if (m) labels[m[1]] = i;
    raw.push(l);
  });

  const commands = [];
  const vars = {};
  let cycleParams = null;

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];

    // drill-cycle
    let m = line.match(/^MCALL\s+CYCLE\d+\s*\(\s*([^)]+)\)/i);
    if (m) {
      const [a, b, c, d] = m[1].split(',').map(v => parseFloat(v) || 0);
      cycleParams = { approach: a, plane: b, safety: c, depth: d };
      continue;
    }
    // dopo MCALL, righe X... Y... → espandi drill
    m = line.match(/^X([-\d.]+)\s+Y([-\d.]+)/i);
    if (cycleParams && m) {
      const x = parseFloat(m[1]), y = parseFloat(m[2]);
      const { approach, plane, safety, depth } = cycleParams;
      commands.push(`G0 Z${approach}`);
      commands.push(`G0 X${x} Y${y}`);
      commands.push(`G0 Z${plane + safety}`);
      commands.push(`G1 Z${depth}`);
      commands.push(`G0 Z${approach}`);
      cycleParams = null; // ciclo eseguito
      continue;
    }
    // IGNORA etichette e empty
    if (/^[A-Z_]\w*:$/.test(line)) continue;
    // tutto il resto è G-code
    commands.push(line);
  }

  return commands;
}

/**
 * 3) computeMillTime → totale in secondi
 */
function computeMillTime(cmdLines) {
  const RAPID = 10000; // mm/min
  let pos = { X:0, Y:0, Z:0, B:0 };
  let feed = 0;
  let tMin = 0;

  for (const line of cmdLines) {
    const parts = line.trim().split(/\s+/);
    const code  = parts[0].toUpperCase();
    const args  = {};

    // raccogli parametri numerici
    for (let i=1; i<parts.length; i++) {
      const p = parts[i], k = p[0].toUpperCase(), v = parseFloat(p.slice(1));
      if (!isNaN(v)) args[k] = v;
    }
    // aggiorna feed
    if (args.F != null) feed = args.F;

    // G0 rapido
    if (code === 'G0' || code === 'G00') {
      const dx = (args.X ?? pos.X) - pos.X;
      const dy = (args.Y ?? pos.Y) - pos.Y;
      const dz = (args.Z ?? pos.Z) - pos.Z;
      const d  = Math.hypot(dx, dy, dz);
      tMin += d / RAPID;
      pos.X = args.X ?? pos.X;
      pos.Y = args.Y ?? pos.Y;
      pos.Z = args.Z ?? pos.Z;
      continue;
    }

    // G1 avanzamento lineare
    if (code === 'G1' || code === 'G01') {
      const dx = (args.X ?? pos.X) - pos.X;
      const dy = (args.Y ?? pos.Y) - pos.Y;
      const dz = (args.Z ?? pos.Z) - pos.Z;
      const d  = Math.hypot(dx, dy, dz);
      if (feed > 0) tMin += d / feed;
      pos.X = args.X ?? pos.X;
      pos.Y = args.Y ?? pos.Y;
      pos.Z = args.Z ?? pos.Z;
      continue;
    }

    // G2/G3 circolare in XY (ignora Z)
    if (code === 'G2' || code === 'G3') {
      const x0 = pos.X, y0 = pos.Y;
      const xc = (args.I ?? 0) + x0, yc = (args.J ?? 0) + y0;
      const r  = Math.hypot(x0 - xc, y0 - yc);
      const x1 = args.X ?? pos.X, y1 = args.Y ?? pos.Y;
      let dθ   = Math.atan2(y1 - yc, x1 - xc) - Math.atan2(y0 - yc, x0 - xc);
      if (code==='G2' && dθ>0) dθ -= 2*Math.PI;
      if (code==='G3' && dθ<0) dθ += 2*Math.PI;
      const arc = Math.abs(r * dθ);
      if (feed > 0) tMin += arc / feed;
      pos.X = x1;
      pos.Y = y1;
      continue;
    }

    // G4 dwell (P in secondi)
    if (code === 'G4' || code === 'G04') {
      const sec = args.P ?? 0;
      tMin += sec / 60;
      continue;
    }

    // rotazione asse B (360° in 12s → 30°/s)
    if (args.B != null) {
      let delta = ((args.B - pos.B + 180) % 360) - 180;
      delta = Math.abs(delta);
      tMin += (delta / 30) / 60;
      pos.B = args.B;
      continue;
    }

    // tutti gli altri M‐code o comandi li ignoriamo
  }

  return tMin * 60; // ritorna secondi
}

module.exports = { parseISO, expandProgram, computeMillTime };
