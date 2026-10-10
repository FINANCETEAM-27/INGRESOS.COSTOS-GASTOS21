const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');

const __norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
function __cv(v){
  if(v && typeof v === 'object' && !(v instanceof Date)){
    if('result' in v) v = v.result;
    else if(v.richText) v = v.richText.map(t=>t.text).join('');
    else if(v.text !== undefined) v = v.text;
  }
  return v == null ? '' : v;
}
function __date(v){
  if(v instanceof Date && !isNaN(v)) return [v.getUTCFullYear(), v.getUTCMonth()+1, v.getUTCDate()];
  if(typeof v === 'number' && v > 30000){
    const d = new Date(Math.round((v - 25569) * 864e5));
    return [d.getUTCFullYear(), d.getUTCMonth()+1, d.getUTCDate()];
  }
  if(typeof v === 'string'){
    let m = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if(m) return [+m[3], +m[2], +m[1]];
    m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if(m) return [+m[1], +m[2], +m[3]];
  }
  return null;
}
const __num = v => {
  if(typeof v === 'number') return v;
  if(typeof v === 'string' && v.trim()){
    const n = Number(v.replace(/[^\d.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  }
  return 0;
};

async function parseAux(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  let ws = null, H = null, hrow = 0;
  for (const w of wb.worksheets) {
    let found = null;
    w.eachRow({ includeEmpty: false }, (row, n) => {
      if (found || n > 40) return;
      const vals = Array.from(row.values, x => __norm(__cv(x)));
      if (vals.includes('codigo contable') && vals.some(x => x.startsWith('fecha'))) {
        found = { n, vals };
      }
    });
    if (found) { ws = w; H = found.vals; hrow = found.n; break; }
  }
  if (!ws) throw new Error('No se reconoce el formato del reporte.');

  const ix = f => H.findIndex(f);
  const C = {
    id: ix(x => x.startsWith('identificacion')),
    nom: ix(x => x === 'nombre tercero' || x.startsWith('nombre del tercero')),
    cod: ix(x => x === 'codigo contable'),
    cta: ix(x => x === 'cuenta contable'),
    comp: ix(x => x === 'comprobante'),
    fec: ix(x => x.startsWith('fecha')),
    deb: ix(x => x === 'debito'),
    cre: ix(x => x === 'credito')
  };

  for (const k of ['cod', 'fec', 'deb', 'cre']) {
    if (C[k] < 1) throw new Error('Falta la columna: ' + k);
  }

  const recs = [];
  let grp = null, gl = [], hd = 0, hc = 0, bad = 0;
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n <= hrow) return;
    const v = row.values;
    const a = __cv(v[1]);
    if (typeof a === 'string' && a.startsWith('Cuenta contable:')) {
      grp = { d: __num(__cv(v[C.deb])), c: __num(__cv(v[C.cre])), d0: 0, c0: 0 };
      gl.push(grp); hd += grp.d; hc += grp.c;
      return;
    }
    if (typeof a === 'string' && a.startsWith('Nombre del tercero:')) return;
    const cod = String(__cv(v[C.cod])).trim();
    const dt = __date(__cv(v[C.fec]));
    if (!cod || !dt) {
      if (a !== '' && !String(a).startsWith('Procesado')) bad++;
      return;
    }
    const d = __num(__cv(v[C.deb])), c = __num(__cv(v[C.cre]));
    if (grp) { grp.d0 += d; grp.c0 += c; }
    recs.push({
      id: String(__cv(v[C.id])).trim(),
      nom: String(__cv(v[C.nom])).trim(),
      cod,
      cta: String(__cv(v[C.cta])).trim(),
      comp: String(__cv(v[C.comp])).trim(),
      y: dt[0], m: dt[1], d: dt[2],
      deb: d, cre: c
    });
  });

  if (!recs.length) throw new Error('No se encontraron movimientos en el archivo.');

  const yc = {};
  recs.forEach(r => yc[r.y] = (yc[r.y] || 0) + 1);
  const year = +Object.keys(yc).sort((a,b) => yc[b] - yc[a])[0];
  const all = recs.filter(r => r.y === year);
  let fd = 0, fc = 0;
  all.forEach(r => { fd += r.deb; fc += r.cre; });
  const R = all.filter(r => r.m <= 12);
  let sd = 0, sc = 0;
  R.forEach(r => { sd += r.deb; sc += r.cre; });
  const mism = gl.filter(g => Math.abs(g.d - g.d0) > 1 || Math.abs(g.c - g.c0) > 1).length;
  let last = 0;
  R.forEach(r => { const k = r.m * 100 + r.d; if (k > last) last = k; });
  const cuadra = gl.length > 0 && mism === 0 && Math.abs(fd - hd) < 1 && Math.abs(fc - hc) < 1;

  return { recs: R, year, skipped: recs.length - R.length, after: all.length - R.length, bad, hdrGroups: gl.length, mism, sd, sc, hd, hc, cuadra, last };
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
    ccs: [''],
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
      cuadra: P.cuadra,
      mism: P.mism,
      hdr: P.hdrGroups,
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
  const P = await parseAux(excelPath);
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
  const b64Start = outerHtml.indexOf('const B64="');
  const b64End = outerHtml.indexOf('";', b64Start);
  if (b64Start < 0) throw new Error('index.html no tiene el formato esperado');
  const newIndexHtml = outerHtml.substring(0, b64Start + 11) + b64 + outerHtml.substring(b64End);
  fs.writeFileSync(path.join(__dirname, 'index.html'), newIndexHtml, 'utf8');
  console.log('index.html actualizado con', P.recs.length, 'movimientos. Cuadra con subtotales:', P.cuadra);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
