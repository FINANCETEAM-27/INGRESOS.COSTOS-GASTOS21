const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');

const __norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const __num = v => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.replace(/[^\d.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  }
  return 0;
};
function __date(v) {
  if (v instanceof Date && !isNaN(v)) return [v.getUTCFullYear(), v.getUTCMonth()+1, v.getUTCDate()];
  if (typeof v === 'number' && v > 30000) {
    const d = new Date(Math.round((v - 25569) * 864e5));
    return [d.getUTCFullYear(), d.getUTCMonth()+1, d.getUTCDate()];
  }
  if (typeof v === 'string') {
    let m = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) return [+m[3], +m[2], +m[1]];
    m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return [+m[1], +m[2], +m[3]];
  }
  return null;
}

function parseAux(filePath) {
  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];

  // Recalcular rango en caso de que !ref venga incompleto
  let maxCol = 0, maxRow = 0;
  for (const key of Object.keys(ws)) {
    if (key[0] === '!') continue;
    const cell = XLSX.utils.decode_cell(key);
    if (cell.c > maxCol) maxCol = cell.c;
    if (cell.r > maxRow) maxRow = cell.r;
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } });

  const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  let H = null, hrow = 0;
    for (let i = 0; i < Math.min(rawRows.length, 40); i++) {
    const vals = rawRows[i].map(__norm);
    if (vals.some(x => x.includes('codigo') && x.includes('contable')) && vals.some(x => x.startsWith('fecha'))) {
      H = vals;
      hrow = i;
      break;
    }
  }
  if (!H) throw new Error('No se encontro la fila de encabezados en el reporte.');

  const ix = f => H.findIndex(f);
  const C = {
    id: ix(x => x.startsWith('identificacion')),
    nom: ix(x => x === 'nombre tercero' || x.startsWith('nombre del tercero')),
    cod: ix(x => x.includes('codigo') && x.includes('contable')),
    cta: ix(x => x === 'cuenta contable'),
    comp: ix(x => x.startsWith('comprobante')),
    fec: ix(x => x.startsWith('fecha')),
    deb: ix(x => x.startsWith('debito')),
    cre: ix(x => x.startsWith('credito')),
    sal: ix(x => x.startsWith('saldo movimiento') || x.startsWith('saldo mov'))
  };


  const rows = [];
  let curTer = null, curCta = null;
  let totalDeb = 0, totalCre = 0;

  for (let i = hrow + 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    const c0 = String(r[0] || '').trim();
    if (!c0 && !r[C.cod] && !r[C.comp]) continue;

    if (c0.startsWith('Nombre del tercero:')) {
      const txt = c0.replace(/^Nombre del tercero:\s*/i, '').trim();
      const m = txt.match(/^(\d+)\s+(.*)$/);
      curTer = m ? { id: m[1], nom: m[2].trim() } : { id: '', nom: txt };
      continue;
    }
    if (c0.startsWith('Cuenta contable:')) {
      const txt = c0.replace(/^Cuenta contable:\s*/i, '').trim();
      const m = txt.match(/^(\d+)\s+(.*)$/);
      curCta = m ? { cod: m[1], nom: m[2].trim() } : { cod: '', nom: txt };
      continue;
    }
    if (c0.startsWith('Total')) continue;

    const cod = String(r[C.cod] || curCta?.cod || '').trim();
    const cls = cod.charAt(0);
    if (!['4', '5', '6'].includes(cls)) continue;

    const comp = String(r[C.comp] || '').trim();
    if (!comp) continue;

    const dt = __date(r[C.fec]);
    if (!dt) continue;

    const deb = __num(r[C.deb]);
    const cre = __num(r[C.cre]);
    totalDeb += deb;
    totalCre += cre;

    const terId = String(r[C.id] || curTer?.id || '').trim();
    const terNom = String(r[C.nom] || curTer?.nom || '').trim();
    const ctaNom = String(r[C.cta] || curCta?.nom || '').trim();

    rows.push({
      terId, terNom, cod, ctaNom, comp,
      year: dt[0], month: dt[1], day: dt[2],
      fecStr: `${dt[0]}-${String(dt[1]).padStart(2,'0')}-${String(dt[2]).padStart(2,'0')}`,
      deb, cre, net: cls === '4' ? (cre - deb) : (deb - cre)
    });
  }

  return { rows, totalDeb, totalCre };
}

function buildCube(rows) {
  const cuentas = {}, ters = {}, cat = { '4': {}, '5': {}, '6': {} };
  const comps = {}, ccs = {};
  const monthSums = { '4': Array(12).fill(0), '5': Array(12).fill(0), '6': Array(12).fill(0) };
  let minYear = 2026, maxYear = 2026;

  for (const r of rows) {
    const cls = r.cod.charAt(0);
    if (r.year) {
      if (r.year < minYear) minYear = r.year;
      if (r.year > maxYear) maxYear = r.year;
    }
    if (r.month >= 1 && r.month <= 12) {
      monthSums[cls][r.month - 1] += r.net;
    }

    if (!cuentas[r.cod]) cuentas[r.cod] = { n: r.ctaNom, c: cls, d: 0, c_: 0, net: 0, t: {} };
    cuentas[r.cod].d += r.deb;
    cuentas[r.cod].c_ += r.cre;
    cuentas[r.cod].net += r.net;

    if (!ters[r.terId]) ters[r.terId] = { n: r.terNom, d: 0, c_: 0, net: 0, ctas: {} };
    ters[r.terId].d += r.deb;
    ters[r.terId].c_ += r.cre;
    ters[r.terId].net += r.net;
    ters[r.terId].ctas[r.cod] = (ters[r.terId].ctas[r.cod] || 0) + r.net;
  }

  const compactRows = rows.map(r => [
    r.terId,
    r.cod,
    r.comp,
    r.month * 100 + r.day,
    Math.round(r.deb * 100) / 100,
    Math.round(r.cre * 100) / 100
  ]);

  return {
    year: maxYear,
    cuentas,
    ters,
    cat,
    comps,
    ccs,
    dets: {},
    rows: compactRows,
    audit: {
      generatedAt: new Date().toISOString(),
      totalMovements: rows.length,
      monthSums
    }
  };
}

function encryptPayload(htmlContent, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, 250000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(htmlContent, 'utf-8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([salt, iv, enc, tag]);
  return packed.toString('base64');
}

async function main() {
  const dir = path.join(__dirname, 'reportes');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.xlsx')).sort() : [];
  if (!files.length) throw new Error('No hay archivos .xlsx en reportes/');

  const latestFileName = files[files.length - 1];
  const latestPath = path.join(dir, latestFileName);
  console.log(`1. Procesando archivo Excel mas reciente: ${latestFileName}`);

  const { rows, totalDeb, totalCre } = parseAux(latestPath);
  console.log(`Reporte procesado exitosamente: ${rows.length} movimientos de ingresos, costos y gastos.`);
  console.log(`Debitos totales: $${totalDeb.toLocaleString('es-CO')}`);
  console.log(`Creditos totales: $${totalCre.toLocaleString('es-CO')}`);

  // Si hay archivo previo, comparar para reportar movimientos nuevos
  if (files.length > 1) {
    const prevFileName = files[files.length - 2];
    const prevPath = path.join(dir, prevFileName);
    console.log(`\n2. Comparando con reporte anterior: ${prevFileName}...`);
    try {
      const prevData = parseAux(prevPath);
      const prevKeys = new Set(prevData.rows.map(r => `${r.terId}|${r.cod}|${r.comp}|${r.fecStr}|${r.deb}|${r.cre}`));
      const newMovements = rows.filter(r => !prevKeys.has(`${r.terId}|${r.cod}|${r.comp}|${r.fecStr}|${r.deb}|${r.cre}`));

      console.log(`=== REPORTE DE MOVIMIENTOS NUEVOS ===`);
      console.log(`Total movimientos archivo anterior: ${prevData.rows.length}`);
      console.log(`Total movimientos archivo nuevo:    ${rows.length}`);
      console.log(`Movimientos nuevos detectados:       ${newMovements.length}`);

      if (newMovements.length > 0) {
        console.log(`\n--- MUESTRA DE MOVIMIENTOS NUEVOS INCORPORADOS HOY ---`);
        for (let i = 0; i < Math.min(newMovements.length, 5); i++) {
          const m = newMovements[i];
          console.log(`[${i+1}] Fecha: ${m.fecStr} | Comp: ${m.comp} | Tercero: ${m.terId} - ${m.terNom} | Cuenta: ${m.cod} - ${m.ctaNom} | Déb: $${m.deb} | Créd: $${m.cre}`);
        }
      } else {
        console.log('No se registraron transacciones nuevas entre estos dos cortes.');
      }
    } catch (cmpErr) {
      console.log('No se pudo completar la comparacion anterior:', cmpErr.message);
    }
  }

  console.log('\n3. Construyendo cubo de datos interactivo...');
  const cube = buildCube(rows);

  const templatePath = path.join(__dirname, 'plantilla_dashboard.html');
  if (!fs.existsSync(templatePath)) throw new Error('No se encontro plantilla_dashboard.html');
  const template = fs.readFileSync(templatePath, 'utf-8');

  const unencrypted = template.replace('/*__EMB_DATA_PLACEHOLDER__*/', JSON.stringify(cube));
  const password = process.env.DASHBOARD_PASS || '900914237';
  console.log('4. Cifrando aplicativo para publicacion protegida...');
  const b64 = encryptPayload(unencrypted, password);

  const indexPath = path.join(__dirname, 'index.html');
  let currentHtml = fs.readFileSync(indexPath, 'utf-8');
  if (/const B64\s*=\s*"[^"]*";/.test(currentHtml)) {
  currentHtml = currentHtml.replace(/const B64\s*=\s*"[^"]*";/, `const B64="${b64}";`);
} else {
  currentHtml = currentHtml.replace(/const encryptedData\s*=\s*"[^"]*";/, `const encryptedData = "${b64}";`);
}
  fs.writeFileSync(indexPath, currentHtml, 'utf-8');
  console.log('5. index.html actualizado y guardado correctamente.');
}

if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}

module.exports = { parseAux, buildCube, encryptPayload };
