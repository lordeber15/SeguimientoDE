import { test, expect, type Page } from '@playwright/test';
import { iniciarSesionReal, iniciarSesionSimulada } from './sesion';

const EXPEDIENTE = {
  nuAnnExp: '2026',
  nuSecExp: '0000000383',
  numeroExpediente: '2026-0000383',
  documento: {
    nombre: 'PROVEIDO 000712-2026-OGA',
    tipo: 'PROVEIDO',
    numero: '000712-2026-OGA',
    nuAnn: '2026',
    nuEmi: '0000005432',
    nuDes: '1',
  },
  asunto: 'DOCUMENTACION NECESARIA PARA EL PAGO',
  estado: { codigo: '2', descripcion: 'ATENDIDO' },
  fechaRecepcion: '2026-05-22 18:51:07',
  fechaApertura: '2026-05-23 08:12:00',
  fechaEmision: '2026-05-25 10:23:45',
  documentoRespuesta: '000506-2026-OGA-UL',
  segundosCorridos: 228_600,
  segundosHabiles: 55_800,
  participaciones: 3,
};

const INTERACCIONES = [
  {
    nuAnn: '2026',
    nuEmi: '0000005432',
    nuDes: '1',
    orden: 3,
    documento: { nombre: 'PROVEIDO 000712-2026-OGA', tipo: 'PROVEIDO', numero: '000712-2026-OGA' },
    asunto: 'DOCUMENTACION NECESARIA PARA EL PAGO',
    estado: { codigo: '2', descripcion: 'ATENDIDO' },
    fechaRecepcion: '2026-05-22 18:51:07',
    fechaApertura: '2026-05-23 08:12:00',
    fechaEmision: '2026-05-25 10:23:45',
    documentoRespuesta: '000506-2026-OGA-UL',
    segundosCorridos: 228_600,
    tieneArchivo: true,
    numAnexos: 2,
  },
  {
    nuAnn: '2026',
    nuEmi: '0000004111',
    nuDes: '1',
    orden: 2,
    documento: { nombre: 'INFORME 000090-2026-OGA', tipo: 'INFORME', numero: '000090-2026-OGA' },
    asunto: 'Remite informe de conformidad',
    estado: { codigo: '0', descripcion: 'NO LEIDO' },
    fechaRecepcion: '2026-05-10 09:00:00',
    fechaApertura: null,
    fechaEmision: null,
    documentoRespuesta: null,
    segundosCorridos: null,
    tieneArchivo: false,
    numAnexos: 0,
  },
];

const ANEXOS = [
  { nuAne: 6, titulo: 'TDR Monitor Piura', nombreArchivo: 'TDR Monitor Piura.pdf', enBd: true },
  { nuAne: 7, titulo: 'Respaldo comprimido', nombreArchivo: 'respaldo.7z.001', enBd: false },
];

async function abrirExpediente(page: Page) {
  await page.route('**/api/dependencias', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { coDependencia: '00009', deDependencia: 'UNIDAD DE LOGISTICA', deSigla: 'OGA-UL', coTipoEncargatura: null, jefe: null, padre: null, tipoEncargaturaDescripcion: null, cargoDescripcion: null },
      ]),
    }),
  );

  await page.route('**/api/seguimiento/usuarios/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ coEmpleado: '00003', nombreCompleto: 'AGUIRRE ALMEYDA OSCAR', recibidos: 629, emitidos: 1033 }]),
    }),
  );

  await page.route('**/api/seguimiento/expedientes**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total: 1, items: [EXPEDIENTE] }) }),
  );

  await page.route('**/api/documentos/expediente/**/interacciones**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total: INTERACCIONES.length, items: INTERACCIONES }) }),
  );

  await page.route('**/api/documentos/*/*/anexos', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ANEXOS) }),
  );

  // Descarga de un anexo concreto (`.../anexos/7`). Va antes que la del documento porque
  // Playwright aplica la ÚLTIMA ruta registrada que coincide, y el patrón del documento es
  // más general.
  await page.route('**/api/documentos/*/*/anexos/*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'binario' }),
  );

  // Descarga del documento principal. El binario real no importa; solo que el visor lo pida.
  await page.route('**/api/documentos/2026/0000005432', (route) =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4 fake' }),
  );

  // La columna de chat consulta el estado de indexación de los expedientes listados al montar —
  // sin mock cae en el backend real con el token falso, y el 401 global cierra la sesión.
  await page.route('**/api/rag/chat/expedientes/estado**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  await iniciarSesionSimulada(page);

  await page.goto('/');
  // Seguimiento abre en la sub-pestaña "Expediente"; el flujo dependencia+usuario vive en la otra.
  await page.getByRole('tab', { name: 'Dependencia' }).click();
  await page.getByRole('combobox', { name: 'Dependencia' }).selectOption('00009');
  await page.getByLabel('Usuario').selectOption('00003');
  await expect(page.locator('tbody tr')).toHaveCount(1);
}

test.describe('Documentos e interacciones — con API simulada', () => {
  test('expandir un expediente muestra todas sus interacciones', async ({ page }) => {
    await abrirExpediente(page);

    await page.getByRole('button', { name: /Ver interacciones/ }).click();

    await expect(page.getByText('2 interacciones en este expediente')).toBeVisible();
    await expect(page.getByText('PROVEIDO 000712-2026-OGA').last()).toBeVisible();
    await expect(page.getByText('INFORME 000090-2026-OGA')).toBeVisible();
    // La interacción sin archivo lo dice en vez de ofrecer un botón muerto.
    await expect(page.getByText('Sin archivo digital')).toBeVisible();
  });

  test('el botón "Ver documento" pide el archivo correcto y lo muestra desde un blob', async ({ page }) => {
    await abrirExpediente(page);

    const pedidas: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/documentos/2026/0000005432')) pedidas.push(r.url());
    });

    await page.getByRole('button', { name: /Ver interacciones/ }).click();
    await page.getByRole('button', { name: 'Ver documento' }).click();

    const dialogo = page.getByRole('dialog');
    await expect(dialogo).toBeVisible();

    // El visor descarga y sirve desde blob:, no apunta el iframe a la API (ver VisorDocumento).
    await expect(dialogo.locator('iframe')).toHaveAttribute('src', /^blob:/);
    await expect(dialogo.getByRole('link', { name: 'Descargar' })).toBeVisible();
    expect(pedidas.some((u) => u.endsWith('/api/documentos/2026/0000005432'))).toBe(true);
  });

  // Solo 7.870 de los 31.404 documentos son accesibles desde este servidor: el 404 es frecuente.
  test('un documento sin archivo muestra un mensaje claro, no el JSON del error', async ({ page }) => {
    await abrirExpediente(page);

    await page.unroute('**/api/documentos/2026/0000005432');
    await page.route('**/api/documentos/2026/0000005432', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Documento no encontrado en el almacenamiento' }),
      }),
    );

    await page.getByRole('button', { name: /Ver interacciones/ }).click();
    await page.getByRole('button', { name: 'Ver documento' }).click();

    const dialogo = page.getByRole('dialog');
    await expect(dialogo.getByText('No se puede mostrar este documento.')).toBeVisible();
    await expect(dialogo.getByText('Documento no encontrado en el almacenamiento')).toBeVisible();
    await expect(dialogo.locator('iframe')).toHaveCount(0);
    // Sin archivo no hay nada que descargar: el botón no debe aparecer.
    await expect(dialogo.getByRole('link', { name: 'Descargar' })).toHaveCount(0);
  });

  test('el visor se cierra con Escape', async ({ page }) => {
    await abrirExpediente(page);
    await page.getByRole('button', { name: /Ver interacciones/ }).click();
    await page.getByRole('button', { name: 'Ver documento' }).click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('los anexos se listan al desplegarlos, conservando su nu_ane real', async ({ page }) => {
    await abrirExpediente(page);
    await page.getByRole('button', { name: /Ver interacciones/ }).click();

    await page.getByRole('button', { name: /2 anexos/ }).click();

    // nu_ane 6 y 7, no 1 y 2: la numeración del SGD no se re-indexa.
    await expect(page.getByRole('button', { name: /6\s+TDR Monitor Piura\.pdf/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /7\s+respaldo\.7z\.001/ })).toBeVisible();
  });

  test('un anexo no visualizable ofrece descarga en vez de intentar mostrarlo', async ({ page }) => {
    await abrirExpediente(page);
    await page.getByRole('button', { name: /Ver interacciones/ }).click();
    await page.getByRole('button', { name: /2 anexos/ }).click();
    await page.getByRole('button', { name: /respaldo\.7z\.001/ }).click();

    const dialogo = page.getByRole('dialog');
    await expect(dialogo).toBeVisible();
    await expect(dialogo.getByText('Este tipo de archivo no se puede mostrar en el navegador.')).toBeVisible();
    await expect(dialogo.locator('iframe')).toHaveCount(0);
  });
});

test.describe('Documentos — integración real', () => {
  test('expandir un expediente real trae sus interacciones del backend', async ({ page }) => {
    await iniciarSesionReal(page);
    await page.goto('/');
    await page.getByRole('tab', { name: 'Dependencia' }).click();

    const dependencia = page.getByRole('combobox', { name: 'Dependencia' });
    await expect(dependencia).toBeEnabled({ timeout: 15_000 });
    await dependencia.selectOption('00009');

    const usuario = page.getByLabel('Usuario');
    await expect(usuario).toBeEnabled({ timeout: 15_000 });
    const codigos = await usuario
      .locator('option')
      .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
    test.skip(codigos.length === 0, 'La dependencia 00009 no tiene usuarios con movimiento');
    await usuario.selectOption(codigos[0]);

    await expect(page.getByRole('status', { name: 'Cargando expedientes' })).toBeHidden({ timeout: 30_000 });
    const expandir = page.getByRole('button', { name: /Ver interacciones/ }).first();
    test.skip((await expandir.count()) === 0, 'El usuario no tiene expedientes');

    await expandir.click();

    await expect(page.getByText(/interacci(ón|ones) en este expediente/)).toBeVisible({ timeout: 20_000 });
  });
});
