// parser-mill.js – parser per centro di lavoro con drill‐cycles Siemens

/**
 * 1) parseISO → array di { type, ... }
 */
function parseISO(text) {
  const raw = [];
  for (const rawLine of text.split(/\r?\n/)) {
    // 1.a) rimuovo tutto dopo ';' (commenti)
    let line = rawLine.split(/;|\(/)[0];
    // 1.b) tolgo eventuale prefisso N123 o O123
    line = line.replace(/^[NO]\d+\s*/i, '').trim();
    // 1.c) se è vuota, salto
    if (!line) continue;

    // Label (es: SBAVA2:)
    const lbl = line.match(/^([A-Z_]\w*):$/i);
    if (lbl) {
      raw.push({ type: 'label', name: lbl[1] });
      continue;
    }

    // Assign (es: R1=R1-0.25)
    const asg = line.match(/^R(\d+)\s*=\s*(.+)$/i);
    if (asg) {
      raw.push({ type: 'assign', varName: 'R' + asg[1], expr: asg[2] });
      continue;
    }

    // IF ... GOTOB ...
    const iff = line.match(/^IF\s+([Rr]\d+)\s*(>=|<=|==|>|<)\s*([-\d.]+)\s+GOTOB\s+([A-Z_]\w*)$/i);
    if (iff) {
      raw.push({
        type:     'if',
        varName:  iff[1].toUpperCase(),
        operator: iff[2],
        value:    parseFloat(iff[3]),
        target:   iff[4]
      });
      continue;
    }

    // REPEAT block P=n
    const rep = line.match(/^REPEAT\s+([A-Z_]\w*)\s+P=(\d+)/i);
    if (rep) {
      raw.push({ type: 'repeat', block: rep[1], count: parseInt(rep[2], 10) });
      continue;
    }

    // Comando G-code generico (inclusi MCALL CYCLE…)
    raw.push({ type: 'command', line });
  }
  return raw;
}

/**
 * 2) expandProgram → array di stringhe G-code
 */
function expandProgram(raw) {
  const labels = {};
  raw.forEach((r, idx) => {
    if (r.type === 'label') labels[r.name] = idx;
  });

  const vars = {};
  const commands = [];
  let i = 0;
  let cycleParams = null;

  while (i < raw.length) {
    const r = raw[i];

    if (r.type === 'label') {
      i++; continue;
    }
    if (r.type === 'assign') {
      // valuta l’espressione
      const expr = r.expr.replace(/R(\d+)/g, (_, n) => vars['R'+n] || 0);
      // eslint-disable-next-line no-eval
      vars[r.varName] = eval(expr);
      i++; continue;
    }
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
      i = cond ? (labels[r.target] || i+1) : i+1;
      continue;
    }
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
      i++; continue;
    }
    if (r.type === 'command') {
      const line = r.line;

      // MCALL CYCLE…(a,b,c,d,…)
      const m1 = line.match(/^(?:MCALL\s+)?CYCLE\d+\s*\(\s*([^)]+)\)/i);
      if (m1) {
        const p = m1[1].split(',').map(v => parseFloat(v) || 0);
        cycleParams = {
          approach: p[0],
          plane:    p[1],
          safety:   p[2],
          depth:    p[3]
        };
        i++; continue;
      }

      // X… Y… subito dopo MCALL → espandi il drill-cycle
      const m2 = line.match(/^X([-\d.]+)\s+Y([-\d.]+)/i);
      if (cycleParams && m2) {
        const x = parseFloat(m2[1]);
        const y = parseFloat(m2[2]);
        const { approach, plane, safety, depth } = cycleParams;

        commands.push(`G0 Z${approach}`);
        commands.push(`G0 X${x} Y${y}`);
        commands.push(`G0 Z${plane + safety}`);
        commands.push(`G1 Z${depth}`);
        commands.push(`G0 Z${approach}`);
        cycleParams = null;    // ⬅️ resetto subito, così lo espando solo una volta
        i++; continue;
      }

      // nuova MCALL interrompe il ciclo
      if (/^MCALL\b/i.test(line)) {
        cycleParams = null;
        i++; continue;
      }

      // altrimenti emetti il G-code così com’è
      commands.push(line);
      i++; continue;
    }

    // fallback
    i++;
  }

  return commands;
}

/**
 * 3) computeMillTime → secondi totali
 */
function computeMillTime(cmdLines) {


  

// ← Qui inizia il body di computeMillTime
  console.log('--- computeMillTime inizio, righe da processare:', cmdLines.length);
  cmdLines.forEach((l, i) => {
    console.log(`  [${i}] ${l}`);
  });



  
  const RAPID = 10000; // mm/min
  let pos = { X: 0, Y: 0, Z: 0, B: 0 };
  let feed = 0;
  let tMin = 0;

  for (const line of cmdLines) {
    const parts = line.split(/\s+/);
    const code  = parts[0].toUpperCase();
    const args  = {};

    // estraggo parametri
  for (let j = 1; j < parts.length; j++) {
    const p = parts[j];

    // ——— Punto 2: riconoscimento I=AC(...) e J=AC(...) ———
    const acMatch = /^([IJ])=AC\(([-\d.]+)\)$/i.exec(p);
    if (acMatch) {
      // acMatch[1] è "I" o "J", acMatch[2] è il numero dentro la parentesi
      args[acMatch[1]] = parseFloat(acMatch[2]);
      continue;
    }
    // ————————————————————————————————————————————————

    // il parsing normale per tutti gli altri parametri
    const k = p[0].toUpperCase();
    const v = parseFloat(p.slice(1));
    if (!isNaN(v)) args[k] = v;
  }


    // aggiorno feed se presente
    if (args.F != null) feed = args.F;

    // G0 rapido
    if (code === 'G0' || code === 'G00') {
      const dx = (args.X ?? pos.X) - pos.X;
      const dy = (args.Y ?? pos.Y) - pos.Y;
      const dz = (args.Z ?? pos.Z) - pos.Z;
      const d = Math.max(Math.abs(dx),Math.abs(dy),Math.abs(dz));
      tMin += d/RAPID;
      pos = { ...pos, X: args.X ?? pos.X, Y: args.Y ?? pos.Y, Z: args.Z ?? pos.Z };
      continue;
    }

    // G1 avanzamento lineare
    if (code === 'G1' || code === 'G01') {
      const dx = (args.X ?? pos.X) - pos.X;
      const dy = (args.Y ?? pos.Y) - pos.Y;
      const dz = (args.Z ?? pos.Z) - pos.Z;
      const d  = Math.hypot(dx, dy, dz);
      if (feed > 0) tMin += d / feed;
      pos = { ...pos, X: args.X ?? pos.X, Y: args.Y ?? pos.Y, Z: args.Z ?? pos.Z };
      continue;
    }

    // G2/G3 circolare in XY (ignoro Z)
    if (code === 'G2' || code === 'G3') {
      const x0 = pos.X, y0 = pos.Y;
      const xc = (args.I ?? 0) + x0, yc = (args.J ?? 0) + y0;
      const r  = Math.hypot(x0 - xc, y0 - yc);
      const x1 = args.X ?? pos.X, y1 = args.Y ?? pos.Y;
      let dθ   = Math.atan2(y1 - yc, x1 - xc) - Math.atan2(y0 - yc, x0 - xc);
      if (code === 'G2' && dθ > 0) dθ -= 2 * Math.PI;
      if (code === 'G3' && dθ < 0) dθ += 2 * Math.PI;
      const arc = Math.abs(r * dθ);
      if (feed > 0) tMin += arc / feed;
      pos.X = x1; pos.Y = y1;
      continue;
    }

    // G4 dwell P (in secondi)
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

    // ignoro altri M-codes
  }

  return tMin * 60; // in secondi
}

module.exports = { parseISO, expandProgram, computeMillTime };
