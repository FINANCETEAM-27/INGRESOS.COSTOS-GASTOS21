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

    console.log('4. Esperando redireccion a Siigo Nube...');
    await page.waitForURL(url => !url.href.includes('account.siigo.com'), { timeout: 60000 });
    console.log('5. Autenticacion exitosa. URL inicial:', page.url());

    console.log('6. Esperando carga del dashboard...');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(6000);

    console.log('URL actual tras carga:', page.url());
    console.log('Titulo:', await page.title());

    // Analisis exhaustivo de la interfaz
    const domInfo = await page.evaluate(() => {
      // 1. Frames
      const frames = Array.from(window.frames).map(f => {
        try { return f.location.href; } catch(e) { return 'cross-origin'; }
      });

      // 2. Elementos con texto relacionado con reportes o informes
      const allElements = Array.from(document.querySelectorAll('*'));
      const reportMatches = [];
      const menuCandidates = [];

      for (const el of allElements) {
        const text = (el.innerText || '').trim();
        const aria = el.getAttribute('aria-label') || '';
        const title = el.getAttribute('title') || '';
        const id = el.id || '';
        const cls = typeof el.className === 'string' ? el.className : '';

        // Buscar coincidencias de reportes
        if (/reporte|informe/i.test(text) || /reporte|informe/i.test(aria) || /reporte|informe/i.test(title)) {
          reportMatches.push({
            tag: el.tagName.toLowerCase(),
            text: text.substring(0, 60),
            id,
            cls,
            aria,
            title
          });
        }

        // Detectar elementos interactivos del menu lateral o superior
        if (['A', 'BUTTON', 'LI', 'MAT-LIST-ITEM', 'SIIGO-MENU-ITEM'].includes(el.tagName) || el.getAttribute('role') === 'button') {
          if (text && text.length < 35 && !text.includes('\n')) {
            menuCandidates.push({
              tag: el.tagName.toLowerCase(),
              text,
              id,
              href: el.getAttribute('href') || ''
            });
          }
        }
      }

      return {
        frames,
        reportMatches: reportMatches.slice(0, 15),
        menuCandidates: Array.from(new Set(menuCandidates.map(m => `${m.tag}:${m.text}:${m.href}`))).slice(0, 40)
      };
    });

    console.log('Frames detectados:', domInfo.frames);
    console.log('Coincidencias con Reportes/Informes:', JSON.stringify(domInfo.reportMatches, null, 2));
    console.log('Opciones de menu interactivo detectadas:', JSON.stringify(domInfo.menuCandidates, null, 2));

    // Si encontramos algún elemento que dice "Reportes", hagamos clic en el más específico
    console.log('7. Buscando y pulsando Reportes...');
    const reportBtn = page.locator('text=/^Reportes$/i, a:has-text("Reportes"), button:has-text("Reportes"), [title*="Reportes"], [aria-label*="Reportes"]').first();
    
    if (await reportBtn.isVisible()) {
      await reportBtn.click();
      console.log('Boton de Reportes pulsado exitosamente');
      await page.waitForTimeout(3000);
    } else {
      console.log('Buscando menu lateral o desplegable...');
      // Intentar abrir el menú lateral si está colapsado (hamburguesa o boton de menu)
      const menuToggle = page.locator('button[aria-label*="menu" i], .menu-icon, .hamburger, [class*="sidebar-toggle"], [class*="menu-toggle"], [id*="menu"]').first();
      if (await menuToggle.isVisible()) {
        console.log('Menu hamburguesa detectado, pulsando para desplegar...');
        await menuToggle.click();
        await page.waitForTimeout(1500);
      }
      await reportBtn.waitFor({ state: 'visible', timeout: 15000 });
      await reportBtn.click();
    }

    console.log('8. Buscando reporte de movimiento auxiliar...');
    const auxLocator = page.locator('text=/movimiento auxiliar de tercero por cuenta contable/i').first();
    await auxLocator.waitFor({ state: 'visible', timeout: 30000 });
    await auxLocator.click();
    console.log('Reporte seleccionado con exito');
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
      await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
    } catch (_) {}
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
