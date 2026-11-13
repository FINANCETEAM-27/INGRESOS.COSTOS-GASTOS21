const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  console.log('====================================================');
  console.log('  GENERADOR DE SESION DE SIIGO NUBE (PARA 2FA / SMS) ');
  console.log('====================================================\n');
  console.log('1. Abriendo ventana del navegador...');
  console.log('2. Inicia sesion en Siigo con tu correo, clave y codigo SMS.');
  console.log('3. Una vez ingreses a Siigo Nube, este script guardara la sesion automaticamente.\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 }
  });
  const page = await context.newPage();

  await page.goto('https://siigonube.siigo.com/#/login');

  try {
    await page.waitForURL(url => url.href.includes('siigonube.siigo.com') && !url.href.includes('account.siigo.com') && !url.href.includes('/login'), { timeout: 600000 });
    
    console.log('Inicio de sesion detectado. Esperando consolidacion de cookies y tokens...');
    await page.waitForTimeout(6000);

    const outputPath = path.join(__dirname, 'siigo_session.json');
    await context.storageState({ path: outputPath });

    console.log('\n====================================================');
    console.log('  ¡SESION CAPTURADA EXITOSAMENTE!                   ');
    console.log('====================================================');
    console.log(`Archivo generado: ${outputPath}`);
    console.log('\nInstrucciones para GitHub:');
    console.log('1. Abre el archivo "siigo_session.json" generado.');
    console.log('2. Copia todo su contenido (texto JSON completo).');
    console.log('3. En tu repositorio de GitHub:');
    console.log('   Settings -> Secrets and variables -> Actions');
    console.log('4. Si ya existe SIIGO_STORAGE_STATE, editalo; si no, pulsa "New repository secret".');
    console.log('5. Nombre: SIIGO_STORAGE_STATE');
    console.log('6. Pega el contenido y guarda.');
    console.log('====================================================\n');
  } catch (error) {
    console.error('Error o tiempo limite agotado:', error.message);
  } finally {
    await browser.close();
  }
})();
