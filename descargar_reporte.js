const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const isCI = !!process.env.CI;
const sessionPath = path.join(__dirname, 'siigo_session.json');

async function ejecutarLoginInteractivo() {
  console.log('\n======================================================');
  console.log('⚠️ SE REQUIERE VERIFICACIÓN / RENOVACIÓN DE SESIÓN EN SIIGO');
  console.log('👉 Se abrirá la ventana de Siigo en tu pantalla.');
  console.log('👉 Por favor inicia sesión e ingresa el código SMS.');
  console.log('======================================================\n');

  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized']
  });
  const context = await browser.newContext({
    viewport: null,
    acceptDownloads: true
  });
  const page = await context.newPage();

  configurarInterceptores(page);

  await page.goto('https://siigonube.siigo.com/#/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('Esperando a que completes la autenticación y el código SMS en pantalla...');
  await page.waitForFunction(() => {
    const href = window.location.href;
    return !href.includes('account.siigo.com') &&
           !href.includes('openid-callback') &&
           !href.includes('oauth2') &&
           !href.includes('#/login') &&
           (href.includes('siigonube.siigo.com') || href.includes('siigonube2.siigo.com'));
  }, { timeout: 300000 }); // Hasta 5 minutos para ingresar credenciales y SMS

  console.log('¡Autenticación con SMS completada exitosamente!');
  await page.waitForTimeout(5000);

  // Guardar la nueva sesión para que los próximos días corra en segundo plano
  await context.storageState({ path: sessionPath });
  console.log('✅ Sesión actualizada y guardada en siigo_session.json.');

  return { browser, context, page };
}

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
  });
}

(async () => {
  let browser = null;
  let context = null;
  let page = null;

  // 1. Preparar contexto con sesión previa si existe
  const contextOptions = {
    acceptDownloads: true,
    viewport: { width: 1366, height: 768 }
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

  try {
    let sessionValida = false;

    if (hasStoredSession) {
      console.log('1. Intentando acceso en segundo plano con la sesión guardada...');
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext(contextOptions);
      page = await context.newPage();
      configurarInterceptores(page);

      await page.goto('https://siigonube.siigo.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      console.log('2. Verificando estado de la sesión...');

      try {
        await page.waitForFunction(() => {
          const href = window.location.href;
          return (!href.includes('account.siigo.com') && 
                  !href.includes('openid-callback') && 
                  !href.includes('oauth2') &&
                  !href.includes('#/login') &&
                  (href.includes('siigonube.siigo.com') || href.includes('siigonube2.siigo.com'))) ||
                  href.includes('account.siigo.com') ||
                  href.includes('#/login');
        }, { timeout: 30000 });

        await page.waitForTimeout(4000);
        const currentUrl = page.url();
        console.log('URL actual tras comprobación:', currentUrl);

        if (!currentUrl.includes('account.siigo.com') && !currentUrl.includes('#/login')) {
          sessionValida = true;
          console.log('✅ Sesión válida y activa. Continuando en segundo plano.');
        } else {
          console.log('⚠️ La sesión guardada ha expirado o Siigo solicita login/SMS.');
        }
      } catch (errWait) {
        console.log('Timeout verificando sesión guardada:', errWait.message);
      }
    }

    // Si la sesión no es válida y estamos en entorno local, abrir navegador interactivo
    if (!sessionValida) {
      if (!isCI) {
        if (browser) {
          try { await browser.close(); } catch (_) {}
        }
        const interactivo = await ejecutarLoginInteractivo();
        browser = interactivo.browser;
        context = interactivo.context;
        page = interactivo.page;
      } else {
        console.error('Error: Sesión expirada en entorno desatendido CI (GitHub Actions).');
        process.exit(1);
      }
    }

    // 3. Navegar al reporte en el cluster asignado
    const currentOrigin = new URL(page.url()).origin;
    const reportUrl = `${currentOrigin}/#/reports-excel/1979`;
    console.log('3. Navegando al reporte contable en:', reportUrl);
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log('4. Esperando carga de la vista del reporte...');
    await page.waitForTimeout(8000);
    console.log('URL actual tras navegar al reporte:', page.url());

    if (!page.url().includes('reports-excel/1979')) {
      console.log('Forzando navegación hash interna a #/reports-excel/1979...');
      await page.evaluate(() => { window.location.hash = '#/reports-excel/1979'; });
      await page.waitForTimeout(6000);
    }

    // 5. Pulsar Generar reporte
    console.log('5. Buscando botón Generar reporte...');
    const genButton = page.locator('button:has-text("Generar reporte")').first();
    await genButton.waitFor({ state: 'visible', timeout: 35000 });
    console.log('Pulsando botón Generar reporte...');
    await genButton.click();
    await page.waitForTimeout(3000);

    // Opciones tras click
    const excelOption = page.locator('button, a, li, span, div[role="menuitem"]').filter({ hasText: /^Excel$/i }).first();
    if (await excelOption.count() > 0 && await excelOption.isVisible()) {
      console.log('Pulsando opción Excel...');
      await excelOption.click();
      await page.waitForTimeout(3000);
    } else {
      const linkExcel = page.locator('a:has-text("Excel"), button:has-text("Excel")').first();
      if (await linkExcel.count() > 0 && await linkExcel.isVisible()) {
        console.log('Pulsando enlace/botón Excel...');
        await linkExcel.click();
        await page.waitForTimeout(3000);
      }
    }

    // 6. Esperar descarga
    console.log('6. Esperando generación y descarga del archivo...');
    for (let i = 0; i < 35; i++) {
      if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
        console.log('¡Archivo descargado exitosamente!', downloadedFilePath);
        break;
      }
      await page.waitForTimeout(2000);
    }

    // 7. Procesar y actualizar dashboard local
    const outputDir = path.join(__dirname, 'reportes');
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir);
      console.log('Archivos en carpeta reportes:', files);
      if (files.some(f => f.endsWith('.xlsx') || f.endsWith('.zip') || f.endsWith('.csv'))) {
        console.log('7. Reporte generado y verificado.');
        try { await browser.close(); } catch (_) {}

        console.log('8. Procesando Excel y actualizando index.html...');
        try {
          execSync('node generar_dashboard.js', { stdio: 'inherit' });
          console.log('✅ Dashboard index.html actualizado con éxito.');
        } catch (genErr) {
          console.error('Advertencia al generar dashboard:', genErr.message || genErr);
        }

        console.log('\n======================================================');
        console.log('🎉 ¡ACTUALIZACIÓN COMPLETADA CON ÉXITO!');
        console.log('======================================================\n');
        process.exit(0);
      }
    }

    await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
    throw new Error('No se detectó el archivo Excel descargado.');

  } catch (error) {
    console.error('Error durante la ejecución:', error.message || error);
    try {
      if (page) await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
    } catch (_) {}
    process.exit(1);
  } finally {
    // Si estamos en CI, limpiar archivo temporal de secretos
    if (isCI && fs.existsSync(sessionPath)) {
      try { fs.unlinkSync(sessionPath); } catch (_) {}
    }
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
})();
