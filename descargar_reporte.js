const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1280, height: 720 }
  });
  const page = await context.newPage();

  const user = process.env.SIIGO_USER;
  const pass = process.env.SIIGO_PASS;

  if (!user || !pass) {
    console.error('Faltan las credenciales SIIGO_USER o SIIGO_PASS');
    process.exit(1);
  }

  try {
    console.log('1. Abriendo página de inicio de sesión de Siigo...');
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

    console.log('4. Esperando autenticación en Siigo Nube...');
    // Esperar a salir de la pantalla de Azure B2C
    await Promise.race([
      page.waitForURL(url => !url.href.includes('account.siigo.com'), { timeout: 45000 }),
      page.waitForTimeout(5000)
    ]);

    // Verificar si hubo error de contraseña o usuario
    if (page.url().includes('account.siigo.com')) {
      const errorText = await page.locator('.error, [role="alert"]').allInnerTexts();
      const cleanErrors = errorText.map(t => t.trim()).filter(Boolean);
      if (cleanErrors.length > 0) {
        throw new Error(`Siigo rechazó las credenciales: ${cleanErrors.join(' - ')}`);
      }
    }

    await page.waitForLoadState('networkidle');
    console.log('5. Sesión iniciada con éxito. Navegando al menú de reportes...');
    await page.waitForTimeout(3000);

    // Navegar a Reportes > Movimiento auxiliar de tercero por cuenta contable
    console.log('6. Buscando opción Reportes...');
    await page.click('text=Reportes');
    await page.waitForTimeout(2000);

    console.log('7. Abriendo Movimiento auxiliar de tercero por cuenta contable...');
    await page.click('text=Movimiento auxiliar de tercero por cuenta contable');
    await page.waitForTimeout(3000);

    // Preparar captura de la descarga
    console.log('8. Solicitando exportación a Excel...');
    const [ download ] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      page.click('button:has-text("Excel"), button:has-text("Exportar a Excel"), [aria-label="Descargar Excel"]')
    ]);

    // Asegurar directorio destino
    const outputDir = path.join(__dirname, 'reportes');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const fecha = new Date().toISOString().split('T')[0];
    const targetFile = path.join(outputDir, `Movimiento_auxiliar_${fecha}.xlsx`);
    
    await download.saveAs(targetFile);
    console.log(`9. Reporte guardado con éxito en: ${targetFile}`);

  } catch (error) {
    console.error('Error durante la ejecución:', error.message || error);
    try {
      await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
    } catch (_) {}
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
