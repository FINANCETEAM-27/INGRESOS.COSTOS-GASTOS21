const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const isCI = !!process.env.CI;
const sessionPath = path.join(__dirname, 'siigo_session.json');

// Cargar variables de entorno desde .env local si existe
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let val = (match[2] || '').trim().replace(/^['"](.*)['"]$/, '$1');
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch (_) {}
}

const user = process.env.SIIGO_USER;
const pass = process.env.SIIGO_PASS;

let downloadedFilePath = null;

function configurarInterceptores(page) {
  page.on('download', async (download) => {
    console.log('Evento de descarga detectado:', download.suggestedFilename());
    const outputDir = path.join(__dirname, 'reportes');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const target = path.join(outputDir, download.suggestedFilename() || 'reporte.xlsx');
    await download.saveAs(target);
    downloadedFilePath = target;
    console.log('Descarga completada y guardada en:', target);
  });

  page.on('response', async (response) => {
    const url = response.url();
    const headers = response.headers();
    const disposition = headers['content-disposition'] || '';
    if (disposition.includes('attachment') || url.includes('.xlsx') || url.includes('export') || url.includes('download')) {
      console.log('Respuesta sospechosa de archivo:', url, 'Disposition:', disposition);
    }
    if (response.status() >= 400 && url.includes('siigo')) {
      try {
        console.log('[API ERROR ' + response.status() + ']: ' + url);
      } catch (_) {}
    }
  });

  page.on('console', msg => {
    const t = msg.text();
    if (msg.type() === 'error' || /catastrophic|fail|error|cannot read|undefined|unauthorized|permission|denied/i.test(t)) {
      console.log('[BROWSER CONSOLE ' + msg.type() + ']: ' + t.slice(0, 350));
    }
  });

  page.on('pageerror', err => {
    console.log('[BROWSER UNCAUGHT]: ' + (err.stack || err.message).slice(0, 500));
  });
}

async function ejecutarLoginAutomatico(page, user, pass) {
  console.log('Abriendo pantalla de inicio de sesión de Siigo...');
  await page.goto('https://siigonube.siigo.com/#/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('Ingresando credenciales para: ' + user + '...');
  const userInput = page.locator('#siigoSignInName');
  await userInput.waitFor({ state: 'attached', timeout: 30000 });
  await userInput.fill(user);

  const passInput = page.locator('#siigoPassword');
  await passInput.fill(pass);

  console.log('Enviando formulario de acceso...');
  const nextBtn = page.locator('#siigoNext');
  await nextBtn.click();

  console.log('Esperando autenticación y redirección...');
  // Si el usuario no pide SMS, redirige directamente al cluster
  await page.waitForURL(url => {
    const href = url.href;
    return !href.includes('account.siigo.com') &&
           !href.includes('openid-callback') &&
           !href.includes('oauth2') &&
           !href.includes('#/login') &&
           (href.includes('siigonube.siigo.com') || href.includes('siigonube2.siigo.com'));
  }, { timeout: isCI ? 60000 : 300000 });

  console.log('¡Inicio de sesión exitoso!');
  await page.waitForTimeout(5000);
}

async function ejecutarLoginInteractivo() {
  console.log('\n======================================================');
  console.log('⚠️ SE REQUIERE VERIFICACIÓN / RENOVACIÓN DE SESIÓN EN SIIGO');
  console.log('👉 Abriendo la ventana del navegador en tu pantalla...');
  console.log('👉 Por favor inicia sesión e ingresa el código SMS si lo solicita.');
  console.log('======================================================\n');

  const browser = await chromium.launch({ headless: false , args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-blink-features=AutomationControlled'
    ] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    acceptDownloads: true
  });
      const page = await context.newPage();

    page.on('console', msg => {
      const t = msg.text();
      if (msg.type() === 'error' || /catastrophic|fail|error|cannot read|undefined|unauthorized/i.test(t)) {
        console.log('[BROWSER CONSOLE ' + msg.type() + ']: ' + t.slice(0, 350));
      }
    });

    page.on('pageerror', err => {
      console.log('[BROWSER PAGEERROR]: ' + (err.stack || err.message).slice(0, 500));
    });
  configurarInterceptores(page);

  console.log('Cargando Siigo Nube...');
  await page.goto('https://siigonube.siigo.com/#/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('Esperando a que completes la autenticación en la ventana (tienes hasta 10 minutos)...');
  await page.waitForURL(url => {
    const href = url.href;
    return !href.includes('account.siigo.com') &&
           !href.includes('openid-callback') &&
           !href.includes('oauth2') &&
           !href.includes('#/login') &&
           (href.includes('siigonube.siigo.com') || href.includes('siigonube2.siigo.com'));
  }, { timeout: 600000 });

  console.log('¡Autenticación completada exitosamente!');
  await page.waitForTimeout(5000);

  await context.storageState({ path: sessionPath });
  console.log('✓ Sesión actualizada y guardada en siigo_session.json.');

  return { browser, context, page };
}

(async () => {
  let browser = null;
  let context = null;
  let page = null;

  const contextOptions = {
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'es-CO',
    timezoneId: 'America/Bogota'
  };

  const storageStateRaw = process.env.SIIGO_STORAGE_STATE;
  let hasStoredSession = false;

  if (storageStateRaw && storageStateRaw.trim().length > 10) {
    try {
      fs.writeFileSync(sessionPath, storageStateRaw.trim());
      contextOptions.storageState = sessionPath;
      hasStoredSession = true;
      console.log('Se detectó sesión guardada en SIIGO_STORAGE_STATE.');
    } catch (e) {
      console.warn('No se pudo escribir archivo de sesión desde env:', e.message);
    }
  } else if (fs.existsSync(sessionPath)) {
    try {
      const content = fs.readFileSync(sessionPath, 'utf8');
      if (content && content.trim().length > 10) {
        contextOptions.storageState = sessionPath;
        hasStoredSession = true;
        console.log('Se detectó archivo local siigo_session.json.');
      }
    } catch (e) {
      console.warn('Error leyendo siigo_session.json local:', e.message);
    }
  }

  let sessionValida = false;

  // Paso 1: Intento en segundo plano con sesión previa si existe
  if (hasStoredSession) {
    try {
      console.log('1. Probando acceso con la sesión guardada previa...');
      browser = await chromium.launch({
        headless: false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-web-security',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1440,900'
        ]
      });
      context = await browser.newContext(contextOptions);
      page = await context.newPage();
      configurarInterceptores(page);

      await page.goto('https://siigonube.siigo.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(6000);

      const currentUrl = page.url();
      console.log('URL actual comprobada:', currentUrl);

      if (!currentUrl.includes('account.siigo.com') && !currentUrl.includes('#/login') && !currentUrl.includes('openid-callback')) {
        sessionValida = true;
        console.log('✓ Sesión previa aún válida y activa.');
      } else {
        console.log('⚠️ La sesión previa expiró o Siigo solicita login.');
      }
    } catch (errBackground) {
      console.log('No se pudo reusar la sesión previa:', errBackground.message);
      sessionValida = false;
    } finally {
      if (!sessionValida && browser) {
        try { await browser.close(); } catch (_) {}
        browser = null;
        context = null;
        page = null;
      }
    }
  }

  // Paso 2: Si no hay sesión válida, autenticar
  if (!sessionValida) {
    if (user && pass) {
      console.log('2. Iniciando autenticación automática con credenciales configuradas...');
      browser = await chromium.launch({
        headless: false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-web-security',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1440,900'
        ]
      });
      context = await browser.newContext({
        acceptDownloads: true,
        viewport: { width: 1440, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        locale: 'es-CO',
        timezoneId: 'America/Bogota'
      });
      page = await context.newPage();
      configurarInterceptores(page);

      await ejecutarLoginAutomatico(page, user, pass);

      // Guardar la sesión generada para futuras ejecuciones
      try {
        await context.storageState({ path: sessionPath });
        console.log('✓ Nueva sesión guardada en siigo_session.json.');
      } catch (errStore) {
        console.warn('Aviso guardando storageState:', errStore.message);
      }
    } else if (!isCI) {
      console.log('No hay credenciales en variables de entorno. Iniciando modo interactivo...');
      const interactivo = await ejecutarLoginInteractivo();
      browser = interactivo.browser;
      context = interactivo.context;
      page = interactivo.page;
    } else {
      console.error('Error: Se requiere autenticación pero no se proporcionaron SIIGO_USER / SIIGO_PASS en CI.');
      process.exit(1);
    }
  }

  try {
    // 3. Navegar al reporte contable
    console.log('3. Navegando al reporte: Movimiento auxiliar de cuenta contable por tercero...');
    await page.waitForTimeout(4000);

    const currentOrigin = new URL(page.url()).origin;
    const targetReportPath = '/#/reports/2000/5516?TabID=1754&pTabID=1754&rReport=1';
    const targetReportUrl = `${currentOrigin}${targetReportPath}`;

    console.log('Navegando a la URL del reporte confirmada:', targetReportUrl);
    try {
      await page.goto(targetReportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (eNav) {
      console.warn('Aviso en goto directo, intentando por cambio de hash:', eNav.message);
      await page.evaluate((path) => {
        window.location.hash = path.replace('/#', '');
      }, targetReportPath);
    }
    await page.waitForTimeout(8000);

    // Si aún no está en la vista del reporte o redirigió, intentar clic en Reportes del menú
    if (!page.url().includes('5516') && !page.url().includes('1754')) {
      console.log('Intentando acceso por menú lateral Reportes...');
      await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a, button, li, span'));
        const rep = links.find(el => (el.innerText || '').trim().toLowerCase() === 'reportes');
        if (rep) rep.click();
      });
      await page.waitForTimeout(4000);

      await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a, button, div, span, h4, h5, p'));
        const item = links.find(el => /movimiento auxiliar de cuenta contable por tercero/i.test((el.innerText || '').trim()) || /movimiento auxiliar de tercero/i.test((el.innerText || '').trim()));
        if (item) item.click();
      });
      await page.waitForTimeout(6000);
    }

    console.log('URL actual en pantalla del reporte:', page.url());

    // 4. Configurar fechas del reporte (desde enero hasta la fecha actual)
    console.log('4. Configurando filtros de fecha (desde enero del año en curso)...');
    await page.waitForTimeout(5000);

    const filterApplied = await page.evaluate(() => {
      const currentYear = new Date().getFullYear();
      let changed = false;

      // Buscar inputs de tipo fecha o con valor dd/mm/yyyy
      const allInputs = Array.from(document.querySelectorAll('input'));
      const dateInputs = allInputs.filter(inp => /^\d{2}\/\d{2}\/\d{4}$/.test((inp.value || '').trim()));
      
      if (dateInputs.length >= 1) {
        console.log('Modificando fecha inicial a 01/01/' + currentYear);
        dateInputs[0].value = `01/01/${currentYear}`;
        dateInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        dateInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
        changed = true;
      }

      // Si hay un selector de periodo (e.g. 'Este mes')
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        for (const opt of sel.options) {
          if (/año|ano|acumulado/i.test(opt.text)) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            changed = true;
            break;
          }
        }
      }
      return changed;
    });
    console.log('¿Filtro de fecha desde enero modificado?:', filterApplied);
    await page.waitForTimeout(2000);

    // Pulsar botón Buscar para regenerar la tabla con el rango completo
    const searchBtn = page.locator('button:has-text("Buscar")').first();
    if (await searchBtn.count() > 0 && await searchBtn.isVisible()) {
      console.log('Pulsando botón Buscar para aplicar filtro desde enero...');
      try {
        await searchBtn.click();
        console.log('Esperando a que la tabla cargue los movimientos...');
        await page.waitForTimeout(8000);
      } catch (errSearch) {
        console.warn('Aviso al pulsar Buscar:', errSearch.message);
      }
    }

    // Registrar archivos previos en carpeta reportes
    const outputDir = path.join(__dirname, 'reportes');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const initialFiles = new Set(fs.readdirSync(outputDir));
    console.log('Archivos existentes antes de la descarga:', Array.from(initialFiles));

    // Esperar a que la tabla y el botón Agrupar / Excel estén presentes
    console.log('Esperando a que el botón Agrupar y la barra de herramientas estén visibles...');
    try {
      await page.locator('text="Agrupar"').first().waitFor({ state: 'visible', timeout: 30000 });
      console.log('✓ Tabla y controles de reporte cargados exitosamente.');
    } catch (_) {
      console.warn('Aviso: Agrupar no apareció en 30s, continuando con la búsqueda del botón de Excel...');
    }

    await page.waitForTimeout(3000);

    // 5. Pulsar botón con el logo / icono de Excel
    console.log('5. Buscando y pulsando el botón con el icono de Excel...');
    
    // Intentar primero clic directo sobre el botón de Excel ubicado junto a Agrupar
    let clickedExcel = await page.evaluate(() => {
      // 1. Buscar el elemento de texto 'Agrupar'
      const agruparEl = Array.from(document.querySelectorAll('*')).find(el => (el.innerText || '').trim() === 'Agrupar');
      if (agruparEl) {
        const toolbar = agruparEl.closest('.dx-toolbar, .toolbar, div') ? agruparEl.closest('.dx-toolbar, .toolbar, div').parentElement : null;
        if (toolbar) {
          // Buscar botones dentro de esa barra
          const btns = Array.from(toolbar.querySelectorAll('button, a, div[role="button"], span, i, img'));
          const excelBtn = btns.find(b => {
            const title = (b.getAttribute('title') || '').toLowerCase();
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            const cls = (b.className || '').toString().toLowerCase();
            const src = (b.getAttribute('src') || '').toLowerCase();
            return title.includes('excel') || aria.includes('excel') || cls.includes('excel') || src.includes('excel') || title.includes('export') || aria.includes('export');
          });
          if (excelBtn) {
            excelBtn.click();
            return 'clicked_excel_in_toolbar';
          }
          // Si no tiene clases 'excel', buscar el último botón a la derecha de Agrupar
          const lastBtn = toolbar.querySelector('button:last-child, a:last-child');
          if (lastBtn && lastBtn !== agruparEl) {
            lastBtn.click();
            return 'clicked_last_button_in_toolbar';
          }
        }
      }

      // 2. Búsqueda global por icono o clase de Excel
      const allEls = Array.from(document.querySelectorAll('button, a, i, span, div, img'));
      const target = allEls.find(e => {
        const title = (e.getAttribute('title') || '').toLowerCase();
        const aria = (e.getAttribute('aria-label') || '').toLowerCase();
        const cls = (e.className || '').toString().toLowerCase();
        const src = (e.getAttribute('src') || '').toLowerCase();
        return title.includes('excel') || aria.includes('excel') || cls.includes('excel') || src.includes('excel') || cls.includes('fa-file-excel');
      });
      if (target) {
        target.click();
        return 'clicked_global_excel_element';
      }

      return false;
    });

    console.log('Resultado del intento de clic en Excel por DOM:', clickedExcel);

    if (!clickedExcel) {
      console.log('Intentando clic con selectores Playwright...');
      const excelSelectors = [
        'button:has([class*="excel" i])',
        'a:has([class*="excel" i])',
        'button:has(.fa-file-excel)',
        '[title*="excel" i]',
        '[aria-label*="excel" i]',
        '.icon-excel',
        'button:has-text("Excel")',
        'a:has-text("Excel")'
      ];
      for (const sel of excelSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.count() > 0 && await loc.isVisible()) {
          console.log(`Pulsando botón con selector Playwright: ${sel}...`);
          await loc.click();
          clickedExcel = true;
          break;
        }
      }
    }

        // 6. Esperar descarga del archivo nuevo
    console.log('6. Esperando generación y descarga del archivo...');
    let nuevoArchivoDescargado = null;
    for (let i = 0; i < 40; i++) {
      if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
        nuevoArchivoDescargado = downloadedFilePath;
        console.log('¡Archivo capturado por evento de descarga!', nuevoArchivoDescargado);
        break;
      }
      const currentFiles = fs.readdirSync(outputDir);
      const newFile = currentFiles.find(f => !initialFiles.has(f) && (f.endsWith('.xlsx') || f.endsWith('.zip') || f.endsWith('.csv')));
      if (newFile) {
        nuevoArchivoDescargado = path.join(outputDir, newFile);
        console.log('¡Nuevo archivo detectado en carpeta reportes!', nuevoArchivoDescargado);
        break;
      }
      await page.waitForTimeout(2000);
    }

    if (!nuevoArchivoDescargado) {
      console.warn('Tomando captura de pantalla para diagnóstico...');
      await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
      throw new Error('No se detectó la descarga de un nuevo archivo Excel desde Siigo.');
    }

    // 7. Procesar y actualizar dashboard local
    console.log('7. Reporte generado y verificado:', nuevoArchivoDescargado);
    try { await browser.close(); } catch (_) {}

    console.log('8. Procesando Excel y actualizando index.html...');
    try {
      execSync('node generar_dashboard.js', { stdio: 'inherit' });
      console.log('✓ Dashboard index.html actualizado con éxito.');
    } catch (genErr) {
      console.error('Advertencia al generar dashboard:', genErr.message || genErr);
    }

    console.log('\n======================================================');
    console.log('🎉 ¡ACTUALIZACIÓN COMPLETADA CON ÉXITO!');
    console.log('======================================================\n');
    process.exit(0);
    await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
    throw new Error('No se detectó el archivo Excel descargado.');

  } catch (error) {
    console.error('Error durante la ejecución:', error.message || error);
    try {
      if (page) await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
    } catch (_) {}
    process.exit(1);
  } finally {
    if (isCI && fs.existsSync(sessionPath)) {
      try { fs.unlinkSync(sessionPath); } catch (_) {}
    }
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
})();
