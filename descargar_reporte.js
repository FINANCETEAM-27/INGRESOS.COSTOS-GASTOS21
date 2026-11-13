const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const isCI = !!process.env.CI;
const sessionPath = path.join(__dirname, 'siigo_session.json');

// Cargar variables de entorno desde .env local si existe
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let val = (match[2] || '').trim().replace(/^['"](.*)['"]$/, '$1');
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch (_) {}
}

const user = process.env.SIIGO_USER;
const pass = process.env.SIIGO_PASS;

let downloadedFilePath = null;

function configurarInterceptores(page) {
  page.on('download', async (download) => {
    console.log('Evento de descarga detectado:', download.suggestedFilename());
    const outputDir = path.join(__dirname, 'reportes');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const target = path.join(outputDir, download.suggestedFilename() || 'reporte.xlsx');
    await download.saveAs(target);
    downloadedFilePath = target;
    console.log('Descarga completada y guardada en:', target);
  });

  page.on('response', async (response) => {
    const url = response.url();
    const headers = response.headers();
    const disposition = headers['content-disposition'] || '';
    if (disposition.includes('attachment') || url.includes('.xlsx') || url.includes('export') || url.includes('download')) {
      console.log('Respuesta sospechosa de archivo:', url, 'Disposition:', disposition);
    }
  });
}

async function ejecutarLoginAutomatico(page, user, pass) {
  console.log('Abriendo pantalla de inicio de sesión de Siigo...');
  await page.goto('https://siigonube.siigo.com/#/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('Ingresando credenciales para: ' + user + '...');
  const userInput = page.locator('#siigoSignInName');
  await userInput.waitFor({ state: 'attached', timeout: 30000 });
  await userInput.fill(user);

  const passInput = page.locator('#siigoPassword');
  await passInput.fill(pass);

  console.log('Enviando formulario de acceso...');
  const nextBtn = page.locator('#siigoNext');
  await nextBtn.click();

  console.log('Esperando autenticación y redirección...');
  // Si el usuario no pide SMS, redirige directamente al cluster
  await page.waitForURL(url => {
    const href = url.href;
    return !href.includes('account.siigo.com') &&
           !href.includes('openid-callback') &&
           !href.includes('oauth2') &&
           !href.includes('#/login') &&
           (href.includes('siigonube.siigo.com') || href.includes('siigonube2.siigo.com'));
  }, { timeout: isCI ? 60000 : 300000 });

  console.log('¡Inicio de sesión exitoso!');
  await page.waitForTimeout(5000);
}

async function ejecutarLoginInteractivo() {
  console.log('\n======================================================');
  console.log('⚠️ SE REQUIERE VERIFICACIÓN / RENOVACIÓN DE SESIÓN EN SIIGO');
  console.log('👉 Abriendo la ventana del navegador en tu pantalla...');
  console.log('👉 Por favor inicia sesión e ingresa el código SMS si lo solicita.');
  console.log('======================================================\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true
  });
      const page = await context.newPage();

    page.on('console', msg => {
      const t = msg.text();
      if (msg.type() === 'error' || /catastrophic|fail|error|cannot read|undefined|unauthorized/i.test(t)) {
        console.log('[BROWSER CONSOLE ' + msg.type() + ']: ' + t.slice(0, 350));
      }
    });

    page.on('pageerror', err => {
      console.log('[BROWSER PAGEERROR]: ' + (err.stack || err.message).slice(0, 500));
    });
  configurarInterceptores(page);

  console.log('Cargando Siigo Nube...');
  await page.goto('https://siigonube.siigo.com/#/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log('Esperando a que completes la autenticación en la ventana (tienes hasta 10 minutos)...');
  await page.waitForURL(url => {
    const href = url.href;
    return !href.includes('account.siigo.com') &&
           !href.includes('openid-callback') &&
           !href.includes('oauth2') &&
           !href.includes('#/login') &&
           (href.includes('siigonube.siigo.com') || href.includes('siigonube2.siigo.com'));
  }, { timeout: 600000 });

  console.log('¡Autenticación completada exitosamente!');
  await page.waitForTimeout(5000);

  await context.storageState({ path: sessionPath });
  console.log('✓ Sesión actualizada y guardada en siigo_session.json.');

  return { browser, context, page };
}

(async () => {
  let browser = null;
  let context = null;
  let page = null;

  const contextOptions = {
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 }
  };

  const storageStateRaw = process.env.SIIGO_STORAGE_STATE;
  let hasStoredSession = false;

  if (storageStateRaw && storageStateRaw.trim().length > 10) {
    try {
      fs.writeFileSync(sessionPath, storageStateRaw.trim());
      contextOptions.storageState = sessionPath;
      hasStoredSession = true;
      console.log('Se detectó sesión guardada en SIIGO_STORAGE_STATE.');
    } catch (e) {
      console.warn('No se pudo escribir archivo de sesión desde env:', e.message);
    }
  } else if (fs.existsSync(sessionPath)) {
    try {
      const content = fs.readFileSync(sessionPath, 'utf8');
      if (content && content.trim().length > 10) {
        contextOptions.storageState = sessionPath;
        hasStoredSession = true;
        console.log('Se detectó archivo local siigo_session.json.');
      }
    } catch (e) {
      console.warn('Error leyendo siigo_session.json local:', e.message);
    }
  }

  let sessionValida = false;

  // Paso 1: Intento en segundo plano con sesión previa si existe
  if (hasStoredSession) {
    try {
      console.log('1. Probando acceso con la sesión guardada previa...');
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext(contextOptions);
      page = await context.newPage();
      configurarInterceptores(page);

      await page.goto('https://siigonube.siigo.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(6000);

      const currentUrl = page.url();
      console.log('URL actual comprobada:', currentUrl);

      if (!currentUrl.includes('account.siigo.com') && !currentUrl.includes('#/login') && !currentUrl.includes('openid-callback')) {
        sessionValida = true;
        console.log('✓ Sesión previa aún válida y activa.');
      } else {
        console.log('⚠️ La sesión previa expiró o Siigo solicita login.');
      }
    } catch (errBackground) {
      console.log('No se pudo reusar la sesión previa:', errBackground.message);
      sessionValida = false;
    } finally {
      if (!sessionValida && browser) {
        try { await browser.close(); } catch (_) {}
        browser = null;
        context = null;
        page = null;
      }
    }
  }

  // Paso 2: Si no hay sesión válida, autenticar
  if (!sessionValida) {
    if (user && pass) {
      console.log('2. Iniciando autenticación automática con credenciales configuradas...');
      browser = await chromium.launch({ headless: isCI });
      context = await browser.newContext({
        acceptDownloads: true,
        viewport: { width: 1440, height: 900 }
      });
      page = await context.newPage();
      configurarInterceptores(page);

      await ejecutarLoginAutomatico(page, user, pass);

      // Guardar la sesión generada para futuras ejecuciones
      try {
        await context.storageState({ path: sessionPath });
        console.log('✓ Nueva sesión guardada en siigo_session.json.');
      } catch (errStore) {
        console.warn('Aviso guardando storageState:', errStore.message);
      }
    } else if (!isCI) {
      console.log('No hay credenciales en variables de entorno. Iniciando modo interactivo...');
      const interactivo = await ejecutarLoginInteractivo();
      browser = interactivo.browser;
      context = interactivo.context;
      page = interactivo.page;
    } else {
      console.error('Error: Se requiere autenticación pero no se proporcionaron SIIGO_USER / SIIGO_PASS en CI.');
      process.exit(1);
    }
  }

  try {
    // 3. Navegar al reporte contable
    console.log('3. Buscando reporte contable mediante buscador rápido...');
    await page.waitForTimeout(6000);

    // Activar el buscador rápido mediante DOM directo para evitar bloqueos de viewport
    await page.evaluate(() => {
      const searchIcon = document.querySelector('.imgQuickSearch') ||
                         document.querySelector('[class*="quickSearch"]') ||
                         document.querySelector('[class*="search"]') ||
                         document.querySelector('button[aria-label*="Buscar"]');
      if (searchIcon) {
        searchIcon.click();
      }
    });
    await page.waitForTimeout(2000);

    // Escribir en el campo de búsqueda
    const searchFilled = await page.evaluate(() => {
      const inp = document.querySelector('input[placeholder*="Buscar opción de menú" i]') ||
                  document.querySelector('input[placeholder*="Buscar" i]') ||
                  document.querySelector('input[type="search"]') ||
                  document.querySelector('.quickSearch input') ||
                  document.querySelector('input');
      if (inp) {
        inp.focus();
        inp.value = 'Movimiento auxiliar';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'r', bubbles: true }));
        return true;
      }
      return false;
    });
    console.log('¿Campo de búsqueda rellenado con éxito?:', searchFilled);
    await page.waitForTimeout(3500);

    // Listar resultados arrojados
    const searchOptions = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('a, li, [role="option"], div, span'))
        .map(el => ({
          text: (el.innerText || '').trim(),
          href: el.getAttribute('href') || '',
          tag: el.tagName.toLowerCase()
        }))
        .filter(item => /movimiento auxiliar/i.test(item.text) && item.text.length < 80);
      return items;
    });
    console.log('Opciones de búsqueda encontradas:', JSON.stringify(searchOptions));

    // Si hay una opción encontrada, hacer clic
    let optionClicked = false;
    if (searchOptions.length > 0) {
      console.log('Haciendo clic en la opción de reporte encontrada...');
      optionClicked = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('a, li, [role="option"], div, span'));
        const target = els.find(el => /movimiento auxiliar/i.test((el.innerText || '').trim()));
        if (target) {
          target.click();
          return true;
        }
        return false;
      });
      await page.waitForTimeout(8000);
    }

    // Volcar todos los elementos del menú lateral y navegación
    const navItems = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('nav, aside, ul, li, a, button').forEach(el => {
        const text = (el.innerText || '').trim();
        const aria = el.getAttribute('aria-label') || '';
        const title = el.getAttribute('title') || '';
        const href = el.getAttribute('href') || '';
        if (text || aria || title || href) {
          items.push({ text: text.slice(0, 30), aria, title, href });
        }
      });
      return items.filter(i => /report|informe|contab|movim/i.test(i.text) || /report|informe|contab|movim/i.test(i.aria) || /report|informe|contab|movim/i.test(i.title) || /report/i.test(i.href)).slice(0, 20);
    });
    console.log('Elementos de navegación relacionados con reportes/contabilidad:', JSON.stringify(navItems));

    // Si aún no está en el reporte, intentar navegación directa
    if (!page.url().includes('reports-excel') && !page.url().includes('report')) {
      const currentOrigin = new URL(page.url()).origin;
      const reportUrl = `${currentOrigin}/#/reports-excel/1979`;
      console.log('Navegando directamente por URL:', reportUrl);
      await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(8000);
    }

    console.log('URL actual tras navegación:', page.url());

    // 5. Pulsar Generar reporte
    console.log('5. Buscando botón Generar reporte...');
    const genButton = page.locator('button:has-text("Generar reporte"), a:has-text("Generar reporte"), button:has-text("Descargar"), button:has-text("Exportar")').first();
    try {
      await genButton.waitFor({ state: 'visible', timeout: 35000 });
    } catch (btnErr) {
      console.warn('Botón de reporte no visible de inmediato. Volcado de texto visible:');
      const bodySnippet = await page.evaluate(() => document.body.innerText.slice(0, 1000));
      console.warn(bodySnippet);
      throw btnErr;
    }
    console.log('Pulsando botón Generar reporte...');
    await genButton.click();
    await page.waitForTimeout(3000);

    // Opciones tras click
    const excelOption = page.locator('button, a, li, span, div[role="menuitem"]').filter({ hasText: /^Excel$/i }).first();
    if (await excelOption.count() > 0 && await excelOption.isVisible()) {
      console.log('Pulsando opción Excel...');
      await excelOption.click();
      await page.waitForTimeout(3000);
    } else {
      const linkExcel = page.locator('a:has-text("Excel"), button:has-text("Excel")').first();
      if (await linkExcel.count() > 0 && await linkExcel.isVisible()) {
        console.log('Pulsando enlace/botón Excel...');
        await linkExcel.click();
        await page.waitForTimeout(3000);
      }
    }

    // 6. Esperar descarga
    console.log('6. Esperando generación y descarga del archivo...');
    for (let i = 0; i < 35; i++) {
      if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
        console.log('¡Archivo descargado exitosamente!', downloadedFilePath);
        break;
      }
      await page.waitForTimeout(2000);
    }

    // 7. Procesar y actualizar dashboard local
    const outputDir = path.join(__dirname, 'reportes');
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir);
      console.log('Archivos en carpeta reportes:', files);
      if (files.some(f => f.endsWith('.xlsx') || f.endsWith('.zip') || f.endsWith('.csv'))) {
        console.log('7. Reporte generado y verificado.');
        try { await browser.close(); } catch (_) {}

        console.log('8. Procesando Excel y actualizando index.html...');
        try {
          execSync('node generar_dashboard.js', { stdio: 'inherit' });
          console.log('✓ Dashboard index.html actualizado con éxito.');
        } catch (genErr) {
          console.error('Advertencia al generar dashboard:', genErr.message || genErr);
        }

        console.log('\n======================================================');
        console.log('🎉 ¡ACTUALIZACIÓN COMPLETADA CON ÉXITO!');
        console.log('======================================================\n');
        process.exit(0);
      }
    }

    await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
    throw new Error('No se detectó el archivo Excel descargado.');

  } catch (error) {
    console.error('Error durante la ejecución:', error.message || error);
    try {
      if (page) await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
    } catch (_) {}
    process.exit(1);
  } finally {
    if (isCI && fs.existsSync(sessionPath)) {
      try { fs.unlinkSync(sessionPath); } catch (_) {}
    }
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
})();
