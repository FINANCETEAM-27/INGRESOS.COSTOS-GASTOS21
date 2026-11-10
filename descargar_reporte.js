const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function ejecutarLogin(page, user, pass) {
  console.log('Abriendo pantalla de autenticacion de Siigo...');
  await page.goto('https://siigonube.siigo.com/#/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('Ingresando credenciales...');
  const userInput = page.locator('#siigoSignInName');
  await userInput.waitFor({ state: 'attached', timeout: 30000 });
  await userInput.fill(user);

  const passInput = page.locator('#siigoPassword');
  await passInput.fill(pass);

  console.log('Enviando formulario de acceso...');
  const nextBtn = page.locator('#siigoNext');
  await nextBtn.click();

  console.log('Esperando redireccion a Siigo Nube...');
  await page.waitForURL(url => !url.href.includes('account.siigo.com'), { timeout: 60000 });
  console.log('Autenticacion inicial completada.');
}

(async () => {
  const user = process.env.SIIGO_USER;
  const pass = process.env.SIIGO_PASS;
  const storageStateRaw = process.env.SIIGO_STORAGE_STATE;

  const tempStatePath = path.join(__dirname, 'siigo_session.json');
  const contextOptions = {
    acceptDownloads: true,
    viewport: { width: 1366, height: 768 }
  };

  let hasStoredSession = false;
  if (storageStateRaw && storageStateRaw.trim().length > 10) {
    try {
      fs.writeFileSync(tempStatePath, storageStateRaw.trim());
      contextOptions.storageState = tempStatePath;
      hasStoredSession = true;
      console.log('Se detecto sesion guardada en SIIGO_STORAGE_STATE.');
    } catch (e) {
      console.warn('No se pudo escribir archivo temporal de sesion:', e.message);
    }
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  // Interceptar descargas y respuestas de archivos
  let downloadedFilePath = null;
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

  try {
    if (hasStoredSession) {
      console.log('1. Accediendo a Siigo con la sesion autenticada guardada...');
      await page.goto('https://siigonube.siigo.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      
      console.log('2. Esperando consolidacion de sesion y callbacks OAuth...');
      // Esperar activamente a que terminen las redirecciones de Microsoft B2C / Siigo
      await page.waitForFunction(() => {
        const href = window.location.href;
        return !href.includes('account.siigo.com') && 
               !href.includes('openid-callback') && 
               !href.includes('oauth2') &&
               (href.includes('siigonube.siigo.com') || href.includes('siigonube2.siigo.com'));
      }, { timeout: 60000 });

      // Esperar estabilizacion del SPA de Siigo
      await page.waitForTimeout(6000);
      console.log('¡Sesion autenticada confirmada! URL actual:', page.url());
    } else {
      console.log('1. No hay sesion guardada. Iniciando login tradicional...');
      if (!user || !pass) {
        console.error('Faltan las credenciales SIIGO_USER o SIIGO_PASS');
        process.exit(1);
      }
      await ejecutarLogin(page, user, pass);
      console.log('Esperando carga del entorno inicial...');
      await page.waitForTimeout(6000);
    }

    // Identificar el host/cluster actual asignado a la empresa (ej: siigonube2.siigo.com)
    const currentOrigin = new URL(page.url()).origin;
    const reportUrl = `${currentOrigin}/#/reports-excel/1979`;
    console.log('3. Navegando al reporte contable en:', reportUrl);
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    console.log('4. Esperando carga de la vista del reporte...');
    await page.waitForTimeout(8000);
    console.log('URL actual tras navegar al reporte:', page.url());

    // Si la URL cambio a root o redirigio, forzar navegacion interna por hash
    if (!page.url().includes('reports-excel/1979')) {
      console.log('Forzando navegacion hash interna a #/reports-excel/1979...');
      await page.evaluate(() => { window.location.hash = '#/reports-excel/1979'; });
      await page.waitForTimeout(6000);
    }

    // Click en Generar reporte
    console.log('5. Buscando boton Generar reporte...');
    const genButton = page.locator('button:has-text("Generar reporte")').first();
    await genButton.waitFor({ state: 'visible', timeout: 35000 });
    console.log('Pulsando boton Generar reporte...');
    await genButton.click();
    await page.waitForTimeout(3000);

    // Opciones tras click
    const optionsAfterClick = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('button, a, li, span, div[role="menuitem"], div[role="option"]'));
      return elements
        .map(el => ({ tag: el.tagName.toLowerCase(), text: (el.innerText || '').trim() }))
        .filter(el => /excel|txt|descargar|generar/i.test(el.text));
    });
    console.log('Opciones detectadas:', JSON.stringify(optionsAfterClick, null, 2));

    // Si hay opcion Excel, hacerle click
    const excelOption = page.locator('button, a, li, span, div[role="menuitem"]').filter({ hasText: /^Excel$/i }).first();
    if (await excelOption.count() > 0 && await excelOption.isVisible()) {
      console.log('Pulsando opcion Excel...');
      await excelOption.click();
      await page.waitForTimeout(3000);
    } else {
      const linkExcel = page.locator('a:has-text("Excel"), button:has-text("Excel")').first();
      if (await linkExcel.count() > 0 && await linkExcel.isVisible()) {
        console.log('Pulsando enlace/boton Excel...');
        await linkExcel.click();
        await page.waitForTimeout(3000);
      }
    }

    // Esperar descarga
    console.log('6. Esperando generacion/descarga del archivo...');
    for (let i = 0; i < 30; i++) {
      if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
        console.log('¡Archivo descargado exitosamente!', downloadedFilePath);
        break;
      }
      await page.waitForTimeout(2000);
    }

    // Comprobar si se creo el archivo en la carpeta reportes
    const outputDir = path.join(__dirname, 'reportes');
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir);
      console.log('Archivos en carpeta reportes:', files);
      if (files.some(f => f.endsWith('.xlsx') || f.endsWith('.zip') || f.endsWith('.csv'))) {
        console.log('7. Reporte generado y verificado.');
        await browser.close();

        // Procesar Excel y actualizar aplicativo interactivo (index.html)
        console.log('8. Procesando Excel y actualizando index.html...');
        try {
          const { execSync } = require('child_process');
          execSync('node generar_dashboard.js', { stdio: 'inherit' });
          console.log('Dashboard index.html actualizado con exito.');
          try {
            execSync('git add index.html', { stdio: 'inherit' });
          } catch (_) {}
        } catch (genErr) {
          console.error('Advertencia al generar dashboard:', genErr.message || genErr);
        }

        process.exit(0);
      }
    }

    console.log('Texto visible en la pagina tras la solicitud:');
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1500));
    console.log(bodyText);
    await page.screenshot({ path: 'error_screenshot.png', fullPage: true });

  } catch (error) {
    console.error('Error durante la ejecucion:', error.message || error);
    try {
      await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
    } catch (_) {}
    process.exit(1);
  } finally {
    if (fs.existsSync(tempStatePath)) {
      try { fs.unlinkSync(tempStatePath); } catch (_) {}
    }
    await browser.close();
  }
})();
