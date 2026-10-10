const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1366, height: 768 }
  });
  const page = await context.newPage();

  const user = process.env.SIIGO_USER;
  const pass = process.env.SIIGO_PASS;

  if (!user || !pass) {
    console.error('Faltan las credenciales SIIGO_USER o SIIGO_PASS');
    process.exit(1);
  }

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
    console.log('1. Abriendo pantalla de autenticacion de Siigo...');
    await page.goto('https://siigonube.siigo.com/#/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log('2. Ingresando credenciales...');
    const userInput = page.locator('#siigoSignInName');
    await userInput.waitFor({ state: 'attached', timeout: 30000 });
    await userInput.fill(user);

    const passInput = page.locator('#siigoPassword');
    await passInput.fill(pass);
    
    console.log('3. Enviando formulario de acceso...');
    const nextBtn = page.locator('#siigoNext');
    await nextBtn.click();

    console.log('4. Esperando redireccion a Siigo Nube...');
    await page.waitForURL(url => !url.href.includes('account.siigo.com'), { timeout: 60000 });
    console.log('5. Autenticacion exitosa.');

    console.log('6. Esperando carga del entorno inicial...');
    await page.waitForTimeout(6000);

    console.log('7. Navegando al reporte: Movimiento auxiliar de tercero por cuenta contable en Excel...');
    await page.goto('https://siigonube.siigo.com/#/reports-excel/1979', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    console.log('URL actual del reporte:', page.url());

    // Click en Generar reporte
    console.log('8. Buscando boton Generar reporte...');
    const genButton = page.locator('button:has-text("Generar reporte")').first();
    await genButton.waitFor({ state: 'visible', timeout: 20000 });
    console.log('Pulsando boton Generar reporte...');
    await genButton.click();
    await page.waitForTimeout(3000);

    // Ver si se desplegaron opciones (Excel / TXT o modal)
    const optionsAfterClick = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('button, a, li, span, div[role="menuitem"], div[role="option"]'));
      return elements
        .map(el => ({ tag: el.tagName.toLowerCase(), text: (el.innerText || '').trim() }))
        .filter(el => /excel|txt|descargar|generar/i.test(el.text));
    });
    console.log('Opciones detectadas tras pulsar Generar reporte:', JSON.stringify(optionsAfterClick, null, 2));

    // Si hay opcion Excel, hacerle click
    const excelOption = page.locator('button, a, li, span, div[role="menuitem"]').filter({ hasText: /^Excel$/i }).first();
    if (await excelOption.count() > 0 && await excelOption.isVisible()) {
      console.log('Pulsando opcion Excel...');
      await excelOption.click();
      await page.waitForTimeout(3000);
    } else {
      // Probar si el enlace <a> era el dropdown o submenu
      const linkExcel = page.locator('a:has-text("Excel"), button:has-text("Excel")').first();
      if (await linkExcel.count() > 0 && await linkExcel.isVisible()) {
        console.log('Pulsando enlace/boton Excel...');
        await linkExcel.click();
        await page.waitForTimeout(3000);
      }
    }

    // Esperar hasta 60s si se detecta descarga o cambio en pantalla
    console.log('9. Esperando generacion/descarga del archivo...');
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
        console.log('10. Reporte generado y verificado.');
        process.exit(0);
      }
    }

    // Si no descargo, tomar captura y volcar alertas/toasts
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
    await browser.close();
  }
})();
