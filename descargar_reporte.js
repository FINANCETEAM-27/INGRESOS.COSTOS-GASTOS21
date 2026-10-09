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
    await page.goto('https://siigonube.siigo.com/#/login', { waitUntil: 'networkidle' });

    // Iniciar sesión
    console.log('2. Ingresando credenciales...');
    await page.fill('input[type="email"], input[name="username"], #username-input', user);
    await page.fill('input[type="password"], input[name="password"], #password-input', pass);
    
    // Clic en ingresar
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.click('button[type="submit"], #btn-login, button:has-text("Ingresar")')
    ]);

    console.log('3. Sesión iniciada correctamente.');

    // Navegar a Reportes > Movimiento auxiliar de tercero por cuenta contable
    console.log('4. Navegando al reporte de movimiento auxiliar...');
    // Clic en menú Reportes
    await page.click('text=Reportes');
    await page.waitForTimeout(1500);

    // Seleccionar Financieros / Contables y luego el reporte exacto
    await page.click('text=Movimiento auxiliar de tercero por cuenta contable');
    await page.waitForTimeout(2000);

    // Preparar captura de la descarga
    console.log('5. Solicitando exportación a Excel...');
    const [ download ] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      // Selector del botón de descargar Excel en Siigo
      page.click('button:has-text("Excel"), button:has-text("Exportar a Excel"), [aria-label="Descargar Excel"]')
    ]);

    // Asegurar directorio destino
    const outputDir = path.join(__dirname, 'reportes');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Guardar con fecha actual en el nombre
    const fecha = new Date().toISOString().split('T')[0];
    const targetFile = path.join(outputDir, `Movimiento_auxiliar_${fecha}.xlsx`);
    
    await download.saveAs(targetFile);
    console.log(`6. Reporte guardado con éxito en: ${targetFile}`);

  } catch (error) {
    console.error('Error durante la ejecución:', error);
    // Tomar captura de pantalla si falla para diagnosticar
    await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
