// parser-mill.js – parser per centro di lavoro con drill-cycles Siemens

/**
 * 1) parseISO → array di { type, ... }
 *    - ignora numeri di blocco Nxxx/Oxxx
 *    - elimina commenti dopo ';' o '('
 */
function parseISO(text) {
  const raw = [];
  for (let line of text.split(/\r?\n/)) {
    // rimuovi commenti
    line = line.split(/;|\(/)[0];
    // ignora numeri di blocco
    line = line.replace(/^[NO]\d+\s*/i, '').trim();
    if (!line) continue;

    // label: PASS_Z: SBAVA2:
    const lbl = line.match(/^([A-Z_]\w*):$/i);
    if (lbl) {
      raw.push({ type: 'label', name: lbl[1] });
      continue;
    }

    // assign: R1=...
    const asg = line.match(/^R(\d+)\s*=\s*(.+)$/i);
    if (asg) {
      raw.push({ type: 'assign', varName: 'R' + asg[1], expr: asg[2] });
      continue;
    }

    // conditional jump
    const iff = line.match(/^IF\s+([Rr]\d+)\s*(>=|<=|==|>|<)\s*([\d.-]+)\s+GOTOB\s+([A-Z_]\w*)$/i);
    if (iff) {
      raw.push({
        type:    'if',
        varName: iff[1].toUpperCase(),
        operator: iff[2],
        value:   parseFloat(iff[3]),
        target:  iff[4]
      });
      continue;
    }

    // repeat block
    const rep = line.match(/^REPEAT\s+([A-Z_]\w*)\s+P=(\d+)$/i);
    if (rep) {
      raw.push({ type: 'repeat', block: rep[1], count: parseInt(rep[2], 10) });
      continue;
    }

    // command (include MCALL, G0, G1, G2/3, G4, etc.)
    raw.push({ type: 'command', line });
  }
  return raw;
}

/**
 * 2) expandProgram → array di G-code semplificati
 *    - espandi drill-cycle Siemens: MCALL CYCLE81..89(params)
 *    - ignora S e F qui, letti in computeMillTime
 *    - genera G0/G1 per ogni X/Y del ciclo
 */
function expandProgram(raw) {
  const labels = {};
  raw.forEach((r, i) => { if (r.type === 'label') labels[r.name] = i; });

  const vars = {};
  const cmds = [];
  let i = 0;
  let cycle = null;  // { approach, plane, safety, depth }

  while (i < raw.length) {
    const r = raw[i];
    switch (r.type) {
      case 'label':
        i++;
        break;
      case 'assign': {
        const expr = r.expr.replace(/R(\d+)/g, (_, n) => vars['R' + n] || 0);
        // eslint-disable-next-line no-eval
        vars[r.varName] = eval(expr);
        i++;
        break;
      }
      case 'if': {
        const v = vars[r.varName] || 0;
        let ok = false;
        switch (r.operator) {
          case '>=': ok = v >= r.value; break;
          case '<=': ok = v <= r.value; break;
          case '==': ok = v === r.value; break;
          case '>':  ok = v >  r.value; break;
          case '<':  ok = v <  r.value; break;
        }
        i = ok ? (labels[r.target] || i + 1) : i + 1;
        break;
      }
      case 'repeat': {
        const start = labels[r.block];
        const end   = labels['ENDLABEL'] || raw.length;
        for (let c = 0; c < r.count; c++) {
          for (let j = start; j < end; j++) {
            if (raw[j].type === 'command') {
              cmds.push(raw[j].line);
            }
          }
        }
        i++;
        break;
      }
      case 'command': {
        const line = r.line;

        // inizio drill-cycle (solo CYCLE81–CYCLE89)
        const m1 = line.match(/^MCALL\s+CYCLE8[1-9]\s*\(\s*([^)]+)\)/i);
        if (m1) {
          // PRIMA modifica: usa il gruppo 1, non il 2!
          const parts = m1[1].split(',').map(v => parseFloat(v) || 0);
          cycle = {
            approach: parts[0],
            plane:    parts[1],
            safety:   parts[2],
            depth:    parts[3]
          };
          i++;
          break;
        }

        // fine drill-cycle: solo "MCALL"
        if (/^MCALL\s*$/i.test(line)) {
          cycle = null;
          i++;
          break;
        }

        // se dentro ciclo e linea XY
        const m2 = line.match(/^X([-\d.]+)\s+Y([-\d.]+)/i);
        if (cycle && m2) {
          const x = parseFloat(m2[1]);
          const y = parseFloat(m2[2]);
          cmds.push(`G0 Z${cycle.approach}`);
          cmds.push(`G0 X${x} Y${y}`);
          cmds.push(`G0 Z${cycle.plane + cycle.safety}`);
          cmds.push(`G1 Z${cycle.depth}`);
          cmds.push(`G0 Z${cycle.approach}`);
          i++;
          break;
        }

        // altrimenti comando generico
        cmds.push(line);
        i++;
        break;
      }
    }
  }

  return cmds;
}

/**
 * 3) computeMillTime → secondi totali
 *    legge G0, G1, G2/G3, G4, e rotazione B
 */
function computeMillTime(cmdLines) {
  const RAPID = 10000; // mm/min
  let pos = { X: 0, Y: 0, Z: 0, B: 0 }, feed = 0;
  let t = 0;

  for (const line of cmdLines) {
    const parts = line.split(/\s+/);
    const code  = parts[0].toUpperCase();
    const args  = {};

    // estraggo parametri
    for (let j = 1; j < parts.length; j++) {
      const p = parts[j];
      const k = p[0].toUpperCase();
      const v = parseFloat(p.slice(1));
      if (!isNaN(v)) args[k] = v;
    }
    if (args.F != null) feed = args.F;

    switch (code) {
      case 'G0':
      case 'G00': {
        const dx = (args.X ?? pos.X) - pos.X;
        const dy = (args.Y ?? pos.Y) - pos.Y;
        const dz = (args.Z ?? pos.Z) - pos.Z;
        const d  = Math.hypot(dx, dy, dz);
        t += d / RAPID;
        pos = { X: args.X ?? pos.X, Y: args.Y ?? pos.Y, Z: args.Z ?? pos.Z, B: pos.B };
        break;
      }
      case 'G1':
      case 'G01': {
        const dx = (args.X ?? pos.X) - pos.X;
        const dy = (args.Y ?? pos.Y) - pos.Y;
        const dz = (args.Z ?? pos.Z) - pos.Z;
        const d  = Math.hypot(dx, dy, dz);
        if (feed > 0) t += d / feed;
        pos = { X: args.X ?? pos.X, Y: args.Y ?? pos.Y, Z: args.Z ?? pos.Z, B: pos.B };
        break;
      }
      case 'G2':
      case 'G3': {
        const x0 = pos.X, y0 = pos.Y;
        const xc = (args.I ?? 0) + x0;
        const yc = (args.J ?? 0) + y0;
        const r  = Math.hypot(x0 - xc, y0 - yc);
        const x1 = args.X ?? pos.X;
        const y1 = args.Y ?? pos.Y;
        let dth = Math.atan2(y1 - yc, x1 - xc) - Math.atan2(y0 - yc, x0 - xc);
        if (code === 'G2' && dth > 0) dth -= 2 * Math.PI;
        if (code === 'G3' && dth < 0) dth += 2 * Math.PI;
        const arc = Math.abs(r * dth);
        if (feed > 0) t += arc / feed;
        pos.X = x1; pos.Y = y1;
        break;
      }
      case 'G4':
      case 'G04': {
        const sec = args.P ?? 0;
        t += sec / 60;
        break;
      }
      default: {
        if (args.B != null) {
          let delta = ((args.B - pos.B + 180) % 360) - 180;
          delta = Math.abs(delta);
          t += (delta / 30) / 60;
          pos.B = args.B;
        }
      }
    }
  }

  return t * 60; // secondi
}

module.exports = { parseISO, expandProgram, computeMillTime };
