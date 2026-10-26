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
  if (v instanceof Date && !isNaN(v)) return [v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate()];
  if (typeof v === 'number' && v > 30000) {
    const d = new Date(Math.round((v - 25569) * 864e5));
    return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
  }
  if (typeof v === 'string') {
    let m = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) return [+m[3], +m[2], +m[1]];
    m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return [+m[1], +m[2], +m[3]];
  }
  return null;
}
function getPreviousMonthEnd(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(now);

  const year = Number(parts.find(p => p.type === 'year').value);
  const month = Number(parts.find(p => p.type === 'month').value);
  const end = new Date(Date.UTC(year, month - 1, 0));

  return {
    year: end.getUTCFullYear(),
    month: end.getUTCMonth() + 1,
    day: end.getUTCDate(),
    key: end.getUTCFullYear() * 10000 +
      (end.getUTCMonth() + 1) * 100 +
      end.getUTCDate()
  };
}
function parseAux(filePath) {
  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];

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
    cre: ix(x => x.startsWith('credito'))
  };

  for (const k of ['cod', 'fec', 'deb', 'cre']) {
    if (C[k] < 0) throw new Error('Falta columna requerida: ' + k);
  }

  const recs = [];
  let bad = 0;
  for (let n = hrow + 1; n < rawRows.length; n++) {
    const v = rawRows[n];
    const cod = String(v[C.cod] || '').trim();
    if (!cod) continue;

    // Solo cuentas de ingresos (4), gastos (5) y costos (6)
    const cls2 = cod.slice(0, 2);
    if (!['41', '42', '51', '52', '53', '61'].includes(cls2)) continue;

    const dt = __date(v[C.fec]);
    if (!dt) { bad++; continue; }

    const d = __num(v[C.deb]), c = __num(v[C.cre]);
    recs.push({
      id: String(v[C.id] || '').trim(),
      nom: String(v[C.nom] || '').trim(),
      cod,
      cta: String(v[C.cta] || '').trim(),
      comp: String(v[C.comp] || '').trim(),
      y: dt[0], m: dt[1], d: dt[2],
      deb: d, cre: c
    });
  }

  if (!recs.length) throw new Error('No se encontraron movimientos contables en las clases 4, 5 o 6.');

  const yc = {};
  recs.forEach(r => yc[r.y] = (yc[r.y] || 0) + 1);
  const year = +Object.keys(yc).sort((a, b) => yc[b] - yc[a])[0];
  const all = recs.filter(r => r.y === year);
  const R = all.filter(r => r.m <= 12);
  let sd = 0, sc = 0;
  R.forEach(r => { sd += r.deb; sc += r.cre; });
  let last = 0;
  R.forEach(r => { const k = r.m * 100 + r.d; if (k > last) last = k; });

  return { recs: R, year, bad, sd, sc, last, skipped: recs.length - R.length };
}

function buildCube(P, catObj) {
  const cuMap = new Map(), terMap = new Map(), cmpMap = new Map();
  P.recs.forEach(r => {
    if (!cuMap.has(r.cod)) cuMap.set(r.cod, r.cta || r.cod);
    const tk = r.id + '|' + r.nom;
    if (!terMap.has(tk)) terMap.set(tk, 0);
  });
  const cods = [...cuMap.keys()].sort();
  const ci = new Map(cods.map((c, i) => [c, i]));
  const ters = [...terMap.keys()];
  ters.forEach((t, i) => terMap.set(t, i));
  const cuentas = cods.map(c => [c, cuMap.get(c)]);
  const comps = [], rows = [];
  const seen = new Map();
  let dupN = 0, dupSum = 0, zero = 0;

  P.recs.forEach(r => {
    let k = cmpMap.get(r.comp);
    if (k === undefined) { k = comps.length; comps.push(r.comp); cmpMap.set(r.comp, k); }
    const v = Math.round((r.deb - r.cre) * 100) / 100;
    const c = ci.get(r.cod), t = terMap.get(r.id + '|' + r.nom), d = r.m * 100 + r.d;
    const key = k + '|' + c + '|' + t + '|' + d + '|' + v;
    const dup = seen.has(key) ? 1 : 0;
    seen.set(key, 1);
    if (dup) { dupN++; dupSum += v; }
    if (v === 0) zero++;
    rows.push([d, c, 0, t, k, 0, v, dup]);
  });
  rows.sort((a, b) => a[0] - b[0]);

  return {
    cuentas,
    cat: catObj || {},
    ccs: ['SIN CENTRO'],
    ters,
    comps,
    dets: [''],
    rows,
    year: P.year,
    audit: {
      custom: 1,
      filas: rows.length,
      terceros: ters.length,
      cuentas: cuentas.length,
      dup_n: dupN,
      dup_sum: dupSum,
      ceros: zero,
      cuadra: true,
      mism: 0,
      hdr: 0,
      last: P.last,
      sd: P.sd,
      sc: P.sc,
      bad: P.bad
    }
  };
}

function encryptHtml(html, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, 250000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(html, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const raw = Buffer.concat([salt, iv, ct, tag]);
  return raw.toString('base64');
}

async function main() {
  const dir = path.join(__dirname, 'reportes');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.xlsx')).sort() : [];
  if (!files.length) throw new Error('No hay archivos .xlsx en reportes/');
  const excelPath = path.join(dir, files[files.length - 1]);
  const templatePath = path.join(__dirname, 'plantilla_dashboard.html');
  const password = process.env.DASHBOARD_PASS || '900914237';

  console.log('1. Procesando archivo Excel:', excelPath);
  const P = parseAux(excelPath);
  console.log(`- Movimientos procesados: ${P.recs.length} (Año ${P.year})`);

  console.log('2. Construyendo cubo analítico...');
  const templateHtml = fs.readFileSync(templatePath, 'utf8');
  const catMatch = templateHtml.match(/\"cat\":\s*(\{[^\}]+\})/);
  const catObj = catMatch ? JSON.parse(catMatch[1]) : {};
  const cube = buildCube(P, catObj);
  cube.fileName = path.basename(excelPath);

  console.log('3. Inyectando datos en la plantilla...');
  const embCode = '__EMB=' + JSON.stringify(cube) + ';';
  const fullHtml = templateHtml.replace('/*__EMB_DATA_PLACEHOLDER__*/', embCode);

  console.log('4. Cifrando con AES-256-GCM...');
  const b64 = encryptHtml(fullHtml, password);

  console.log('5. Generando index.html...');
  const outerHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  let newIndexHtml = '';
  if (outerHtml.includes('const B64="')) {
    const b64Start = outerHtml.indexOf('const B64="');
    const b64End = outerHtml.indexOf('";', b64Start);
    newIndexHtml = outerHtml.substring(0, b64Start + 11) + b64 + outerHtml.substring(b64End);
  } else if (/const B64\s*=\s*"[^"]*";/.test(outerHtml)) {
    newIndexHtml = outerHtml.replace(/const B64\s*=\s*"[^"]*";/, `const B64="${b64}";`);
  } else if (/const encryptedData\s*=\s*"[^"]*";/.test(outerHtml)) {
    newIndexHtml = outerHtml.replace(/const encryptedData\s*=\s*"[^"]*";/, `const encryptedData="${b64}";`);
  } else {
    throw new Error('index.html no tiene el formato esperado (no se encontro const B64 ni const encryptedData)');
  }

  fs.writeFileSync(path.join(__dirname, 'index.html'), newIndexHtml, 'utf8');
  console.log('index.html actualizado exitosamente con', P.recs.length, 'movimientos.');
}

if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}

module.exports = { parseAux, buildCube, encryptHtml };
