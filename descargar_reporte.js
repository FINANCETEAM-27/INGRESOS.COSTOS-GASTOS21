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
    console.log('5. Autenticacion exitosa. URL inicial:', page.url());

    console.log('6. Esperando carga del dashboard...');
    await page.waitForTimeout(8000);
    console.log('URL actual:', page.url());

    // 7. Usar el buscador global "Buscar en Siigo"
    console.log('7. Abriendo "Buscar en Siigo"...');
    const searchBtn = page.locator('button[aria-label="Buscar en Siigo"]').first();
    await searchBtn.waitFor({ state: 'visible', timeout: 15000 });
    await searchBtn.click();
    await page.waitForTimeout(1500);

    console.log('8. Escribiendo nombre del reporte en el buscador...');
    const searchInput = page.locator('input[placeholder*="Buscar" i], input[type="search"], input[type="text"]:visible').first();
    await searchInput.waitFor({ state: 'visible', timeout: 10000 });
    await searchInput.fill('Movimiento auxiliar de tercero por cuenta contable');
    await page.waitForTimeout(2500);

    // Listar resultados encontrados
    const foundOptions = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('li, [role="option"], a, div'))
        .map(el => (el.innerText || '').trim())
        .filter(t => /movimiento auxiliar/i.test(t) && t.length < 80);
    });
    console.log('Resultados de busqueda detectados:', Array.from(new Set(foundOptions)));

    // Seleccionar la opcion que corresponda al reporte
    const reportOption = page.locator('li, [role="option"], a').filter({ hasText: /movimiento auxiliar de tercero por cuenta contable/i }).first();
    await reportOption.waitFor({ state: 'visible', timeout: 15000 });
    await reportOption.click();
    console.log('9. Clic en el reporte realizado. Esperando pantalla del reporte...');
    await page.waitForTimeout(5000);

    console.log('URL de la pantalla del reporte:', page.url());

    // 10. Identificar filtros y boton de exportar a Excel
    console.log('10. Buscando boton de exportacion a Excel...');
    const exportElements = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button, a, [role="button"], span'))
        .map(el => ({
          text: (el.innerText || '').trim(),
          aria: el.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || ''
        }))
        .filter(el => /excel|exportar|descargar/i.test(el.text) || /excel|exportar|descargar/i.test(el.aria) || /excel|exportar|descargar/i.test(el.title));
    });
    console.log('Botones de exportacion encontrados:', exportElements);

    const [ download ] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      page.click('button:has-text("Excel"), button:has-text("Exportar a Excel"), [aria-label*="Excel" i], [title*="Excel" i], button:has-text("Exportar")')
    ]);

    const outputDir = path.join(__dirname, 'reportes');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const fecha = new Date().toISOString().split('T')[0];
    const targetFile = path.join(outputDir, 'Movimiento_auxiliar_' + fecha + '.xlsx');
    
    await download.saveAs(targetFile);
    console.log('11. Reporte guardado con exito en:', targetFile);

  } catch (error) {
    console.error('Error durante la ejecucion:', error.message || error);
    try {
      console.log('URL al momento del error:', page.url());
      console.log('Titulo al momento del error:', await page.title());
      await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
    } catch (_) {}
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
