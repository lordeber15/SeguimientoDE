import { test, expect, type Page } from '@playwright/test';
import { iniciarSesionSimulada } from './sesion';

const EXPEDIENTE = {
  nuAnnExp: '2026',
  nuSecExp: '0000000383',
  numeroExpediente: 'OGAUL020260000383',
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

const JOB_ID = '11111111-2222-3333-4444-555555555555';

async function abrirTabla(page: Page) {
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

/** Simula el ciclo del job: 202 al iniciar y una secuencia de estados en el polling. */
async function simularJob(page: Page, estados: Record<string, unknown>[]) {
  await page.route('**/api/unir-pdf/expediente/**', (route) =>
    route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId: JOB_ID }) }),
  );

  // Al completarse, el modal descarga el PDF para servirlo desde un blob: sin esta ruta, el
  // estado "completado" nunca se alcanzaría.
  await page.route(`**/api/unir-pdf/${JOB_ID}/descargar`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4 fake' }),
  );

  let i = 0;
  await page.route(`**/api/unir-pdf/${JOB_ID}/estado`, (route) => {
    const cuerpo = estados[Math.min(i, estados.length - 1)];
    i++;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cuerpo) });
  });
}

const base = {
  jobId: JOB_ID,
  errores: [],
  mensajeError: null,
  filename: 'Expediente_OGAUL020260000383.pdf',
};

test.describe('PDF unificado — con API simulada', () => {
  test('el diálogo ofrece excluir los anexos antes de generar', async ({ page }) => {
    await abrirTabla(page);
    await page.getByRole('button', { name: 'PDF unificado' }).click();

    const dialogo = page.getByRole('dialog');
    await expect(dialogo).toBeVisible();
    await expect(dialogo.getByRole('heading')).toContainText('OGAUL020260000383');

    const anexos = dialogo.getByRole('checkbox', { name: /Incluir anexos/ });
    await expect(anexos).toBeChecked();
    await anexos.uncheck();

    // Sin anexos, la petición debe llevar el parámetro que lo indica.
    const peticion = page.waitForRequest((r) => r.url().includes('/api/unir-pdf/expediente/'));
    await simularJob(page, [{ ...base, estado: 'procesando', fase: 'procesando', total: 3, procesados: 1 }]);
    await dialogo.getByRole('button', { name: 'Generar PDF' }).click();

    expect((await peticion).url()).toContain('anexos=no');
  });

  test('muestra el progreso y luego el visor del PDF con su descarga', async ({ page }) => {
    await abrirTabla(page);
    await simularJob(page, [
      { ...base, estado: 'procesando', fase: 'consultando', total: 0, procesados: 0 },
      { ...base, estado: 'procesando', fase: 'procesando', total: 4, procesados: 2 },
      { ...base, estado: 'completado', fase: 'ensamblando', total: 4, procesados: 4 },
    ]);

    const descargas: string[] = [];
    await page.route(`**/api/unir-pdf/${JOB_ID}/descargar`, (route) => {
      descargas.push(route.request().headers().authorization ?? '');
      route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4 fake' });
    });

    await page.getByRole('button', { name: 'PDF unificado' }).click();
    await page.getByRole('button', { name: 'Generar PDF' }).click();

    const dialogo = page.getByRole('dialog');
    await expect(dialogo.getByText(/2 de 4/)).toBeVisible();

    const verPdf = dialogo.getByRole('button', { name: 'Ver PDF' });
    await expect(verPdf).toBeVisible({ timeout: 15_000 });
    await verPdf.click();

    // Al entrar al visor, el PDF se muestra embebido en el propio modal (no en pestaña nueva).
    await expect(dialogo.locator('iframe.visor-iframe')).toBeVisible();

    const enlace = dialogo.getByRole('link', { name: 'Descargar' });
    // El enlace apunta a un blob, no a la API: un `<a href>` no puede llevar la cabecera
    // `Authorization` y la ruta exige sesión desde la Fase 2.
    await expect(enlace).toHaveAttribute('href', /^blob:/);
    await expect(enlace).toHaveAttribute('download', base.filename);
    expect(descargas[0]).toMatch(/^Bearer /);
  });

  test('lista los documentos que no se pudieron incluir', async ({ page }) => {
    await abrirTabla(page);
    await simularJob(page, [
      {
        ...base,
        estado: 'completado',
        fase: 'ensamblando',
        total: 2,
        procesados: 2,
        errores: [
          { nuEmi: '0000000009', documento: 'INFORME N° 9', motivo: 'Sin archivo digital' },
          { nuEmi: '0000000010', documento: 'OFICIO N° 10', nuAne: 3, anexo: 'Respaldo', motivo: 'PDF corrupto o cifrado' },
        ],
      },
    ]);

    await page.getByRole('button', { name: 'PDF unificado' }).click();
    await page.getByRole('button', { name: 'Generar PDF' }).click();

    const dialogo = page.getByRole('dialog');
    await dialogo.getByText('2 elemento(s) no se pudieron incluir').click();
    await expect(dialogo.getByText('Sin archivo digital')).toBeVisible();
    await expect(dialogo.getByText(/anexo 3: Respaldo/)).toBeVisible();
  });

  test('un 429 por exceso de trabajos se explica, no se traga', async ({ page }) => {
    await abrirTabla(page);
    await page.route('**/api/unir-pdf/expediente/**', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Ya hay uniones de PDF en curso; inténtelo en unos minutos' }),
      }),
    );

    await page.getByRole('button', { name: 'PDF unificado' }).click();
    await page.getByRole('button', { name: 'Generar PDF' }).click();

    const dialogo = page.getByRole('dialog');
    await expect(dialogo.getByText('No se pudo generar el PDF unificado.')).toBeVisible();
    await expect(dialogo.getByText(/Ya hay uniones de PDF en curso/)).toBeVisible();
  });

  test('el diálogo se cierra con Escape', async ({ page }) => {
    await abrirTabla(page);
    await page.getByRole('button', { name: 'PDF unificado' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });
});
