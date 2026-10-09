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

    console.log('URL actual tras carga:', page.url());
    console.log('Titulo:', await page.title());

    // Analizar todos los botones y enlaces de la barra superior y lateral
    const elementsInfo = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], a')).map(b => ({
        tag: b.tagName.toLowerCase(),
        text: (b.innerText || '').trim(),
        aria: b.getAttribute('aria-label') || '',
        title: b.getAttribute('title') || '',
        cls: (typeof b.className === 'string' ? b.className : '').substring(0, 50),
        id: b.id || '',
        href: b.getAttribute('href') || ''
      }));
      return buttons.filter(b => b.text || b.aria || b.title || b.href);
    });

    console.log('Botones y enlaces interactivos:', JSON.stringify(elementsInfo, null, 2));

    // Revisar si existe el boton de menu lateral (hamburguesa) o si Reportes ya esta visible
    console.log('7. Buscando acceso a Reportes...');
    
    // Intento A: Si hay un texto visible directo que diga Reportes
    const directReport = page.locator('a, button, span, li, p').filter({ hasText: /^Reportes$/i });
    if (await directReport.count() > 0 && await directReport.first().isVisible()) {
      console.log('Boton directo de Reportes encontrado, haciendo clic...');
      await directReport.first().click();
    } else {
      console.log('Reportes no visible directamente. Buscando icono o menu lateral...');
      // Buscar boton hamburguesa o boton con icono de menu
      const menuButton = page.locator('button[aria-label*="menu" i], button[title*="menu" i], .navbar-toggle, .menu-toggle, [class*="hamburger"], [class*="menu-btn"]').first();
      if (await menuButton.isVisible()) {
        console.log('Pulsando boton de menu...');
        await menuButton.click();
        await page.waitForTimeout(2000);
      }
      
      // Probar si el enlace Reportes aparece ahora
      const reportLink = page.locator('text=Reportes').first();
      await reportLink.waitFor({ state: 'visible', timeout: 15000 });
      await reportLink.click();
    }

    console.log('8. Seccion Reportes abierta. Esperando opciones...');
    await page.waitForTimeout(3000);

    console.log('9. Buscando reporte de movimiento auxiliar...');
    // Primero buscar si esta la opcion en pantalla
    const auxLocator = page.locator('text=/movimiento auxiliar de tercero por cuenta contable/i').first();
    await auxLocator.waitFor({ state: 'visible', timeout: 30000 });
    await auxLocator.click();
    console.log('Reporte seleccionado con exito');
    await page.waitForTimeout(3000);

    console.log('10. Solicitando exportacion a Excel...');
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
