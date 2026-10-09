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
    await page.goto('https://siigonube.siigo.com/#/login', { waitUntil: 'networkidle', timeout: 60000 });

    console.log('2. Ingresando credenciales...');
    const userInput = page.locator('#siigoSignInName');
    await userInput.waitFor({ state: 'attached', timeout: 30000 });
    await userInput.fill(user);

    const passInput = page.locator('#siigoPassword');
    await passInput.fill(pass);
    
    console.log('3. Enviando formulario de acceso...');
    const nextBtn = page.locator('#siigoNext');
    await nextBtn.click();

    console.log('4. Esperando redireccion de Azure B2C a Siigo Nube...');
    await page.waitForURL(url => !url.href.includes('account.siigo.com'), { timeout: 60000 });
    console.log('5. Autenticacion exitosa. URL actual:', page.url());

    console.log('6. Esperando carga del entorno de Siigo...');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(6000);

    console.log('URL tras carga:', page.url());
    console.log('Titulo de la pagina:', await page.title());

    // Si hay un modal o diálogo emergente, intentar cerrarlo
    const closeButtons = page.locator('button[aria-label="Close"], button:has-text("Cerrar"), button:has-text("Entendido"), .modal-close');
    if (await closeButtons.count() > 0) {
      console.log('Cerrando ventana emergente detectada...');
      await closeButtons.first().click().catch(() => {});
    }

    const navItems = await page.locator('nav a, aside a, .sidebar a, [role="navigation"] a').allInnerTexts().catch(() => []);
    console.log('Opciones de navegacion encontradas:', navItems.filter(t => t.trim()));

    console.log('7. Buscando menu Reportes...');
    const reportesLocator = page.locator('text=Reportes, a:has-text("Reportes"), [aria-label*="Reportes"], button:has-text("Reportes")').first();
    await reportesLocator.waitFor({ state: 'visible', timeout: 30000 });
    await reportesLocator.click();
    console.log('Clic en Reportes realizado');
    await page.waitForTimeout(2500);

    console.log('8. Buscando reporte de movimiento auxiliar...');
    const auxLocator = page.locator('text=Movimiento auxiliar de tercero por cuenta contable').first();
    await auxLocator.waitFor({ state: 'visible', timeout: 30000 });
    await auxLocator.click();
    console.log('Reporte seleccionado');
    await page.waitForTimeout(3000);

    console.log('9. Solicitando exportacion a Excel...');
    const [ download ] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      page.click('button:has-text("Excel"), button:has-text("Exportar a Excel"), [aria-label*="Excel"]')
    ]);

    const outputDir = path.join(__dirname, 'reportes');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const fecha = new Date().toISOString().split('T')[0];
    const targetFile = path.join(outputDir, 'Movimiento_auxiliar_' + fecha + '.xlsx');
    
    await download.saveAs(targetFile);
    console.log('10. Reporte guardado con exito en:', targetFile);

  } catch (error) {
    console.error('Error durante la ejecucion:', error.message || error);
    try {
      console.log('URL al momento del error:', page.url());
      console.log('Titulo al momento del error:', await page.title());
      const bodySnippet = await page.locator('body').innerText().catch(() => '');
      console.log('Contenido visible en pantalla (primeros 800 caracteres):\n', bodySnippet.substring(0, 800));
      await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
    } catch (_) {}
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
