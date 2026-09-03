import { test, expect, type Page } from '@playwright/test';
import { iniciarSesionReal, iniciarSesionSimulada } from './sesion';

const COLUMNAS = [
  'N° expediente',
  'Documento',
  'Asunto',
  'Estado',
  'Fecha de recepción',
  'Fecha de emisión',
  'Tiempo de atención',
];

function expediente(sobrescribir: Record<string, unknown> = {}) {
  return {
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
    // 63.5 h corridas; descontando el fin de semana completo quedan 15.5 h hábiles.
    segundosCorridos: 228_600,
    segundosHabiles: 55_800,
    participaciones: 1,
    ...sobrescribir,
  };
}

/** Deja la app con dependencia y usuario elegidos, sirviendo los combos desde mocks. */
async function seleccionarConMocks(page: Page, items: unknown[]) {
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
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ total: items.length, items }),
    }),
  );

  // La columna de chat consulta el estado de indexación de los expedientes listados al montar
  // (permiso `rag.consultar`, incluido en PERMISOS_TODOS) — sin mock cae en el backend real con
  // el token falso, y el 401 global cierra la sesión antes de que el test pueda continuar.
  await page.route('**/api/rag/chat/expedientes/estado**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  await iniciarSesionSimulada(page);

  await page.goto('/');
  // Seguimiento abre en la sub-pestaña "Expediente"; el flujo dependencia+usuario vive en la otra.
  await page.getByRole('tab', { name: 'Dependencia' }).click();
  await page.getByRole('combobox', { name: 'Dependencia' }).selectOption('00009');
  await page.getByLabel('Usuario').selectOption('00003');
}

test.describe('Seguimiento por usuario — integración real', () => {
  test('lista los expedientes tras elegir dependencia y usuario', async ({ page }) => {
    await iniciarSesionReal(page);
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Seguimiento por usuario' })).toBeVisible();

    await page.getByRole('tab', { name: 'Dependencia' }).click();
    await expect(
      page.getByText('Elija una dependencia y un usuario para ver los expedientes que pasaron por esa persona.'),
    ).toBeVisible();

    // El combo de usuarios permanece deshabilitado hasta que haya una dependencia elegida.
    await expect(page.getByLabel('Usuario')).toBeDisabled();

    const dependencia = page.getByRole('combobox', { name: 'Dependencia' });
    await expect(dependencia).toBeEnabled({ timeout: 15_000 });
    await dependencia.selectOption('00009');

    const usuario = page.getByLabel('Usuario');
    await expect(usuario).toBeEnabled({ timeout: 15_000 });

    const codigos = await usuario.locator('option').evaluateAll((opts) =>
      opts.map((o) => (o as HTMLOptionElement).value).filter(Boolean),
    );
    test.skip(codigos.length === 0, 'La dependencia 00009 no tiene usuarios con movimiento');

    await usuario.selectOption(codigos[0]);

    await expect(page.getByRole('status', { name: 'Cargando expedientes' })).toBeHidden({ timeout: 20_000 });

    const errorMessage = page.getByRole('alert');
    if (await errorMessage.isVisible().catch(() => false)) {
      test.fail(true, `El backend respondió con error: ${await errorMessage.innerText()}`);
      return;
    }

    for (const columna of COLUMNAS) {
      await expect(page.getByRole('columnheader', { name: columna })).toBeVisible();
    }

    await expect(page.locator('.result-count')).toContainText('expedientes');

    // Cada expediente debe aparecer una sola vez, que es el requisito central del módulo.
    const numeros = await page.locator('tbody tr .exp-numero').allInnerTexts();
    test.skip(numeros.length === 0, 'El usuario elegido no tiene expedientes');
    expect(new Set(numeros).size).toBe(numeros.length);
  });
});

test.describe('Seguimiento por usuario — con API simulada', () => {
  test('el conmutador cambia entre horas corridas y días hábiles', async ({ page }) => {
    await seleccionarConMocks(page, [expediente()]);

    const celdaTiempo = page.locator('tbody tr').first().locator('.celda-tiempo');
    await expect(celdaTiempo).toHaveText('2 d 15 h');

    await page.getByRole('button', { name: 'Días hábiles' }).click();
    await expect(celdaTiempo).toHaveText('15 h 30 min');

    await page.getByRole('button', { name: 'Horas corridas' }).click();
    await expect(celdaTiempo).toHaveText('2 d 15 h');
  });

  test('muestra "Sin respuesta" cuando el usuario todavía no emitió nada', async ({ page }) => {
    await seleccionarConMocks(page, [
      expediente({
        estado: { codigo: '0', descripcion: 'NO LEIDO' },
        fechaApertura: null,
        fechaEmision: null,
        documentoRespuesta: null,
        segundosCorridos: null,
        segundosHabiles: null,
      }),
    ]);

    const fila = page.locator('tbody tr').first();
    await expect(fila.locator('.celda-tiempo')).toHaveText('Sin respuesta');
    await expect(fila.getByText('sin abrir')).toBeVisible();
    await expect(page.locator('.result-count')).toContainText('1 sin respuesta');
  });

  test('marca los expedientes con varias participaciones y muestra el asunto', async ({ page }) => {
    await seleccionarConMocks(page, [expediente({ participaciones: 5 })]);

    const fila = page.locator('tbody tr').first();
    await expect(fila.getByText('5 participaciones')).toBeVisible();
    await expect(fila.getByText('DOCUMENTACION NECESARIA PARA EL PAGO')).toBeVisible();
    await expect(fila.getByText('ATENDIDO')).toBeVisible();

    // Día y hora van en líneas separadas para que la columna quepa en su ancho asignado: la fecha
    // completa en una sola línea era un mínimo duro (`white-space: nowrap`) de ~166px por columna.
    const recepcion = fila.locator('.celda-fecha').first();
    await expect(recepcion).toContainText('22/05/2026');
    await expect(recepcion.locator('.fecha-hora')).toHaveText('18:51');

    const emision = fila.locator('.celda-fecha').nth(1);
    await expect(emision).toContainText('25/05/2026');
    await expect(emision.locator('.fecha-hora')).toHaveText('10:23');
  });

  test('al cambiar de dependencia se limpia el usuario y vuelve el estado inicial', async ({ page }) => {
    await seleccionarConMocks(page, [expediente()]);
    await expect(page.locator('tbody tr')).toHaveCount(1);

    await page.getByRole('combobox', { name: 'Dependencia' }).selectOption('');

    await expect(page.getByLabel('Usuario')).toHaveValue('');
    await expect(
      page.getByText('Elija una dependencia y un usuario para ver los expedientes que pasaron por esa persona.'),
    ).toBeVisible();
  });
});
