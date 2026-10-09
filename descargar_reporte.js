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
    console.log('5. Autenticacion exitosa.');

    console.log('6. Esperando carga del entorno inicial...');
    await page.waitForTimeout(6000);

    // Navegación directa o mediante buscador al reporte exacto
    console.log('7. Navegando al reporte: Movimiento auxiliar de tercero por cuenta contable en Excel...');
    await page.goto('https://siigonube.siigo.com/#/reports-excel/1979', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    console.log('URL actual del reporte:', page.url());

    // Analizar formulario y botones en la pantalla del reporte
    const controls = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input, select, textarea')).map(i => ({
        tag: i.tagName.toLowerCase(),
        type: i.type,
        name: i.name,
        id: i.id,
        placeholder: i.placeholder,
        value: i.value
      }));
      const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]')).map(b => ({
        tag: b.tagName.toLowerCase(),
        text: (b.innerText || '').trim(),
        aria: b.getAttribute('aria-label') || '',
        title: b.getAttribute('title') || ''
      })).filter(b => b.text || b.aria || b.title);
      return { inputs, buttons };
    });

    console.log('Campos detectados en el formulario:', JSON.stringify(controls.inputs, null, 2));
    console.log('Botones detectados:', JSON.stringify(controls.buttons, null, 2));

    // Buscar boton de Generar reporte o Descargar
    console.log('8. Solicitando generacion y descarga de Excel...');
    const generateBtn = page.locator('button, a, [role="button"]').filter({ hasText: /generar reporte|descargar|buscar|exportar/i }).first();
    await generateBtn.waitFor({ state: 'visible', timeout: 20000 });
    
    // Preparar escucha de descarga
    const [ download ] = await Promise.all([
      page.waitForEvent('download', { timeout: 90000 }),
      (async () => {
        await generateBtn.click();
        await page.waitForTimeout(2000);
        // Si aparece un submenu o modal para elegir Excel vs TXT
        const excelChoice = page.locator('button, a, li, span').filter({ hasText: /^Excel$/i, hasNotText: /txt/i });
        if (await excelChoice.count() > 0 && await excelChoice.first().isVisible()) {
          console.log('Seleccionando opcion Excel en modal...');
          await excelChoice.first().click();
        }
      })()
    ]);

    const outputDir = path.join(__dirname, 'reportes');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const fecha = new Date().toISOString().split('T')[0];
    const targetFile = path.join(outputDir, 'Movimiento_auxiliar_' + fecha + '.xlsx');
    
    await download.saveAs(targetFile);
    console.log('9. Reporte guardado con exito en:', targetFile);

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
