// parser-mill.js – parser per centro di lavoro con gestione di etichette, IF/GOTOB, REPEAT e cicli Siemens (CYCLExx)

/**
 * 1) parseISO: trasforma il testo ISO in un array di oggetti { type, data }
 *    type: 'label' | 'assign' | 'if' | 'repeat' | 'command'
 */
function parseISO(text) {
  const lines = text.split(/\r?\n/);
  const raw   = [];

  for (let rawLine of lines) {
    let line = rawLine.split(/;|\(/)[0].trim();
    if (!line) continue;

    // Label: PASS_Z: o SBAVA2:
    const labelMatch = line.match(/^([A-Z_]\w*):$/i);
    if (labelMatch) {
      raw.push({ type: 'label', name: labelMatch[1] });
      continue;
    }

    // Assign: R1=R1-0.25
    const assignMatch = line.match(/^R(\d+)\s*=\s*(.+)$/i);
    if (assignMatch) {
      raw.push({ type: 'assign', varName: 'R' + assignMatch[1], expr: assignMatch[2] });
      continue;
    }

    // IF R1>=-6 GOTOB PASS_Z
    const ifMatch = line.match(/^IF\s+([Rr]\d+)\s*(>=|<=|==|>|<)\s*([-\d.]+)\s+GOTOB\s+([A-Z_]\w*)$/i);
    if (ifMatch) {
      raw.push({
        type:    'if',
        varName: ifMatch[1].toUpperCase(),
        operator: ifMatch[2],
        value:   parseFloat(ifMatch[3]),
        target:  ifMatch[4]
      });
      continue;
    }

    // REPEAT SBAVA2 P=1
    const repMatch = line.match(/^REPEAT\s+([A-Z_]\w*)\s+P=(\d+)/i);
    if (repMatch) {
      raw.push({ type: 'repeat', block: repMatch[1], count: parseInt(repMatch[2], 10) });
      continue;
    }

    // Comando G-code generico
    raw.push({ type: 'command', line });
  }

  return raw;
}

/**
 * 2) expandProgram: risolve label/assign/if/repeat e espande i for cycles MCALL
 *    restituisce array di stringhe G-code pronte per il calcolo tempo
 */
function expandProgram(raw) {
  // Prima passata: salva gli indici delle label
  const labels = {};
  raw.forEach((r, idx) => {
    if (r.type === 'label') labels[r.name] = idx;
  });

  const vars = {};      // memorizza R1, R2, ...
  const commands = [];
  let i = 0;

  // Stato per i drill cycles
  let cycleParams = null;

  while (i < raw.length) {
    const r = raw[i];

    // SALTA label
    if (r.type === 'label') {
      i++;
      continue;
    }
    // ASSIGN (aggiorna vars)
    if (r.type === 'assign') {
      const expr = r.expr.replace(/R(\d+)/g, (_, n) => vars['R' + n] || 0);
      // eslint-disable-next-line no-eval
      vars[r.varName] = eval(expr);
      i++;
      continue;
    }
    // IF ... GOTOB ...
    if (r.type === 'if') {
      const v = vars[r.varName] || 0;
      let cond = false;
      switch (r.operator) {
        case '>=': cond = v >= r.value; break;
        case '<=': cond = v <= r.value; break;
        case '==': cond = v === r.value; break;
        case '>':  cond = v >  r.value; break;
        case '<':  cond = v <  r.value; break;
      }
      i = cond ? (labels[r.target] || i + 1) : i + 1;
      continue;
    }
    // REPEAT block
    if (r.type === 'repeat') {
      const start = labels[r.block];
      const end   = labels['ENDLABEL'] || raw.length;
      for (let k = 0; k < r.count; k++) {
        for (let j = start; j < end; j++) {
          if (raw[j].type === 'command') {
            commands.push(raw[j].line);
          }
        }
      }
      i++;
      continue;
    }
    // COMMAND
    if (r.type === 'command') {
      const line = r.line.trim();

      // 1) MCALL CYCLExx(a,b,c,d,…) → salva params
      const m1 = line.match(/^MCALL\s+CYCLE\d+\s*\(\s*([^)]+)\)/i);
      if (m1) {
        const parts = m1[1].split(',').map(s => parseFloat(s) || 0);
        cycleParams = {
          approach: parts[0],
          plane:    parts[1],
          safety:   parts[2],
          depth:    parts[3]
        };
        i++;
        continue;
      }

      // 2) X.. Y.. dopo ciclo → genera il mini‐programma di foratura
      const m2 = line.match(/^X([-\d.]+)\s+Y([-\d.]+)/i);
      if (cycleParams && m2) {
        const x = parseFloat(m2[1]);
        const y = parseFloat(m2[2]);
        const { approach, plane, safety, depth } = cycleParams;

        // avvicinamento rapido al piano di approccio
        commands.push(`G0 Z${approach}`);
        // rapido XY
        commands.push(`G0 X${x} Y${y}`);
        // rapido al piano di sicurezza
        commands.push(`G0 Z${plane + safety}`);
        // foratura in G1 fino a depth
        commands.push(`G1 Z${depth}`);
        // ritorno rapido all'approach
        commands.push(`G0 Z${approach}`);

        i++;
        continue;
      }

      // 3) nuovo MCALL interrompe il ciclo
      if (/^MCALL\b/i.test(line)) {
        cycleParams = null;
        i++;
        continue;
      }

      // 4) altrimenti emetti la riga così com’è
      commands.push(line);
      i++;
      continue;
    }

    // fallback
    i++;
  }

  return commands;
}

/**
 * 3) computeMillTime: calcola il tempo totale (in secondi)
 *    gestisce G0, G1, G2/G3 su XY e Z, rotazione asse B, dwell G4
 */
function computeMillTime(cmdLines) {
  const RAPID = 10000;     // mm/min
  let pos = { X: 0, Y: 0, Z: 0, B: 0 };
  let feed = 0, rpm = 0;
  let tMin = 0;

  for (const line of cmdLines) {
    const parts = line.split(/\s+/);
    const code  = parts[0].toUpperCase();
    const args  = {};

    // estrai parametri
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      if (p.length < 2) continue;
      const k = p[0].toUpperCase();
      const v = parseFloat(p.slice(1));
      if (!isNaN(v)) args[k] = v;
    }

    // G0 rapid
    if (code === 'G0' || code === 'G00') {
      const dx = (args.X ?? pos.X) - pos.X;
      const dy = (args.Y ?? pos.Y) - pos.Y;
      const dz = (args.Z ?? pos.Z) - pos.Z;
      const dist = Math.hypot(dx, dy, dz);
      tMin += dist / RAPID;
      pos = { ...pos, X: args.X ?? pos.X, Y: args.Y ?? pos.Y, Z: args.Z ?? pos.Z };
      continue;
    }

    // G1 linear feed
    if (code === 'G1' || code === 'G01') {
      const dx = (args.X ?? pos.X) - pos.X;
      const dy = (args.Y ?? pos.Y) - pos.Y;
      const dz = (args.Z ?? pos.Z) - pos.Z;
      const dist = Math.hypot(dx, dy, dz);
      feed = args.F ?? feed;
      if (feed > 0) tMin += dist / feed;
      pos = { ...pos, X: args.X ?? pos.X, Y: args.Y ?? pos.Y, Z: args.Z ?? pos.Z };
      continue;
    }

    // G2/G3 circular XY (ignora Z)
    if (code === 'G2' || code === 'G3') {
      const x0 = pos.X, y0 = pos.Y;
      const xc = (args.I ?? 0) + x0;
      const yc = (args.J ?? 0) + y0;
      const r  = Math.hypot(x0 - xc, y0 - yc);
      const x1 = args.X ?? pos.X, y1 = args.Y ?? pos.Y;
      let dθ   = Math.atan2(y1 - yc, x1 - xc) - Math.atan2(y0 - yc, x0 - xc);
      if (code === 'G2' && dθ > 0) dθ -= 2 * Math.PI;
      if (code === 'G3' && dθ < 0) dθ += 2 * Math.PI;
      const arc = Math.abs(r * dθ);
      feed = args.F ?? feed;
      if (feed > 0) tMin += arc / feed;
      pos.X = x1; pos.Y = y1;
      continue;
    }

    // G4 dwell P in secondi
    if (code === 'G4' || code === 'G04') {
      const sec = args.P ?? 0;
      tMin += sec / 60;
      continue;
    }

    // Rotazione asse B (360° in 12s → 30°/s)
    if (args.B != null) {
      let delta = ((args.B - pos.B + 180) % 360) - 180;
      delta = Math.abs(delta);
      tMin += (delta / 30) / 60;
      pos.B = args.B;
      continue;
    }

    // altrimenti ignora M-codes ecc.
  }

  return tMin * 60;  // ritorna in secondi
}

module.exports = { parseISO, expandProgram, computeMillTime };
