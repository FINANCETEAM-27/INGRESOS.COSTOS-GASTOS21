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

    // Esperar a que cargue la pantalla de login de Siigo (Azure B2C)
    console.log('2. Ingresando credenciales en Siigo...');
    await page.waitForSelector('#siigoSignInName, #signInName', { timeout: 30000 });

    const usernameSelector = (await page.isVisible('#siigoSignInName')) ? '#siigoSignInName' : '#signInName';
    const passwordSelector = (await page.isVisible('#siigoPassword')) ? '#siigoPassword' : '#password';
    const nextBtnSelector = (await page.isVisible('#siigoNext')) ? '#siigoNext' : '#next';

    await page.fill(usernameSelector, user);
    await page.fill(passwordSelector, pass);
    
    console.log('3. Enviando formulario de acceso...');
    await page.click(nextBtnSelector);

    // Esperar a que Siigo autentique y vuelva al panel principal
    await page.waitForURL(/siigonube\.siigo\.com/, { timeout: 60000 });
    await page.waitForLoadState('networkidle');
    console.log('4. Sesión iniciada correctamente en Siigo Nube.');

    // Tomar captura de confirmación de entrada
    await page.waitForTimeout(3000);

    // Navegar a Reportes > Movimiento auxiliar de tercero por cuenta contable
    console.log('5. Navegando al reporte de movimiento auxiliar...');
    await page.click('text=Reportes');
    await page.waitForTimeout(2000);

    await page.click('text=Movimiento auxiliar de tercero por cuenta contable');
    await page.waitForTimeout(3000);

    // Preparar captura de la descarga
    console.log('6. Solicitando exportación a Excel...');
    const [ download ] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
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
    console.log(`7. Reporte guardado con éxito en: ${targetFile}`);

  } catch (error) {
    console.error('Error durante la ejecución:', error);
    await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
