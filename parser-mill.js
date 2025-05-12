// parser-mill.js – parser per centro di lavoro con drill‐cycles Siemens

/**
 * 1) parseISO → array di { type, ... }
 */
function parseISO(text) {
  const raw = [];
  for (const rawLine of text.split(/\r?\n/)) {
    // 1) taglio i commenti (tutto dopo ‘;’)
    let line = rawLine.split(';')[0];
    // 2) tolgo il prefisso N123 o O123 e ripulisco spazi
    line = line.replace(/^[NO]\d+\s*/i, '').trim();
    // 3) se dopo tutto è vuota, salto
    if (!line) continue;

    // …qui riprende il tuo parsing dei comandi…
    // es: riconoscimento MCALL, label, assign, command, ecc.
    const m = line.match(/MCALL\s+CYCLE\d+\s*\([^)]+\)/i);
    if (m) {
      raw.push({ type: 'command', line: m[0] });
      continue;
    }
    // …
  }
  return raw;
}

   // 1.b) altrimenti rimuovi solo tutto ciò che sta dopo ';' (commenti)
    line = line.split(';')[0].trim();
    line = line.replace(/^[NO]\d+\s*/i, '');
    if (!line) continue;

    // Label
    const lbl = line.match(/^([A-Z_]\w*):$/i);
    if (lbl) {
      raw.push({ type: 'label', name: lbl[1] });
      continue;
    }

    // Assign
    const asg = line.match(/^R(\d+)\s*=\s*(.+)$/i);
    if (asg) {
      raw.push({
        type:    'assign',
        varName: 'R' + asg[1],
        expr:    asg[2]
      });
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
      raw.push({
        type:  'repeat',
        block: rep[1],
        count: parseInt(rep[2], 10)
      });
      continue;
    }

    // Altrimenti è un G-code generico
    raw.push({ type: 'command', line: line.trim() });
  }
  return raw;
}

/**
 * 2) expandProgram → array di stringhe G-code
 */
function expandProgram(raw) {
  // salva le label
  const labels = {};
  raw.forEach((r, i) => {
    if (r.type === 'label') labels[r.name] = i;
  });

  const vars     = {};
  const commands= [];
  let i = 0;

  // stato drill‐cycle
  let cycleParams = null;

  while (i < raw.length) {
    const r = raw[i];

    if (r.type === 'label') {
      i++; continue;
    }
    if (r.type === 'assign') {
      const expr = r.expr.replace(/R(\d+)/g, (_,n) => vars['R'+n]||0);
      // eslint-disable-next-line no-eval
      vars[r.varName] = eval(expr);
      i++; continue;
    }
    if (r.type === 'if') {
      const v = vars[r.varName]||0;
      let ok = false;
      switch (r.operator) {
        case '>=': ok = v>=r.value; break;
        case '<=': ok = v<=r.value; break;
        case '==': ok = v===r.value;break;
        case '>':  ok = v> r.value; break;
        case '<':  ok = v< r.value; break;
      }
      i = ok ? (labels[r.target]||i+1) : i+1;
      continue;
    }
    if (r.type === 'repeat') {
      const start = labels[r.block];
      const end   = labels['ENDLABEL']||raw.length;
      for (let k=0;k<r.count;k++){
        for (let j=start;j<end;j++){
          if (raw[j].type==='command'){
            commands.push(raw[j].line);
          }
        }
      }
      i++; continue;
    }
    if (r.type === 'command') {
      const line = r.line;

      // MCALL CYCLE…(a,b,c,d,…)
      const m1 = line.match(/^MCALL\s+CYCLE\d+\s*\(\s*([^)]+)\)/i);
      if (m1) {
        const p = m1[1].split(',').map(v=>parseFloat(v)||0);
        cycleParams = {
          approach: p[0],
          plane:    p[1],
          safety:   p[2],
          depth:    p[3]
        };
        i++; continue;
      }

      // X… Y… subito dopo MCALL → espandi foratura
      const m2 = line.match(/X([-\d.]+)\s+Y([-\d.]+)/i);
      if (cycleParams && m2) {
        const x = parseFloat(m2[1]);
        const y = parseFloat(m2[2]);
        const { approach, plane, safety, depth } = cycleParams;

        commands.push(`G0 Z${approach}`);
        commands.push(`G0 X${x} Y${y}`);
        commands.push(`G0 Z${plane + safety}`);
        commands.push(`G1 Z${depth}`);
        commands.push(`G0 Z${approach}`);

        i++; continue;
      }

      // nuova MCALL interrompe
      if (/^MCALL\b/i.test(line)) {
        cycleParams = null;
        i++; continue;
      }

      // altrimenti emetti
      commands.push(line);
      i++; continue;
    }
    i++;
  }

  return commands;
}

/**
 * 3) computeMillTime → secondi totali
 */
function computeMillTime(cmdLines) {
  const RAPID = 10000; // mm/min
  let pos = { X:0, Y:0, Z:0, B:0 };
  let feed = 0;
  let tMin = 0;

  for (const line of cmdLines) {
    const parts = line.split(/\s+/);
    const code  = parts[0].toUpperCase();
    const args  = {};

    for (let j=1;j<parts.length;j++){
      const p = parts[j];
      const k = p[0].toUpperCase();
      const v = parseFloat(p.slice(1));
      if (!isNaN(v)) args[k] = v;
    }
     if (args.F != null) {
       feed = args.F;
     }
    
    if (code==='G0'||code==='G00') {
      const dx = (args.X??pos.X)-pos.X;
      const dy = (args.Y??pos.Y)-pos.Y;
      const dz = (args.Z??pos.Z)-pos.Z;
      const d  = Math.hypot(dx,dy,dz);
      tMin += d/RAPID;
      pos.X = args.X??pos.X; pos.Y = args.Y??pos.Y; pos.Z = args.Z??pos.Z;
      continue;
    }
    if (code==='G1'||code==='G01') {
      const dx = (args.X??pos.X)-pos.X;
      const dy = (args.Y??pos.Y)-pos.Y;
      const dz = (args.Z??pos.Z)-pos.Z;
      const d  = Math.hypot(dx,dy,dz);
      if (feed>0) tMin += d/feed;
      pos.X = args.X??pos.X; pos.Y = args.Y??pos.Y; pos.Z = args.Z??pos.Z;
      continue;
    }
    if (code==='G2'||code==='G3') {
      const x0 = pos.X, y0 = pos.Y;
      const xc = (args.I??0)+x0, yc = (args.J??0)+y0;
      const r  = Math.hypot(x0-xc,y0-yc);
      const x1 = args.X??pos.X, y1 = args.Y??pos.Y;
      let dθ   = Math.atan2(y1-yc,x1-xc)-Math.atan2(y0-yc,x0-xc);
      if (code==='G2'&&dθ>0) dθ-=2*Math.PI;
      if (code==='G3'&&dθ<0) dθ+=2*Math.PI;
      const arc = Math.abs(r*dθ);
      feed = args.F??feed;
      if (feed>0) tMin += arc/feed;
      pos.X=x1; pos.Y=y1;
      continue;
    }
    if (code==='G4'||code==='G04') {
      const sec = args.P??0;
      tMin += sec/60;
      continue;
    }
    if (args.B!=null) {
      let delta = ((args.B-pos.B+180)%360)-180; delta=Math.abs(delta);
      tMin += (delta/30)/60;
      pos.B=args.B;
      continue;
    }
    // ignora M-codes
  }

  return tMin*60;  // secondi
}

module.exports = { parseISO, expandProgram, computeMillTime };
