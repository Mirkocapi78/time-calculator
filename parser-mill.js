// parser-mill.js – parser per centro di lavoro con drill-cycles Siemens

/**
 * 1) parseISO → array di { type, ... }
 *    - ignora numeri di blocco Nxxx/Oxxx
 *    - elimina commenti dopo ';' o '('
 */
function parseISO(text) {
  const raw = [];
  for (let rawLine of text.split(/\r?\n/)) {
    // 1.a) rimuovi commenti
    let line = rawLine.split(/;|\(/)[0].trim();
    // 1.b) ignora prefisso N123 o O123
    line = line.replace(/^[NO]\d+\s*/i, '').trim();
    if (!line) continue;

    // label: PASS_Z: o SBAVA2:
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

    // conditional jump: IF R1>=-6 GOTOB PASS_Z
    const iff = line.match(
      /^IF\s+([Rr]\d+)\s*(>=|<=|==|>|<)\s*([-\d.]+)\s+GOTOB\s+([A-Z_]\w*)$/i
    );
    if (iff) {
      raw.push({
        type: 'if',
        varName: iff[1].toUpperCase(),
        operator: iff[2],
        value: parseFloat(iff[3]),
        target: iff[4]
      });
      continue;
    }

    // repeat block: REPEAT SBAVA2 P=1
    const rep = line.match(/^REPEAT\s+([A-Z_]\w*)\s+P=(\d+)/i);
    if (rep) {
      raw.push({ type: 'repeat', block: rep[1], count: parseInt(rep[2], 10) });
      continue;
    }

    // altrimenti è un G-code generico (inclusi MCALL… e G0/G1/G2…)
    raw.push({ type: 'command', line });
  }
  return raw;
}

/**
 * 2) expandProgram → array di G-code semplificati
 *    - espande i drill-cycle Siemens
 *    - trasforma ogni X Y all'interno di un ciclo in un piccolo sottoprogramma
 */
function expandProgram(raw) {
  const labels = {};
  raw.forEach((r, idx) => {
    if (r.type === 'label') labels[r.name] = idx;
  });

  const vars = {};
  const cmds = [];
  let i = 0;
  let cycle = null;  // { approach, plane, safety, depth }

  while (i < raw.length) {
    const r = raw[i];

    if (r.type === 'label') {
      i++;
      continue;
    }
    if (r.type === 'assign') {
      // valuta l’espressione con le variabili correnti
      const expr = r.expr.replace(/R(\d+)/g, (_, n) => vars['R' + n] || 0);
      // eslint-disable-next-line no-eval
      vars[r.varName] = eval(expr);
      i++;
      continue;
    }
    if (r.type === 'if') {
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
      continue;
    }
    if (r.type === 'repeat') {
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
      continue;
    }
    if (r.type === 'command') {
      const line = r.line.trim();

      // inizio ciclo: MCALL CYCLE8[1-9](approach,plane,safety,depth,…)
      const m1 = line.match(/^MCALL\s+CYCLE(8[1-9])\s*\(\s*([^)]+)\)/i);
      if (m1) {
        const parts = m1[2].split(',').map(v => parseFloat(v) || 0);
        cycle = {
          approach: parts[0],
          plane:    parts[1],
          safety:   parts[2],
          depth:    parts[3]
        };
        i++;
        continue;
      }

      // fine ciclo: MCALL senza parentesi
      if (/^MCALL$/i.test(line)) {
        cycle = null;
        i++;
        continue;
      }

      // se siamo dentro un ciclo e troviamo X… Y…
      const m2 = cycle && line.match(/^X([-\d.]+)\s+Y([-\d.]+)/i);
      if (m2) {
        const x = parseFloat(m2[1]), y = parseFloat(m2[2]);
        // espandi la sequenza di foratura
        cmds.push(`G0 Z${cycle.approach}`);
        cmds.push(`G0 X${x} Y${y}`);
        cmds.push(`G0 Z${cycle.plane + cycle.safety}`);
        cmds.push(`G1 Z${cycle.depth}`);
        cmds.push(`G0 Z${cycle.approach}`);
        i++;
        continue;
      }

      // altrimenti emetti il G-code così com’è
      cmds.push(line);
      i++;
      continue;
    }

    // fallback
    i++;
  }

  return cmds;
}

/**
 * 3) computeMillTime → secondi totali
 *    - G0, G1, G2/G3, G4, rotazione asse B
 */
function computeMillTime(cmdLines) {
  const RAPID = 10000; // mm/min ai rapidi
  let pos  = { X: 0, Y: 0, Z: 0, B: 0 };
  let feed = 0;
  let tMin = 0;

  for (const line of cmdLines) {
    const parts = line.split(/\s+/);
    const code  = parts[0].toUpperCase();
    const args  = {};

    // estraggo eventuali parametri (X,Y,Z,I,J,F,B,P,…)
    for (let j = 1; j < parts.length; j++) {
      const p = parts[j];
      const k = p[0].toUpperCase();
      const v = parseFloat(p.slice(1));
      if (!isNaN(v)) args[k] = v;
    }
    // aggiorno avanzamento se presente
    if (args.F != null) feed = args.F;

    // G0 rapido
    if (code === 'G0' || code === 'G00') {
      const dx = (args.X ?? pos.X) - pos.X;
      const dy = (args.Y ?? pos.Y) - pos.Y;
      const dz = (args.Z ?? pos.Z) - pos.Z;
      const d  = Math.hypot(dx, dy, dz);
      tMin += d / RAPID;
      pos = {
        X: args.X ?? pos.X,
        Y: args.Y ?? pos.Y,
        Z: args.Z ?? pos.Z,
        B: pos.B
      };
      continue;
    }

    // G1 avanzamento lineare
    if (code === 'G1' || code === 'G01') {
      const dx = (args.X ?? pos.X) - pos.X;
      const dy = (args.Y ?? pos.Y) - pos.Y;
      const dz = (args.Z ?? pos.Z) - pos.Z;
      const d  = Math.hypot(dx, dy, dz);
      if (feed > 0) tMin += d / feed;
      pos = {
        X: args.X ?? pos.X,
        Y: args.Y ?? pos.Y,
        Z: args.Z ?? pos.Z,
        B: pos.B
      };
      continue;
    }

    // G2/G3 interpolazione circolare in XY (ignoro Z)
    if (code === 'G2' || code === 'G3') {
      const x0 = pos.X, y0 = pos.Y;
      const xc = (args.I ?? 0) + x0;
      const yc = (args.J ?? 0) + y0;
      const r  = Math.hypot(x0 - xc, y0 - yc);
      const x1 = args.X ?? pos.X, y1 = args.Y ?? pos.Y;
      let dθ   =
        Math.atan2(y1 - yc, x1 - xc) -
        Math.atan2(y0 - yc, x0 - xc);
      if (code === 'G2' && dθ > 0)  dθ -= 2 * Math.PI;
      if (code === 'G3' && dθ < 0)  dθ += 2 * Math.PI;
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

    // rotazione asse B (360° in 12 s → 30°/s)
    if (args.B != null) {
      let delta = ((args.B - pos.B + 180) % 360) - 180;
      delta = Math.abs(delta);
      tMin += (delta / 30) / 60;
      pos.B = args.B;
    }
  }

  return tMin * 60; // restituisci in secondi
}

module.exports = { parseISO, expandProgram, computeMillTime };
