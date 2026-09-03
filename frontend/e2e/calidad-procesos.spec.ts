import { test, expect, type Page } from '@playwright/test';
import { iniciarSesionSimulada } from './sesion';

const CLAVE_PAGO = 'a1b2c3d4e5f60001';

const PROCESOS = [
  {
    clave: CLAVE_PAGO,
    nombre: 'PRESENTACION DE DOCUMENTACION PARA PAGO DE CONSULTORIA',
    renombrado: false,
    expedientes: 436,
    pasosPromedio: 6.2,
    duracionMedianaHoras: 48.5,
    nodosColumna: 4,
    coberturaColumna: 91.3,
    coberturaRutaExacta: 13.8,
  },
  {
    clave: 'a1b2c3d4e5f60002',
    nombre: 'RENOVACION DE CARTA FIANZA',
    renombrado: true,
    expedientes: 52,
    pasosPromedio: 2.1,
    duracionMedianaHoras: 12,
    nodosColumna: 2,
    coberturaColumna: 96,
    coberturaRutaExacta: 94,
  },
];

const FLUJO_PAGO = {
  clave: CLAVE_PAGO,
  nombre: 'PRESENTACION DE DOCUMENTACION PARA PAGO DE CONSULTORIA',
  expedientes: 436,
  coberturaColumna: 91.3,
  rutasDistintas: 94,
  rutaExacta: { oficinas: ['OGA', 'UNIDAD DE LOGÍSTICA', 'UNIDAD DE CONTABILIDAD', 'UNIDAD DE TESORERÍA'], expedientes: 60, cobertura: 13.8 },
  columna: [
    {
      orden: 1, coDependencia: '00002', nombreDependencia: 'OFICINA DE GESTIÓN ADMINISTRATIVA',
      expedientes: 435, cobertura: 99.8, visitas: 435,
      medianaHoras: 2.5, p25Horas: 1, p75Horas: 5, esperaMedianaHoras: 0.5, trabajoMedianaHoras: 2,
      motivos: [{ codigo: '2', visitas: 400 }],
      porEmpleado: [{ coEmpleado: '00061', nombre: 'ICHO SAN MARTIN LIZZETH', visitas: 200, medianaHoras: 2 }],
    },
    {
      orden: 2, coDependencia: '00004', nombreDependencia: 'UNIDAD DE LOGÍSTICA',
      expedientes: 423, cobertura: 97, visitas: 423,
      medianaHoras: 40, p25Horas: 20, p75Horas: 60, esperaMedianaHoras: 10, trabajoMedianaHoras: 30,
      motivos: [{ codigo: '2', visitas: 420 }],
      porEmpleado: [{ coEmpleado: '00046', nombre: 'GALARZA LOPEZ MERCEDES', visitas: 300, medianaHoras: 38 }],
    },
    {
      orden: 3, coDependencia: '00005', nombreDependencia: 'UNIDAD DE CONTABILIDAD',
      expedientes: 414, cobertura: 95, visitas: 414,
      medianaHoras: 20, p25Horas: 10, p75Horas: 30, esperaMedianaHoras: 5, trabajoMedianaHoras: 15,
      motivos: [{ codigo: '2', visitas: 410 }],
      porEmpleado: [],
    },
    {
      orden: 4, coDependencia: '00006', nombreDependencia: 'UNIDAD DE TESORERÍA',
      expedientes: 399, cobertura: 91.5, visitas: 399,
      medianaHoras: 15, p25Horas: 8, p75Horas: 25, esperaMedianaHoras: 4, trabajoMedianaHoras: 11,
      motivos: [{ codigo: '2', visitas: 390 }],
      porEmpleado: [],
    },
  ],
  opcionales: [
    { coDependencia: '00007', nombreDependencia: 'USEI', expedientes: 112, cobertura: 25.7, medianaHoras: 0.33, p25Horas: 0.2 },
    { coDependencia: '00008', nombreDependencia: 'PMESUT-OGI', expedientes: 94, cobertura: 21.6, medianaHoras: 1, p25Horas: 0.5 },
  ],
};

const PROPUESTA_PAGO = {
  clave: CLAVE_PAGO,
  nombre: 'PRESENTACION DE DOCUMENTACION PARA PAGO DE CONSULTORIA',
  percentilObjetivo: 10,
  totalActualHoras: 77.5,
  totalPropuestoHoras: 50,
  ahorroHoras: 27.5,
  ahorroPorcentaje: 35.5,
  pasos: [
    {
      orden: 1, coDependencia: '00002', nombreDependencia: 'OFICINA DE GESTIÓN ADMINISTRATIVA',
      actualMedianaHoras: 2.5, objetivoHoras: 1, origenObjetivo: 'comparable' as const,
      mejorOficina: { coDependencia: '00007', nombreDependencia: 'USEI', medianaHoras: 0.33 },
      minimoObservadoHoras: 0.1, muestra: 40, ahorroHoras: 1.5,
    },
    {
      orden: 2, coDependencia: '00004', nombreDependencia: 'UNIDAD DE LOGÍSTICA',
      actualMedianaHoras: 40, objetivoHoras: 20, origenObjetivo: 'comparable' as const,
      mejorOficina: { coDependencia: '00002', nombreDependencia: 'OFICINA DE GESTIÓN ADMINISTRATIVA', medianaHoras: 20 },
      minimoObservadoHoras: 5, muestra: 25, ahorroHoras: 20,
    },
    {
      orden: 3, coDependencia: '00005', nombreDependencia: 'UNIDAD DE CONTABILIDAD',
      actualMedianaHoras: 20, objetivoHoras: 15, origenObjetivo: 'propio' as const,
      mejorOficina: null, minimoObservadoHoras: null, muestra: 2, ahorroHoras: 5,
    },
    {
      orden: 4, coDependencia: '00006', nombreDependencia: 'UNIDAD DE TESORERÍA',
      actualMedianaHoras: 15, objetivoHoras: null, origenObjetivo: null,
      mejorOficina: null, minimoObservadoHoras: null, muestra: 0, ahorroHoras: null,
    },
  ],
};

const RESUMEN_ESTADO = {
  ultimoRefresco: '2026-09-02T20:00:00.000Z', minutosDesde: 5, participaciones: 46000, ultimoError: null,
};

async function abrirCalidadProcesos(page: Page, permisos?: string[]) {
  await page.route('**/api/dependencias', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/dashboard/resumen/estado', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESUMEN_ESTADO) }),
  );
  await page.route('**/api/calidad-procesos/procesos**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROCESOS) }),
  );
  await page.route(`**/api/calidad-procesos/procesos/${CLAVE_PAGO}/flujo**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FLUJO_PAGO) }),
  );
  await page.route(`**/api/calidad-procesos/procesos/${CLAVE_PAGO}/propuesta**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROPUESTA_PAGO) }),
  );

  await iniciarSesionSimulada(page, permisos);
  await page.goto('/');
}

test.describe('Calidad de procesos — permisos', () => {
  test('sin calidad.ver, la pestaña no aparece en la barra lateral', async ({ page }) => {
    await abrirCalidadProcesos(page, ['seguimiento.ver']);
    await expect(page.getByRole('button', { name: 'Calidad de procesos' })).toHaveCount(0);
  });

  test('con calidad.ver, la pestaña aparece y se puede abrir', async ({ page }) => {
    await abrirCalidadProcesos(page, ['seguimiento.ver', 'calidad.ver']);
    await page.getByRole('button', { name: 'Calidad de procesos' }).click();
    await expect(page.getByRole('heading', { name: 'Calidad de procesos' })).toBeVisible();
  });
});

test.describe('Calidad de procesos — con API simulada', () => {
  test('lista los procesos detectados, distinguiendo el renombrado del automático', async ({ page }) => {
    await abrirCalidadProcesos(page);
    await page.getByRole('button', { name: 'Calidad de procesos' }).click();

    await expect(page.getByRole('cell', { name: '436' })).toBeVisible();
    await expect(page.getByText('91.3%')).toBeVisible(); // cobertura de la columna
    await expect(page.getByText('13.8%')).toBeVisible(); // cobertura de la ruta exacta, mucho menor
    await expect(page.getByText('RENOVACION DE CARTA FIANZA')).toBeVisible();
  });

  test('al elegir un proceso se abre su flujo con la columna vertebral, no la ruta exacta', async ({ page }) => {
    await abrirCalidadProcesos(page);
    await page.getByRole('button', { name: 'Calidad de procesos' }).click();

    await page.getByRole('button', { name: /PRESENTACION DE DOCUMENTACION PARA PAGO/ }).click();

    await expect(page.getByRole('tab', { name: /Flujo actual/ })).toHaveAttribute('aria-selected', 'true');
    // `.first()`: el nombre de cada nodo aparece dos veces (el `<span>` visible y el `sr-only` del
    // botón "Ver detalle de..."), ambos con el mismo texto accesible.
    await expect(page.getByText('OFICINA DE GESTIÓN ADMINISTRATIVA').first()).toBeVisible();
    await expect(page.getByText('UNIDAD DE LOGÍSTICA').first()).toBeVisible();
    await expect(page.getByText('UNIDAD DE CONTABILIDAD').first()).toBeVisible();
    await expect(page.getByText('UNIDAD DE TESORERÍA').first()).toBeVisible();
    // La nota debe explicitar que la ruta exacta cubre mucho menos que la columna.
    await expect(page.getByText(/ruta exacta más repetida cubre solo 13\.8%/)).toBeVisible();

    // Los pasos opcionales (conformidad técnica repartida entre varias oficinas) van aparte.
    await expect(page.getByText('Pasos opcionales frecuentes')).toBeVisible();
    await expect(page.getByText('USEI')).toBeVisible();
  });

  test('expandir un nodo muestra el desglose por persona', async ({ page }) => {
    await abrirCalidadProcesos(page);
    await page.getByRole('button', { name: 'Calidad de procesos' }).click();
    await page.getByRole('button', { name: /PRESENTACION DE DOCUMENTACION PARA PAGO/ }).click();

    await page.getByRole('button', { name: /OFICINA DE GESTIÓN ADMINISTRATIVA/ }).click();
    await expect(page.getByText('ICHO SAN MARTIN LIZZETH')).toBeVisible();
  });

  test('la propuesta de mejora muestra el objetivo comparable y avisa cuando cae al mejor cuartil propio', async ({ page }) => {
    await abrirCalidadProcesos(page);
    await page.getByRole('button', { name: 'Calidad de procesos' }).click();
    await page.getByRole('button', { name: /PRESENTACION DE DOCUMENTACION PARA PAGO/ }).click();
    await page.getByRole('tab', { name: /Propuesta de mejora/ }).click();

    await expect(page.getByText('Percentil entre oficinas comparables').first()).toBeVisible();
    await expect(page.getByText('Sin muestra suficiente — mejor cuartil propio')).toBeVisible();
    await expect(page.getByText('Sin objetivo calculable')).toBeVisible();
  });

  test('sin procesos detectados, explica que puede ser que el espejo no se haya refrescado aún', async ({ page }) => {
    await abrirCalidadProcesos(page);
    await page.route('**/api/calidad-procesos/procesos**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );

    await page.getByRole('button', { name: 'Calidad de procesos' }).click();
    await expect(page.getByText('No se detectó ningún proceso')).toBeVisible();
  });

  test('renombrar una familia, con dashboard.gestionar', async ({ page }) => {
    await abrirCalidadProcesos(page);
    let cuerpoEnviado: unknown = null;
    await page.route(`**/api/calidad-procesos/procesos/${CLAVE_PAGO}/nombre`, (route) => {
      cuerpoEnviado = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.getByRole('button', { name: 'Calidad de procesos' }).click();
    await page.getByRole('button', { name: 'Renombrar' }).first().click();
    await page.locator('.proceso-edicion input').fill('Pago de consultores');
    await page.getByRole('button', { name: 'Guardar' }).click();

    await expect.poll(() => cuerpoEnviado).toEqual({ nombre: 'Pago de consultores' });
  });

  test('sin dashboard.gestionar, no se ofrece la opción de renombrar', async ({ page }) => {
    await abrirCalidadProcesos(page, ['seguimiento.ver', 'calidad.ver']);
    await page.getByRole('button', { name: 'Calidad de procesos' }).click();
    await expect(page.getByRole('button', { name: 'Renombrar' })).toHaveCount(0);
  });
});
