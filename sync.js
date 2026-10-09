// sync.js - Sincronizador Siigo a GitHub

const SIIGO_USERNAME = process.env.SIIGO_USERNAME;
const SIIGO_ACCESS_KEY = process.env.SIIGO_ACCESS_KEY;
const GITHUB_TOKEN = process.env.GH_TOKEN;
const GITHUB_REPO_OWNER = process.env.GH_OWNER;
const GITHUB_REPO_NAME = process.env.GH_REPO;
const FILE_PATH = 'contabilidad/facturas_siigo.json';

async function main() {
  console.log('1. Autenticando con Siigo...');
  
  const authResponse = await fetch('https://api.siigo.com/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: SIIGO_USERNAME,
      access_key: SIIGO_ACCESS_KEY
    })
  });

  if (!authResponse.ok) {
    const errorBody = await authResponse.text();
    throw new Error(`Error en login de Siigo: ${authResponse.status} - ${errorBody}`);
  }

  const { access_token } = await authResponse.json();
  console.log('✓ Token de Siigo obtenido con éxito.');

  console.log('2. Consultando facturas en Siigo...');
  const invoicesResponse = await fetch('https://api.siigo.com/v1/invoices', {
    headers: {
      'Authorization': `Bearer ${access_token}`,
      'Content-Type': 'application/json'
    }
  });

  if (!invoicesResponse.ok) {
    const errorBody = await invoicesResponse.text();
    throw new Error(`Error consultando facturas: ${invoicesResponse.status} - ${errorBody}`);
  }

  const invoicesData = await invoicesResponse.json();
  const totalObtenido = invoicesData.results ? invoicesData.results.length : 0;
  console.log(`✓ Se obtuvieron ${totalObtenido} facturas.`);

  const contenidoTexto = JSON.stringify(invoicesData, null, 2);
  const contenidoBase64 = Buffer.from(contenidoTexto).toString('base64');

  console.log('3. Guardando archivo en GitHub...');
  const fileUrl = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${FILE_PATH}`;
  
  const checkFile = await fetch(fileUrl, {
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json'
    }
  });

  let shaExistente = null;
  if (checkFile.ok) {
    const fileInfo = await checkFile.json();
    shaExistente = fileInfo.sha;
  }

  const bodyGithub = {
    message: `Actualización automática Siigo: ${new Date().toISOString()}`,
    content: contenidoBase64,
    ...(shaExistente && { sha: shaExistente })
  };

  const uploadResponse = await fetch(fileUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(bodyGithub)
  });

  if (!uploadResponse.ok) {
    const errorMsg = await uploadResponse.text();
    throw new Error(`Error subiendo archivo a GitHub: ${errorMsg}`);
  }

  console.log('✓ ¡Archivo guardado exitosamente en el repositorio!');
}

main().catch(err => {
  console.error('Error en el proceso:', err);
  process.exit(1);
});
