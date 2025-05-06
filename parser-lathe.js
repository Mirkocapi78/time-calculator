// parser-lathe.js  – versione “modal” completa

function parseISO(text) {
  const cmds = [];
  let state = {             // valori modali
    code: 'G0',             // movimento
    feedMode: 'G95',        // mm/giro (default tornado)
  };

  for (let raw of text.split(/\r?\n/)) {
    let line = raw.split(/;|\(/)[0].trim();
    line = line.replace(/^[NO]\d+\s*/i, '');
    if (!line) continue;

    const parts = line.toUpperCase().split(/\s+/);
    let token0 = parts[0];

    // se il primo token è G-/M-code, aggiorna lo stato modale
    if (/^[GM]\d+/.test(token0)) {
      const c = token0.replace(/^G0([0-4])$/, 'G$1');   // G00→G0 ecc.
      if (/^G0[1234]|^G[01234]/.test(c)) state.code     = c.replace('G00','G0').replace('G01','G1')
                                                          .replace('G02','G2').replace('G03','G3')
                                                          .replace('G04','G4');
      else if (c === 'G94' || c === 'G95') state.feedMode = c;
      else if (c === 'G96' || c === 'G97') state.speedMode = c;
      else if (c === 'M3')                  state.speedMode = 'G97';
      parts.shift();                       // rimuovi il codice dalla riga
    }

    // la riga eredita lo stato corrente
    const cmd = { code: state.code, feedMode: state.feedMode,
                  X:null,Z:null,I:null,K:null,F:null,S:null,P:null,L:null };
    for (const p of parts) {
      const k = p[0];
      const v = parseFloat(p.slice(1));
      if (isNaN(v)) continue;
      if (k==='X') cmd.X=v; else if(k==='Z') cmd.Z=v; else if(k==='I') cmd.I=v;
      else if(k==='K') cmd.K=v; else if(k==='F') cmd.F=v; else if(k==='S') cmd.S=v;
      else if(k==='P') cmd.P=v; else if(k==='L') cmd.L=v;
    }
    cmds.push(cmd);
  }
  return cmds;
}

function arcLen(x0,z0,c){
  const xc=x0+(c.I??0), zc=z0+(c.K??0);
  const r=Math.hypot(x0-xc,z0-zc);
  const x1=c.X??x0, z1=c.Z??z0;
  let d=Math.atan2(z1-zc,x1-xc)-Math.atan2(z0-zc,x0-xc);
  if(c.code==='G2'&&d>0)d-=2*Math.PI;
  if(c.code==='G3'&&d<0)d+=2*Math.PI;
  return Math.abs(r*d);
}

function computeLatheTime(cmds){
  const RAPID=10000;
  let feedRev=0, rpm=0, Vc=0, rpmMax=4000;  // rpmMax default 4000
  let pos={X:0,Z:0}, tMin=0;

  for(const c of cmds){
    // valori modali
    if(c.F!=null) feedRev=c.F;
    if(c.code==='G26'||c.code==='G50'||c.code==='G92') if(c.S!=null) rpmMax=c.S;
    if(c.code==='G97'||c.code==='M3') if(c.S!=null) rpm=Math.min(c.S,rpmMax);
    if(c.code==='G96' && c.S!=null) Vc=c.S;

    // feedMode: se la riga ha token G94/G95 li abbiamo già salvati

    if(c.L) continue;          // cambio utensile → skip

    if(c.code==='G4'){         // dwell
      const sec=c.X??c.F??c.P??0;
      tMin+=sec/60;
      continue;
    }

    // calcola distanze
    let dist=0;
    if(c.code==='G1'||c.code==='G0'){
      dist=Math.hypot((c.X??pos.X)-pos.X,(c.Z??pos.Z)-pos.Z);
    }else if(c.code==='G2'||c.code==='G3'){
      dist=arcLen(pos.X,pos.Z,c);
    }

    if(c.code==='G0'){                         // rapido
      tMin+=dist/RAPID;
    }else if(c.code==='G1'||c.code==='G2'||c.code==='G3'){
      // rpm dinamico se Vc
      if(Vc && pos.X>0){
        rpm=Math.min((1000*Vc)/(Math.PI*pos.X),rpmMax);
      }
      const feedMMmin = (c.feedMode==='G95') ? feedRev*rpm : feedRev; // G94: già mm/min
      if(feedMMmin>0) tMin+=dist/feedMMmin;
    }
    pos={X:c.X??pos.X,Z:c.Z??pos.Z};
  }
  return tMin*60;   // secondi
}

module.exports={parseISO,computeLatheTime};
