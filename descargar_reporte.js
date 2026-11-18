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
    // 3. Navegar al reporte y descargar datos actualizados
    console.log('3. Accediendo al sistema de reportes de Siigo...');
    await page.waitForTimeout(4000);

    const currentOrigin = new URL(page.url()).origin;
    const outputDir = path.join(__dirname, 'reportes');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const initialFiles = new Set(fs.readdirSync(outputDir));
    let nuevoArchivoDescargado = null;

    // ESTRATEGIA 1: Generador oficial de reportes en segundo plano (reports-excel/1979)
    // Esta vía genera en Azure Blob el archivo Excel completo sin truncar a 10.000 filas.
    console.log('--- Intentando Estrategia 1: Generador en segundo plano #/reports-excel/1979 ---');
    try {
      const excelCenterUrl = `${currentOrigin}/#/reports-excel/1979`;
      console.log('Navegando a:', excelCenterUrl);
      await page.goto(excelCenterUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(7000);

      if (!page.url().includes('reports-excel/1979')) {
        console.log('Forzando cambio de hash interno a #/reports-excel/1979...');
        await page.evaluate(() => { window.location.hash = '#/reports-excel/1979'; });
        await page.waitForTimeout(6000);
      }

      console.log('URL actual en Estrategia 1:', page.url());
      const genBtn = page.locator('button:has-text("Generar reporte"), a:has-text("Generar reporte")').first();
      if (await genBtn.count() > 0 && await genBtn.isVisible()) {
        console.log('✓ Botón "Generar reporte" encontrado. Solicitando generación en Excel...');
        await genBtn.click();
        await page.waitForTimeout(3000);

        // Si aparece menú de formato (Excel / txt)
        const excelMenuOption = page.locator('button, a, li, span, div[role="menuitem"]').filter({ hasText: /^Excel$/i }).first();
        if (await excelMenuOption.count() > 0 && await excelMenuOption.isVisible()) {
          console.log('Pulsando opción "Excel" del menú...');
          await excelMenuOption.click();
        }

        console.log('Esperando generación y descarga del reporte completo desde Azure/Siigo (hasta 90s)...');
        for (let i = 0; i < 45; i++) {
          if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
            const sz = fs.statSync(downloadedFilePath).size;
            if (sz > 50000) {
              nuevoArchivoDescargado = downloadedFilePath;
              console.log(`✓ ¡Reporte completo descargado con éxito! (${sz} bytes): ${nuevoArchivoDescargado}`);
              break;
            }
          }
          const currentFiles = fs.readdirSync(outputDir);
          const newF = currentFiles.find(f => !initialFiles.has(f) && f.endsWith('.xlsx'));
          if (newF) {
            const fullP = path.join(outputDir, newF);
            const sz = fs.statSync(fullP).size;
            if (sz > 50000) {
              nuevoArchivoDescargado = fullP;
              console.log(`✓ ¡Reporte completo capturado en carpeta! (${sz} bytes): ${nuevoArchivoDescargado}`);
              break;
            }
          }
          await page.waitForTimeout(2000);
        }
      } else {
        console.log('El botón "Generar reporte" no estuvo visible en reports-excel/1979.');
      }
    } catch (errStrat1) {
      console.warn('Aviso en Estrategia 1:', errStrat1.message);
    }

    // ESTRATEGIA 2 (Fallback): Vista interactiva #/reports/2000/5516
    if (!nuevoArchivoDescargado) {
      console.log('--- Intentando Estrategia 2: Vista de reporte interactivo #/reports/2000/5516 ---');
      const interactiveUrl = `${currentOrigin}/#/reports/2000/5516?TabID=1754&pTabID=1754&rReport=1`;
      await page.goto(interactiveUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(8000);

      const currentYear = new Date().getFullYear();
      console.log(`Configurando filtros de fecha (desde 01/01/${currentYear} hasta hoy)...`);

      // 1. Modificar input de fecha inicial
      await page.evaluate((yr) => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const dateInputs = inputs.filter(inp => /^\d{2}\/\d{2}\/\d{4}$/.test((inp.value || '').trim()));
        if (dateInputs.length >= 1) {
          dateInputs[0].value = `01/01/${yr}`;
          dateInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
          dateInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, currentYear);
      await page.waitForTimeout(2000);

      // 2. Pulsar botón Buscar del reporte
      const searchBtn = page.locator('button:has-text("Buscar")').first();
      if (await searchBtn.count() > 0 && await searchBtn.isVisible()) {
        console.log('Pulsando botón Buscar del reporte...');
        await searchBtn.click();
        console.log('Esperando a que la consulta de movimientos finalice en el servidor de Siigo (25s)...');
        await page.waitForTimeout(25000);
      }

      // 3. Pulsar botón de exportación Excel de la barra
      console.log('Pulsando botón de exportación Excel...');
      const excelBtn = page.locator('.dx-datagrid-export-button, [class*="export-button"], [title*="excel" i], [aria-label*="excel" i]').first();
      if (await excelBtn.count() > 0) {
        await excelBtn.click();
        await page.waitForTimeout(2000);
        const exportAll = page.locator('text="Exportar todos los datos", text="Export all data"').first();
        if (await exportAll.count() > 0 && await exportAll.isVisible()) {
          console.log('Pulsando "Exportar todos los datos"...');
          await exportAll.click();
        }
      }

      console.log('Esperando descarga del archivo desde la grilla...');
      for (let i = 0; i < 30; i++) {
        if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
          nuevoArchivoDescargado = downloadedFilePath;
          break;
        }
        const currentFiles = fs.readdirSync(outputDir);
        const newF = currentFiles.find(f => !initialFiles.has(f) && f.endsWith('.xlsx'));
        if (newF) {
          nuevoArchivoDescargado = path.join(outputDir, newF);
          break;
        }
        await page.waitForTimeout(2000);
      }
    }

    if (!nuevoArchivoDescargado || !fs.existsSync(nuevoArchivoDescargado)) {
      console.warn('Tomando captura de pantalla para diagnóstico...');
      await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
      throw new Error('No se detectó la descarga de un nuevo archivo Excel desde Siigo.');
    }

        // 7. Procesar y actualizar dashboard local
    console.log('7. Reporte generado y verificado:', nuevoArchivoDescargado);
    try { await browser.close(); } catch (_) {}

    console.log('8. Procesando Excel y actualizando index.html...');
    try {
      execSync(`node generar_dashboard.js "${nuevoArchivoDescargado}"`, { stdio: 'inherit' });
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
