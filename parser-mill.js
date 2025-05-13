// parser-mill.js – parser per centro di lavoro con drill‑cycles Siemens e conteggio tempi G0/G1/G2/G3/G4/B

/**
 * 1) parseISO(text): trasforma il testo ISO in un array di oggetti { type, ... }
 */
function parseISO(text) {
  const raw = [];
  for (let rawLine of text.split(/\r?\n/)) {
    // elimina commenti dopo ';' o '('
    let line = rawLine.split(/;|\(/)[0].trim();
    // rimuovi prefisso N123 o O123
    line = line.replace(/^[NO]\d+\s*/i, '').trim();
    if (!line) continue;

    // etichetta: SBAVA2: o PASS_Z:
    const lbl = line.match(/^([A-Z_]\w*):$/i);
    if (lbl) {
      raw.push({ type: 'label', name: lbl[1] });
      continue;
    }
    // assignment var (es: R1=R1-0.25)
    const asg = line.match(/^R(\d+)\s*=\s*(.+)$/i);
    if (asg) {
      raw.push({ type: 'assign', varName: 'R' + asg[1], expr: asg[2] });
      continue;
    }
    // conditional IF ... GOTOB ...
    const iff = line.match(/^IF\s+([Rr]\d+)\s*(>=|<=|==|>|<)\s*([\d.-]+)\s+GOTOB\s+([A-Z_]\w*)$/i);
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
    // repeat loop: REPEAT SBAVA2 P=1
    const rep = line.match(/^REPEAT\s+([A-Z_]\w*)\s+P=(\d+)/i);
    if (rep) {
      raw.push({ type: 'repeat', block: rep[1], count: parseInt(rep[2], 10) });
      continue;
    }
    // MCALL CYCLExx(a,b,c,d)
    const mc = line.match(/^MCALL\s+CYCLE(\d+)\s*\(([^)]+)\)/i);
    if (mc) {
      raw.push({
        type:   'mcall',
        cycle:  parseInt(mc[1],10),
        params: mc[2].split(',').map(s => parseFloat(s)||0)
      });
      continue;
    }
    // qualsiasi altro G-code
    raw.push({ type: 'command', line });
  }
  return raw;
}

/**
 * 2) expandProgram(raw): risolve label/assign/if/repeat e espande drill‑cycles
 *    restituisce array di stringhe G-code pronte per il calcolo tempo
 */
function expandProgram(raw) {
  const labels = {};
  raw.forEach((r, i) => { if (r.type === 'label') labels[r.name] = i; });

  const vars     = {};
  const commands = [];
  let i = 0;
  let cycleParams = null;

  while (i < raw.length) {
    const r = raw[i];
    switch(r.type) {
      case 'label':
        i++; break;
      case 'assign': {
        const expr = r.expr.replace(/R(\d+)/g, (_,n)=> vars['R'+n]||0);
        // eslint-disable-next-line no-eval
        vars[r.varName] = eval(expr);
        i++; break;
      }
      case 'if': {
        const v = vars[r.varName]||0;
        let ok = false;
        switch(r.operator) {
          case '>=': ok = v>=r.value; break;
          case '<=': ok = v<=r.value; break;
          case '==': ok = v===r.value;break;
          case '>':  ok = v> r.value; break;
          case '<':  ok = v< r.value; break;
        }
        i = ok ? (labels[r.target]||i+1) : i+1;
        break;
      }
      case 'repeat': {
        const start = labels[r.block];
        const end   = labels['ENDLABEL']|| raw.length;
        for (let k=0;k<r.count;k++) {
          for (let j=start;j<end;j++) {
            if (raw[j].type==='command')
              commands.push(raw[j].line);
          }
        }
        i++; break;
      }
      case 'mcall':
        // inizio nuovo drill-cycle, resetto params
        cycleParams = {
          approach: r.params[0],
          plane:    r.params[1],
          safety:   r.params[2],
          depth:    r.params[3]
        };
        i++; break;

      case 'command': {
        const line = r.line;
        // se sto in un ciclo e trovo X.. Y.. allora espando il ciclo
        const m2 = line.match(/^X([-\d.]+)\s+Y([-\d.]+)/i);
        if (cycleParams && m2) {
          const x = parseFloat(m2[1]), y = parseFloat(m2[2]);
          // 1) rapido Z approccio
          commands.push(`G0 Z${cycleParams.approach}`);
          // 2) rapido XY
          commands.push(`G0 X${x} Y${y}`);
          // 3) rapido a plane+safety
          commands.push(`G0 Z${cycleParams.plane + cycleParams.safety}`);
          // 4) foratura in G1 a depth
          commands.push(`G1 Z${cycleParams.depth}`);
          // 5) ritorno rapido a approccio
          commands.push(`G0 Z${cycleParams.approach}`);
          i++; break;
        }
        // altrimenti emetto la riga com'è
        commands.push(line);
        i++; break;
      }
      default:
        i++; break;
    }
  }

  return commands;
}

/**
 * 3) computeMillTime(cmdLines): calcola secondi totali gestendo G0/G1/G2/G3/G4/B
 */
function computeMillTime(cmdLines) {
  const RAPID = 10000; // mm/min
  let pos = { X:0, Y:0, Z:0, B:0 };
  let feed = 0;
  let tMin = 0;

  for (let line of cmdLines) {
    const parts = line.split(/\s+/);
    const code  = parts[0].toUpperCase();
    const args  = {};
    for (let j=1;j<parts.length;j++) {
      const p = parts[j], k = p[0].toUpperCase(), v = parseFloat(p.slice(1));
      if (!isNaN(v)) args[k] = v;
    }
    if (args.F!=null) feed = args.F;

    let delta = 0;
    if (code==='G0'||code==='G00') {
      const dx=(args.X??pos.X)-pos.X;
      const dy=(args.Y??pos.Y)-pos.Y;
      const dz=(args.Z??pos.Z)-pos.Z;
      const d = Math.hypot(dx,dy,dz);
      delta = d / RAPID;
      pos = { X: args.X??pos.X, Y: args.Y??pos.Y, Z: args.Z??pos.Z, B:pos.B };
    }
    else if (code==='G1'||code==='G01') {
      const dx=(args.X??pos.X)-pos.X;
      const dy=(args.Y??pos.Y)-pos.Y;
      const dz=(args.Z??pos.Z)-pos.Z;
      const d  = Math.hypot(dx,dy,dz);
      if (feed>0) delta = d / feed;
      pos = { X: args.X??pos.X, Y: args.Y??pos.Y, Z: args.Z??pos.Z, B:pos.B };
    }
    else if (code==='G2'||code==='G3') {
      // arco in XY (ignora Z)
      const x0=pos.X, y0=pos.Y;
      const xc=(args.I||0)+x0, yc=(args.J||0)+y0;
      const r = Math.hypot(x0-xc,y0-yc);
      const x1=args.X??x0, y1=args.Y??y0;
      let dθ = Math.atan2(y1-yc,x1-xc)-Math.atan2(y0-yc,x0-xc);
      if (code==='G2'&&dθ>0) dθ-=2*Math.PI;
      if (code==='G3'&&dθ<0) dθ+=2*Math.PI;
      const arc = Math.abs(r*dθ);
      if (feed>0) delta = arc / feed;
      pos.X = x1; pos.Y = y1;
    }
    else if (code==='G4'||code==='G04') {
      delta = (args.P||0)/60;
    }
    else if (args.B!=null) {
      let db = ((args.B-pos.B+180)%360)-180;
      db = Math.abs(db);
      delta = (db/30)/60;
      pos.B = args.B;
    }

    tMin += delta;
  }

  return tMin * 60; // secondi
}

module.exports = { parseISO, expandProgram, computeMillTime };
