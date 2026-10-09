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

    // Analizar frames
    console.log('Frames en la pagina:', page.frames().map(f => f.url()));

    // Buscar en el HTML
    const html = await page.content();
    fs.writeFileSync('siigo_page.html', html);
    console.log('HTML guardado. Contiene "reporte":', html.toLowerCase().includes('reporte'));
    console.log('HTML contiene "informe":', html.toLowerCase().includes('informe'));
    console.log('HTML contiene "contabilidad":', html.toLowerCase().includes('contabilidad'));

    // Inspeccionar que ocurre con "Buscar en Siigo"
    console.log('7. Pulsando "Buscar en Siigo"...');
    const searchBtn = page.locator('button[aria-label="Buscar en Siigo"]').first();
    await searchBtn.click();
    await page.waitForTimeout(1500);

    const searchInput = page.locator('input[placeholder*="Buscar" i], input[type="search"], input[type="text"]:visible').first();
    await searchInput.fill('movimiento auxiliar');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);

    // Listar todos los textos visibles tras la busqueda
    const searchTexts = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('li, [role="option"], a, p, span, h6'))
        .map(el => (el.innerText || '').trim())
        .filter(t => t.length > 3 && t.length < 70);
    });
    console.log('Textos detectados tras busqueda:', Array.from(new Set(searchTexts)).slice(0, 30));

    // Si encontramos algun enlace con movimiento auxiliar, pulsar
    const matched = page.locator('text=/movimiento auxiliar/i').first();
    if (await matched.isVisible()) {
      console.log('Enlace encontrado, pulsando...');
      await matched.click();
      await page.waitForTimeout(4000);
    } else {
      console.log('No se encontro por busqueda. Analizando navegacion directa...');
    }

    console.log('URL final:', page.url());

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
