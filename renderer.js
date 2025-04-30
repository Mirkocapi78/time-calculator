document.getElementById('fileInput').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    const text = e.target.result;
    const lines = text.split(/\r?\n/);
    const velG0 = parseFloat(document.getElementById('velocitaG0').value);
    const tipoAv = document.getElementById('tipoAvanzamento').value;

    let tempoTotale = 0;

    for (const line of lines) {
      const cleaned = line.trim().toUpperCase();
      const gcode = cleaned.match(/G0?0|G0?1/);
      const x = parseFloat((cleaned.match(/X([-+]?[0-9]*\.?[0-9]+)/) || [])[1]);
      const z = parseFloat((cleaned.match(/Z([-+]?[0-9]*\.?[0-9]+)/) || [])[1]);
      const f = parseFloat((cleaned.match(/F([-+]?[0-9]*\.?[0-9]+)/) || [])[1]);

      if (gcode && (!isNaN(x) || !isNaN(z))) {
        const distanza = Math.sqrt((x || 0)**2 + (z || 0)**2);
        let tempo = 0;
        if (gcode[0] === 'G0' || gcode[0] === 'G00') {
          tempo = distanza / velG0;
        } else if ((gcode[0] === 'G1' || gcode[0] === 'G01') && !isNaN(f)) {
          tempo = tipoAv === 'mm/min' ? distanza / f : distanza / (f * 1); // semplificato
        }
        tempoTotale += tempo;
      }
    }

    document.getElementById('output').innerText = `Tempo stimato: ${tempoTotale.toFixed(2)} minuti`;
  };
  reader.readAsText(file);
});
