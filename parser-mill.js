// parser-mill.js – parser per centro di lavoro con gestione di etichette, IF/GOTOB, loop e calcolo tempi

/**
 * 1) parseISO: trasforma il testo ISO in un array di oggetti { type, data }
 *  - type: 'label', 'assign', 'if', 'repeat', 'command'
 *  - data: dipende dal type
 */
function parseISO(text) {
  const lines = text.split(/\r?\n/);
  const raw = [];
  for (let rawLine of lines) {
    let line = rawLine.split(/;|\(/)[0].trim();
    if (!line) continue;
    // Label definition (es: SBAVA2:)
    const labelMatch = line.match(/^([A-Z_]\w*):$/i);
    if (labelMatch) {
      raw.push({ type: 'label', name: labelMatch[1] });
      continue;
    }
    // Variable assignment (es: R1=R1-0.25)
    const assignMatch = line.match(/^R(\d+)\s*=\s*(.+)$/i);
    if (assignMatch) {
      raw.push({ type: 'assign', varName: 'R' + assignMatch[1], expr: assignMatch[2] });
      continue;
    }
    // Conditional jump (es: IF R1>=-6 GOTOB PASS_Z)
    const ifMatch = line.match(/^IF\s+([Rr]\d+)\s*(>=|<=|==|>|<)\s*([\d.-]+)\s+GOTOB\s+([A-Z_]\w*)$/i);
    if (ifMatch) {
      raw.push({
        type: 'if',
        varName: ifMatch[1].toUpperCase(),
        operator: ifMatch[2],
        value: parseFloat(ifMatch[3]),
        target: ifMatch[4]
      });
      continue;
    }
    // Repeat loop (es: REPEAT SBAVA2 P=1)
    const repMatch = line.match(/^REPEAT\s+([A-Z_]\w*)\s+P=(\d+)/i);
    if (repMatch) {
      raw.push({ type: 'repeat', block: repMatch[1], count: parseInt(repMatch[2], 10) });
      continue;
    }
    // G-code command
    raw.push({ type: 'command', line });
  }
  return raw;
}

/**
 * 2) expandProgram: pre-elabora label, variabili, IF/GOTOB e REPEAT
 *    restituisce array di soli comandi da mandare al calcolo tempo
 */
function expandProgram(raw) {
  const labels = {};
  // prima passata: registra le etichette
  raw.forEach((r, idx) => { if (r.type === 'label') labels[r.name] = idx; });

  const vars = {}; // es: { R1: 0, R2: 0 }
  let i = 0;
  const commands = [];

  while (i < raw.length) {
    const r = raw[i];
    if (r.type === 'label') {
      i++; continue;
    }
    if (r.type === 'assign') {
      // valuta l'espressione con le variabili correnti
      const expr = r.expr.replace(/R(\d+)/g, (m, n) => vars['R'+n] || 0);
      vars[r.varName] = eval(expr);
      i++; continue;
    }
    if (r.type === 'if') {
      const v = vars[r.varName] || 0;
      let cond = false;
      switch (r.operator) {
        case '>=': cond = v >= r.value; break;
        case '<=': cond = v <= r.value; break;
        case '>':  cond = v >  r.value; break;
        case '<':  cond = v <  r.value; break;
        case '==': cond = v === r.value; break;
      }
      if (cond) {
        i = labels[r.target] || i+1;
      } else {
        i++;
      }
      continue;
    }
    if (r.type === 'repeat') {
      // copia block r.block count volte
      const start = labels[r.block + ''];
      const end = labels['ENDLABEL'] || raw.length;
      for (let k = 0; k < r.count; k++) {
        for (let j = start; j < end; j++) {
          if (raw[j].type === 'command') commands.push(raw[j].line);
        }
      }
      i++;
      continue;
    }
    if (r.type === 'command') {
      commands.push(r.line);
      i++;
      continue;
    }
    i++;
  }
  return commands;
}

/**
 * 3) computeMillTime: calcola il tempo totale di lavorazione
 *    gestisce G0, G1, G2/G3 su XY e Z, rotazione asse B, G4 dwell
 */
function computeMillTime(cmdLines) {
  let pos = { X:0, Y:0, Z:0, B:0 };
  let feed = 0, rpm = 0;
  let tMin = 0;
  const RAPID = 10000;

  for (const line of cmdLines) {
    const parts = line.split(/\s+/);
    const code = parts[0];
    const args = {};
    parts.slice(1).forEach(p => {
      const k = p[0], v = parseFloat(p.slice(1));
      if (!isNaN(v)) args[k] = v;
    });

    // G0 rapid
    if (code === 'G0' || code === 'G00') {
      const dx = (args.X||pos.X) - pos.X;
      const dy = (args.Y||pos.Y) - pos.Y;
      const dz = (args.Z||pos.Z) - pos.Z;
      const dist = Math.hypot(dx, dy, dz);
      tMin += dist / RAPID;
      pos.X = args.X||pos.X;
      pos.Y = args.Y||pos.Y;
      pos.Z = args.Z||pos.Z;
      continue;
    }

    // G1 linear feed
    if (code === 'G1' || code === 'G01') {
      const dx = (args.X||pos.X) - pos.X;
      const dy = (args.Y||pos.Y) - pos.Y;
      const dz = (args.Z||pos.Z) - pos.Z;
      const dist = Math.hypot(dx, dy, dz);
      feed = args.F||feed;
      if (feed > 0) tMin += dist / feed;
      pos.X = args.X||pos.X;
      pos.Y = args.Y||pos.Y;
      pos.Z = args.Z||pos.Z;
      continue;
    }

    // G2/G3 circular in XY
    if (code === 'G2' || code === 'G3') {
      // semplice: calcola raggio/angolo in XY ignorando Z
      const x0 = pos.X, y0 = pos.Y;
      const xc = (args.I||0) + x0;
      const yc = (args.J||0) + y0;
      const r  = Math.hypot(x0-xc, y0-yc);
      const x1 = args.X||pos.X, y1 = args.Y||pos.Y;
      let dθ = Math.atan2(y1-yc, x1-xc) - Math.atan2(y0-yc, x0-xc);
      if (code==='G2' && dθ>0) dθ -= 2*Math.PI;
      if (code==='G3' && dθ<0) dθ += 2*Math.PI;
      const arc = Math.abs(r * dθ);
      feed = args.F||feed;
      if (feed > 0) tMin += arc / feed;
      pos.X = x1; pos.Y = y1;
      continue;
    }

    // G4 dwell P in seconds
    if (code === 'G4' || code === 'G04') {
      const sec = args.P||0;
      tMin += sec/60;
      continue;
    }

    // Rotazione B (360° in 12s -> 30°/s)
    if (args.B != null) {
      let delta = ((args.B - pos.B + 180) % 360) - 180;
      delta = Math.abs(delta);
      tMin += (delta / 30)/60;
      pos.B = args.B;
      continue;
    }

    // Ignoro altri comandi (e.g. M-codes)
  }
  return tMin * 60; // secondi
}

module.exports = { parseISO, expandProgram, computeMillTime };
