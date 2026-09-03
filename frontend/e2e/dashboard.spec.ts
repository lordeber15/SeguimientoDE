import { test, expect, type Page } from '@playwright/test';
import { iniciarSesionSimulada } from './sesion';

/** Fase 2: campos de calidad y carga comunes a filas de oficina y de empleado. */
const CALIDAD_00012 = {
  recibidosInformativos: 5, atendidosInformativos: 3, pendientesInformativos: 2, tasaAtencionInformativos: 0.6,
  expedientesDistintos: 15, movimientos: 23, movimientosPromedioPorExpediente: 1.53,
  gruposEmpleadoExpediente: 16, gruposReprocesados: 4, tasaReproceso: 0.25,
  emitidos: 20, anulados: 2, tasaAnulacion: 0.1,
};

/** Fase 3: con todos los pesos en 1 (valor por defecto sin ajustes), coinciden con atendidos/recibidos. */
const PONDERADA_00012 = { productividadPonderada: 7, cargaPonderada: 18 };

/** Fase 8: sin ningún fixture pensado para probar la distinción externa/misma-oficina, por
 *  defecto se asume "todo lo recibido es externo" (`recibidosMismaOficina: 0`) — así el resto de
 *  las pruebas, escritas antes de Fase 8, siguen viendo exactamente el mismo comportamiento de la
 *  regla de carga que ya verificaban. */
const EMPLEADOS = [
  {
    coEmpleado: '00061', nombreCompleto: 'ICHO SAN MARTIN LIZZETH',
    coDependencia: '00012', nombreDependencia: 'UNIDAD DE ESTUDIOS, PROYECTOS Y OBRAS', esComite: false,
    recibidos: 9, recibidosExternos: 9, recibidosMismaOficina: 0, atendidos: 4, pendientes: 5, tasaAtencion: 0.4444,
    tiempoPromedioHoras: 20.74, tiempoMedianoHoras: 10.08, tiempoPromedioHabilHoras: 8.74,
    recibidosInformativos: 2, atendidosInformativos: 1, pendientesInformativos: 1, tasaAtencionInformativos: 0.5,
    expedientesDistintos: 7, movimientos: 11, movimientosPromedioPorExpediente: 1.57,
    gruposEmpleadoExpediente: 7, gruposReprocesados: 2, tasaReproceso: 0.2857,
    emitidos: 5, anulados: 0, tasaAnulacion: 0,
    productividadPonderada: 4, cargaPonderada: 9,
  },
  {
    coEmpleado: '00046', nombreCompleto: 'GALARZA LOPEZ MERCEDES',
    coDependencia: '00012', nombreDependencia: 'UNIDAD DE ESTUDIOS, PROYECTOS Y OBRAS', esComite: false,
    recibidos: 9, recibidosExternos: 9, recibidosMismaOficina: 0, atendidos: 3, pendientes: 6, tasaAtencion: 0.3333,
    tiempoPromedioHoras: 43.45, tiempoMedianoHoras: 16.58, tiempoPromedioHabilHoras: 27.45,
    recibidosInformativos: 3, atendidosInformativos: 2, pendientesInformativos: 1, tasaAtencionInformativos: 0.6667,
    expedientesDistintos: 6, movimientos: 12, movimientosPromedioPorExpediente: 2,
    gruposEmpleadoExpediente: 7, gruposReprocesados: 3, tasaReproceso: 0.4286,
    emitidos: 8, anulados: 1, tasaAnulacion: 0.125,
    productividadPonderada: 3, cargaPonderada: 9,
  },
];

const OFICINAS = [
  {
    coDependencia: '00002', nombreDependencia: 'OFICINA DE GESTIÓN ADMINISTRATIVA', esComite: false,
    recibidos: 879, recibidosExternos: 879, recibidosMismaOficina: 0, atendidos: 766, pendientes: 113, tasaAtencion: 0.8714,
    tiempoPromedioHoras: 5.69, tiempoMedianoHoras: 0.47, tiempoPromedioHabilHoras: 4.25,
    recibidosInformativos: 220, atendidosInformativos: 200, pendientesInformativos: 20, tasaAtencionInformativos: 0.9091,
    expedientesDistintos: 400, movimientos: 1099, movimientosPromedioPorExpediente: 2.75,
    gruposEmpleadoExpediente: 450, gruposReprocesados: 130, tasaReproceso: 0.2889,
    emitidos: 1000, anulados: 60, tasaAnulacion: 0.06,
    productividadPonderada: 766, cargaPonderada: 879,
  },
  {
    coDependencia: '00012', nombreDependencia: 'UNIDAD DE ESTUDIOS, PROYECTOS Y OBRAS', esComite: false,
    recibidos: 18, recibidosExternos: 18, recibidosMismaOficina: 0, atendidos: 7, pendientes: 11, tasaAtencion: 0.3889,
    tiempoPromedioHoras: 30.0, tiempoMedianoHoras: 12.0, tiempoPromedioHabilHoras: 18.0,
    ...CALIDAD_00012,
    ...PONDERADA_00012,
  },
];

/** Fase 6: dos comités de evaluación, mismo patrón "uno domina las 3 dimensiones del índice
 *  frente al otro" que `OFICINAS` — con un grupo de 2, el z-score de quien gana en todo es
 *  siempre +1/√2 ≈ 0,71 (Bajo el mismo razonamiento documentado en el describe de Fase 4). */
const COMITES = [
  {
    coDependencia: '00022', nombreDependencia: 'COMITE DE EVALUACION PERMANENTE', esComite: true,
    recibidos: 20, recibidosExternos: 20, recibidosMismaOficina: 0, atendidos: 18, pendientes: 2, tasaAtencion: 0.90,
    tiempoPromedioHoras: 3, tiempoMedianoHoras: 1, tiempoPromedioHabilHoras: 2,
    recibidosInformativos: 1, atendidosInformativos: 1, pendientesInformativos: 0, tasaAtencionInformativos: 1,
    expedientesDistintos: 15, movimientos: 21, movimientosPromedioPorExpediente: 1.4,
    gruposEmpleadoExpediente: 15, gruposReprocesados: 1, tasaReproceso: 0.0667,
    emitidos: 20, anulados: 1, tasaAnulacion: 0.05,
    productividadPonderada: 18, cargaPonderada: 20,
  },
  {
    coDependencia: '00023', nombreDependencia: 'COMITE DE EVALUACION - RJ 011-2026-MINEDU-UE-MCEBS', esComite: true,
    recibidos: 10, recibidosExternos: 10, recibidosMismaOficina: 0, atendidos: 3, pendientes: 7, tasaAtencion: 0.30,
    tiempoPromedioHoras: 40, tiempoMedianoHoras: 20, tiempoPromedioHabilHoras: 30,
    recibidosInformativos: 0, atendidosInformativos: 0, pendientesInformativos: 0, tasaAtencionInformativos: 0,
    expedientesDistintos: 8, movimientos: 10, movimientosPromedioPorExpediente: 1.25,
    gruposEmpleadoExpediente: 8, gruposReprocesados: 3, tasaReproceso: 0.375,
    emitidos: 10, anulados: 3, tasaAnulacion: 0.30,
    productividadPonderada: 3, cargaPonderada: 10,
  },
];

const PESOS_TIPO_DOCUMENTO = [
  {
    coTipDoc: '232', descripcion: 'PROVEÍDO', peso: 1.5, pesoSugerido: 1.42,
    muestraAtendidos: 40, medianaHoras: 2, actualizadoPor: '08365245', feActualizado: '2026-08-01T00:00:00.000Z',
  },
  {
    coTipDoc: '304', descripcion: 'HOJA DE ENVÍO', peso: 1, pesoSugerido: null,
    muestraAtendidos: 2, medianaHoras: 0.5, actualizadoPor: null, feActualizado: null,
  },
];

const PENDIENTES = [
  {
    coDependencia: '00003', nombreDependencia: 'OFICINA DE ASESORÍA LEGAL',
    pendientes: 90, pendientes0a7: 0, pendientes8a30: 0, pendientes31Mas: 90, diasPendienteMasAntiguo: 113,
  },
  {
    coDependencia: '00012', nombreDependencia: 'UNIDAD DE ESTUDIOS, PROYECTOS Y OBRAS',
    pendientes: 6, pendientes0a7: 1, pendientes8a30: 2, pendientes31Mas: 3, diasPendienteMasAntiguo: 45,
  },
];

const TIPOS_DOCUMENTO = [
  { codigo: '232', descripcion: 'PROVEÍDO' },
  { codigo: '304', descripcion: 'HOJA DE ENVÍO' },
];

const RESUMEN_ESTADO = {
  ultimoRefresco: '2026-08-28T20:00:00.000Z', minutosDesde: 5, participaciones: 46000, ultimoError: null,
};

async function abrirDashboard(page: Page, permisos?: string[]) {
  await page.route('**/api/dependencias', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/dashboard/tipos-documento', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TIPOS_DOCUMENTO) }),
  );
  await page.route('**/api/dashboard/oficinas**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OFICINAS) }),
  );
  await page.route('**/api/dashboard/empleados**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPLEADOS) }),
  );
  await page.route('**/api/dashboard/pendientes/oficinas**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PENDIENTES) }),
  );
  await page.route('**/api/dashboard/resumen/estado', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESUMEN_ESTADO) }),
  );

  await iniciarSesionSimulada(page, permisos);
  await page.goto('/');
}

test.describe('Dashboard — permisos', () => {
  test('sin dashboard.ver, la pestaña no aparece en la barra lateral', async ({ page }) => {
    await abrirDashboard(page, ['seguimiento.ver']);

    await expect(page.getByRole('button', { name: 'Dashboard' })).toHaveCount(0);
  });

  test('con dashboard.ver, la pestaña aparece y se puede abrir', async ({ page }) => {
    await abrirDashboard(page, ['seguimiento.ver', 'dashboard.ver']);

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await expect(page.getByRole('heading', { name: 'Evaluación de desempeño documental' })).toBeVisible();
  });
});

test.describe('Dashboard — con API simulada', () => {
  test('muestra los indicadores globales en Resumen, y las tablas en sus propias pestañas', async ({ page }) => {
    await abrirDashboard(page);
    await page.getByRole('button', { name: 'Dashboard' }).click();

    // Se abre en la pestaña Resumen: tarjeta global, recibidos = 879 + 18 = 897 (suma de oficinas).
    await expect(page.getByText('897')).toBeVisible();

    await page.getByRole('tab', { name: /Por oficina/ }).click();
    // El nombre también aparece en los ejes de los gráficos — se acota a la celda de la tabla.
    // `exact: true` porque el botón de expandir la fila también se llama "... OFICINA DE GESTIÓN
    // ADMINISTRATIVA" (Fase 6: nombre truncado con `title`, columna de expandir con aria-label).
    await expect(page.getByRole('cell', { name: 'OFICINA DE GESTIÓN ADMINISTRATIVA', exact: true })).toBeVisible();
    // Tasa de atención propia de esa oficina en la fila de la tabla (0.8714 → 87%).
    await expect(page.getByText('87%')).toBeVisible();

    await page.getByRole('tab', { name: /Por empleado/ }).click();
    await expect(page.getByText('ICHO SAN MARTIN LIZZETH')).toBeVisible();
    await expect(page.getByText('GALARZA LOPEZ MERCEDES')).toBeVisible();
  });

  test('la agregación por empleado solo se pide al abrir su pestaña, una vez por filtro', async ({ page }) => {
    // Registradas DESPUÉS de `abrirDashboard`: Playwright da precedencia a la ruta más reciente
    // sobre el mismo patrón, así que estas reemplazan a las genéricas que ya instaló el helper.
    await abrirDashboard(page);
    let pedidosOficinas = 0;
    let pedidosEmpleados = 0;
    await page.route('**/api/dashboard/oficinas**', (route) => {
      pedidosOficinas += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OFICINAS) });
    });
    await page.route('**/api/dashboard/empleados**', (route) => {
      pedidosEmpleados += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPLEADOS) });
    });

    // 1. Al entrar solo se consulta la agregación por oficina — la cara ni se toca.
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await expect(page.getByText('897')).toBeVisible();
    expect(pedidosOficinas).toBe(1);
    expect(pedidosEmpleados).toBe(0);

    // 2. "Por oficina" reusa lo ya cargado: ninguna consulta nueva.
    await page.getByRole('tab', { name: /Por oficina/ }).click();
    // `exact: true` porque el botón de expandir la fila también se llama "... OFICINA DE GESTIÓN
    // ADMINISTRATIVA" (Fase 6: nombre truncado con `title`, columna de expandir con aria-label).
    await expect(page.getByRole('cell', { name: 'OFICINA DE GESTIÓN ADMINISTRATIVA', exact: true })).toBeVisible();
    expect(pedidosOficinas).toBe(1);
    expect(pedidosEmpleados).toBe(0);

    // 3. Abrir "Por empleado" es lo que dispara su consulta, por primera vez.
    await page.getByRole('tab', { name: /Por empleado/ }).click();
    await expect(page.getByText('ICHO SAN MARTIN LIZZETH')).toBeVisible();
    expect(pedidosEmpleados).toBe(1);

    // 4. Ir y volver no la vuelve a pedir: queda cacheada en el cliente para estos filtros.
    await page.getByRole('tab', { name: 'Resumen' }).click();
    await expect(page.getByText('897')).toBeVisible();
    await page.getByRole('tab', { name: /Por empleado/ }).click();
    await expect(page.getByText('ICHO SAN MARTIN LIZZETH')).toBeVisible();
    expect(pedidosEmpleados).toBe(1);
    expect(pedidosOficinas).toBe(1);
  });

  test('cambiar un filtro invalida lo cargado y vuelve a pedir ambas agregaciones', async ({ page }) => {
    await abrirDashboard(page);
    await page.route('**/api/dependencias', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { coDependencia: '00012', deDependencia: 'UNIDAD DE ESTUDIOS, PROYECTOS Y OBRAS', deSigla: 'UEPO', coTipoEncargatura: null, jefe: null, padre: null, tipoEncargaturaDescripcion: null, cargoDescripcion: null },
        ]),
      }),
    );
    const urlsOficinas: string[] = [];
    const urlsEmpleados: string[] = [];
    await page.route('**/api/dashboard/oficinas**', (route) => {
      urlsOficinas.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OFICINAS) });
    });
    await page.route('**/api/dashboard/empleados**', (route) => {
      urlsEmpleados.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPLEADOS) });
    });

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Por empleado/ }).click();
    await expect(page.getByText('ICHO SAN MARTIN LIZZETH')).toBeVisible();
    expect(urlsEmpleados).toHaveLength(1);

    // Estando en la pestaña de empleados, cambiar el filtro debe repedirla con el filtro nuevo.
    await page.getByLabel('Oficina').selectOption('00012');

    await expect.poll(() => urlsOficinas.some((u) => u.includes('coDependencia=00012'))).toBe(true);
    await expect.poll(() => urlsEmpleados.some((u) => u.includes('coDependencia=00012'))).toBe(true);
  });

  test('buscar un empleado filtra la tabla sin pedir de nuevo la agregación', async ({ page }) => {
    await abrirDashboard(page);
    let pedidos = 0;
    await page.route('**/api/dashboard/empleados**', (route) => {
      pedidos += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPLEADOS) });
    });

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Por empleado/ }).click();
    await expect(page.getByText('ICHO SAN MARTIN LIZZETH')).toBeVisible();

    await page.getByPlaceholder('Buscar por nombre u oficina…').fill('GALARZA');

    await expect(page.getByText('GALARZA LOPEZ MERCEDES')).toBeVisible();
    await expect(page.getByText('ICHO SAN MARTIN LIZZETH')).toHaveCount(0);
    expect(pedidos).toBe(1);
  });

  test('un error del backend se muestra con opción de reintentar', async ({ page }) => {
    await page.route('**/api/dependencias', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
    await page.route('**/api/dashboard/tipos-documento', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
    await page.route('**/api/dashboard/oficinas**', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Error al calcular el desempeño por oficina' }) }),
    );
    await page.route('**/api/dashboard/resumen/estado', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESUMEN_ESTADO) }),
    );

    await iniciarSesionSimulada(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Dashboard' }).click();

    await expect(page.getByText('No se pudo calcular el resumen de desempeño.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  });

  test('un error solo en la agregación por empleado se muestra en su pestaña y "Reintentar" la recarga', async ({ page }) => {
    await abrirDashboard(page);
    let intentos = 0;
    await page.route('**/api/dashboard/empleados**', (route) => {
      intentos += 1;
      // Falla la primera vez, funciona la segunda: así "Reintentar" tiene algo que demostrar.
      return intentos === 1
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Error al calcular el desempeño por empleado' }) })
        : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPLEADOS) });
    });

    await page.getByRole('button', { name: 'Dashboard' }).click();
    // El Resumen carga bien: el fallo está acotado a la agregación perezosa.
    await expect(page.getByText('897')).toBeVisible();

    await page.getByRole('tab', { name: /Por empleado/ }).click();
    await expect(page.getByText('No se pudo calcular el resumen de desempeño.')).toBeVisible();

    await page.getByRole('button', { name: 'Reintentar' }).click();

    await expect(page.getByText('ICHO SAN MARTIN LIZZETH')).toBeVisible();
    expect(intentos).toBe(2);
  });
});

test.describe('Dashboard — Fase 2: calidad y carga laboral', () => {
  test('"Por oficina" muestra informativos, anulación y reproceso al expandir la fila (Fase 6)', async ({ page }) => {
    await abrirDashboard(page);
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Por oficina/ }).click();

    // Fase 6: estas métricas ya no son columnas propias — viven en el panel que se abre al
    // expandir la fila, junto con el resto de calidad/complejidad.
    await page.getByRole('button', { name: /Ver más métricas de OFICINA DE GESTIÓN ADMINISTRATIVA/ }).click();

    // Acotado a la fila expandida (Fase 9: el glosario, al final de la tabla, repite estos mismos
    // términos como encabezado de su propia definición — sin acotar, `getByText` sería ambiguo).
    const panel = page.locator('.fila-detalle');
    await expect(panel.getByText('Informativos', { exact: true })).toBeVisible();
    await expect(panel.getByText('Anulación', { exact: true })).toBeVisible();
    await expect(panel.getByText('Reproceso', { exact: true })).toBeVisible();
    // Tasa de anulación de la OGA: 60/1000 = 6%.
    await expect(page.getByText('6%')).toBeVisible();
  });

  test('la pestaña "Pendientes" ignora el rango de fechas — solo se repide al cambiar oficina/tipo', async ({ page }) => {
    await abrirDashboard(page);
    await page.route('**/api/dependencias', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { coDependencia: '00012', deDependencia: 'UNIDAD DE ESTUDIOS, PROYECTOS Y OBRAS', deSigla: 'UEPO', coTipoEncargatura: null, jefe: null, padre: null, tipoEncargaturaDescripcion: null, cargoDescripcion: null },
        ]),
      }),
    );
    const pedidos: string[] = [];
    await page.route('**/api/dashboard/pendientes/oficinas**', (route) => {
      pedidos.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PENDIENTES) });
    });

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Pendientes/ }).click();

    await expect(page.getByRole('cell', { name: 'OFICINA DE ASESORÍA LEGAL' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '113 d' })).toBeVisible();
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]).not.toContain('desde=');
    expect(pedidos[0]).not.toContain('hasta=');

    // Cambiar el rango de fechas NO debe repedir esta pestaña.
    await page.getByLabel('Desde').fill('2026-01-01');
    await page.waitForTimeout(200);
    expect(pedidos).toHaveLength(1);

    // Cambiar la oficina sí la repide, con el filtro nuevo.
    await page.getByLabel('Oficina').selectOption('00012');
    await expect.poll(() => pedidos.length).toBe(2);
    expect(pedidos[1]).toContain('coDependencia=00012');
  });
});

test.describe('Dashboard — espejo local: frescura y refresco manual', () => {
  test('muestra hace cuánto se actualizaron los datos', async ({ page }) => {
    await abrirDashboard(page);

    await page.getByRole('button', { name: 'Dashboard' }).click();

    await expect(page.getByText('Datos actualizados hace 5 min.')).toBeVisible();
  });

  test('sin dashboard.gestionar, no aparece el botón de actualizar', async ({ page }) => {
    await abrirDashboard(page, ['seguimiento.ver', 'dashboard.ver']);

    await page.getByRole('button', { name: 'Dashboard' }).click();

    await expect(page.getByRole('button', { name: 'Actualizar ahora' })).toHaveCount(0);
  });

  test('con dashboard.gestionar, "Actualizar ahora" dispara el refresco y vuelve a pedir lo cargado', async ({ page }) => {
    await abrirDashboard(page);
    let pedidosRefresco = 0;
    let pedidosOficinas = 0;
    await page.route('**/api/dashboard/resumen/refrescar', (route) => {
      pedidosRefresco += 1;
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ id: 1, participaciones: 46000, emisiones: 42000, msSgd: 9000, msTotal: 9500 }),
      });
    });
    await page.route('**/api/dashboard/oficinas**', (route) => {
      pedidosOficinas += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OFICINAS) });
    });

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await expect(page.getByRole('button', { name: 'Actualizar ahora' })).toBeVisible();
    expect(pedidosOficinas).toBe(1);

    await page.getByRole('button', { name: 'Actualizar ahora' }).click();

    await expect.poll(() => pedidosRefresco).toBe(1);
    await expect.poll(() => pedidosOficinas).toBe(2); // se volvió a pedir tras el refresco
    await expect(page.getByRole('button', { name: 'Actualizar ahora' })).toBeVisible(); // vuelve a habilitarse
  });

  test('si el último refresco falló, lo dice en vez de mostrar una frescura inventada', async ({ page }) => {
    await page.route('**/api/dependencias', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
    await page.route('**/api/dashboard/tipos-documento', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
    await page.route('**/api/dashboard/oficinas**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OFICINAS) }),
    );
    await page.route('**/api/dashboard/resumen/estado', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ultimoRefresco: null, minutosDesde: null, participaciones: 0, ultimoError: 'timeout de red' }),
      }),
    );

    await iniciarSesionSimulada(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Dashboard' }).click();

    await expect(page.getByText('El último refresco falló: timeout de red')).toBeVisible();
  });
});

test.describe('Dashboard — Fase 3: pesos por tipo de documento', () => {
  test('"Por oficina" muestra productividad y carga ponderadas al expandir la fila (Fase 6)', async ({ page }) => {
    await abrirDashboard(page);
    await page.getByRole('button', { name: 'Dashboard' }).click();

    await page.getByRole('tab', { name: /Por oficina/ }).click();
    // Fase 6: ya no son columnas propias — están en el panel expandible, junto a la fila de la
    // oficina 00012 (productividadPonderada=7, cargaPonderada=18; pesos en 1 == atendidos/recibidos).
    await page.getByRole('button', { name: /Ver más métricas de UNIDAD DE ESTUDIOS, PROYECTOS Y OBRAS/ }).click();

    // Acotado a la fila expandida (Fase 9: el glosario repite estos mismos términos al final de
    // la tabla, y "Prod. ponderada" además aparece dentro de la definición de "Carga ponderada").
    const panel = page.locator('.fila-detalle');
    await expect(panel.getByText('Prod. ponderada')).toBeVisible();
    await expect(panel.getByText('Carga ponderada')).toBeVisible();
    await expect(page.getByText('7.0')).toBeVisible();
    await expect(page.getByText('18.0')).toBeVisible();
  });

  test('sin dashboard.gestionar, la pestaña "Pesos por tipo" no aparece', async ({ page }) => {
    await abrirDashboard(page, ['seguimiento.ver', 'dashboard.ver']);

    await page.getByRole('button', { name: 'Dashboard' }).click();

    await expect(page.getByRole('tab', { name: /Pesos por tipo/ })).toHaveCount(0);
  });

  test('con dashboard.gestionar, la pestaña carga el catálogo con muestra, mediana y sugerencia', async ({ page }) => {
    await abrirDashboard(page);
    await page.route('**/api/dashboard/pesos', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PESOS_TIPO_DOCUMENTO) }),
    );

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Pesos por tipo/ }).click();

    await expect(page.getByRole('cell', { name: 'PROVEÍDO' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '40' })).toBeVisible(); // muestra
    await expect(page.getByRole('cell', { name: '1.42' })).toBeVisible(); // sugerido
    await expect(page.getByRole('cell', { name: 'HOJA DE ENVÍO' })).toBeVisible();
    // Sin muestra suficiente: sin sugerencia, se ve "—" en vez de un número.
    await expect(page.getByLabel('Peso de PROVEÍDO')).toHaveValue('1.5');
  });

  test('"Usar sugerido" rellena el campo sin guardar hasta apretar "Guardar"', async ({ page }) => {
    await abrirDashboard(page);
    await page.route('**/api/dashboard/pesos', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PESOS_TIPO_DOCUMENTO) }),
    );
    let guardados = 0;
    await page.route('**/api/dashboard/pesos/232', (route) => {
      guardados += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Pesos por tipo/ }).click();
    await expect(page.getByLabel('Peso de PROVEÍDO')).toHaveValue('1.5');

    const filaProveido = page.getByRole('row', { name: /PROVEÍDO/ });
    await filaProveido.getByRole('button', { name: 'Usar sugerido' }).click();
    await expect(page.getByLabel('Peso de PROVEÍDO')).toHaveValue('1.42');
    expect(guardados).toBe(0); // todavía no se guardó, solo se rellenó el campo

    await filaProveido.getByRole('button', { name: 'Guardar' }).click();
    await expect.poll(() => guardados).toBe(1);
  });

  test('guardar un peso llama al PUT con el valor del campo y vuelve a pedir la lista', async ({ page }) => {
    await abrirDashboard(page);
    let pedidosLista = 0;
    await page.route('**/api/dashboard/pesos', (route) => {
      pedidosLista += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PESOS_TIPO_DOCUMENTO) });
    });
    let cuerpoRecibido: unknown = null;
    await page.route('**/api/dashboard/pesos/304', (route) => {
      cuerpoRecibido = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Pesos por tipo/ }).click();
    await expect.poll(() => pedidosLista).toBe(1);

    const filaHojaEnvio = page.getByRole('row', { name: /HOJA DE ENVÍO/ });
    await filaHojaEnvio.getByLabel('Peso de HOJA DE ENVÍO').fill('2.5');
    await filaHojaEnvio.getByRole('button', { name: 'Guardar' }).click();

    await expect.poll(() => cuerpoRecibido).toEqual({ peso: 2.5 });
    await expect.poll(() => pedidosLista).toBe(2); // se volvió a pedir tras guardar
  });
});

test.describe('Dashboard — Fase 4: índice global calibrado', () => {
  test('"Por oficina" muestra el índice y su nivel, calculado dentro de TODAS las oficinas del período', async ({ page }) => {
    await abrirDashboard(page);
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Por oficina/ }).click();

    // Fase 6: el nivel ya no es una columna propia — el badge se fusionó en la misma celda que
    // el valor del índice, para no repetir dos veces la misma lectura.
    await expect(page.getByRole('columnheader', { name: 'Índice global' })).toBeVisible();

    // OGA domina las 3 dimensiones del índice frente a UEPO (más tasa de atención, menos tiempo,
    // menos anulación) — con solo 2 oficinas en el grupo, el z-score de CUALQUIER dimensión donde
    // una gane a la otra es siempre ±1/√2 ≈ ±0,71, sin importar los pesos exactos (que suman 1).
    await expect(page.locator('[title^="Índice 0.71 — percentil 100"]')).toBeVisible();
    await expect(page.locator('[title^="Índice 0.71 — percentil 100"]')).toHaveText('Alto');
    await expect(page.locator('[title^="Índice -0.71 — percentil 0"]')).toBeVisible();
    await expect(page.locator('[title^="Índice -0.71 — percentil 0"]')).toHaveText('Bajo');
  });

  test('"Por empleado" agrupa el índice por oficina — ambos empleados del fixture están en la misma', async ({ page }) => {
    await abrirDashboard(page);
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Por empleado/ }).click();
    await expect(page.getByText('ICHO SAN MARTIN LIZZETH')).toBeVisible();

    // ICHO domina las 3 dimensiones frente a GALARZA (misma oficina 00012) — mismo razonamiento
    // de arriba: con un grupo de 2, el índice de quien gana en todo es siempre +1/√2.
    await expect(page.locator('[title^="Índice 0.71 — percentil 100"]')).toHaveText('Alto');
    await expect(page.locator('[title^="Índice -0.71 — percentil 0"]')).toHaveText('Bajo');
  });

  test('buscar un empleado no achica su grupo de comparación del índice', async ({ page }) => {
    await abrirDashboard(page);
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Por empleado/ }).click();
    await expect(page.getByText('ICHO SAN MARTIN LIZZETH')).toBeVisible();

    // Filtrar a solo GALARZA no debe cambiar su índice/nivel: si el grupo se recalculara sobre la
    // tabla ya filtrada (un solo empleado), su percentil pasaría a 50 ("Medio") en vez de 0 ("Bajo").
    await page.getByPlaceholder('Buscar por nombre u oficina…').fill('GALARZA');
    await expect(page.getByText('ICHO SAN MARTIN LIZZETH')).toHaveCount(0);
    await expect(page.locator('[title^="Índice -0.71 — percentil 0"]')).toHaveText('Bajo');
  });
});

/** `YYYY-MM-DD` de hoy más un desplazamiento en días — para llenar los campos "Desde"/"Hasta" a
 *  mano en las pruebas que sí necesitan un rango (Fase 9: ya no hay un rango por defecto). */
function fechaEnDias(offsetDias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDias);
  return d.toISOString().slice(0, 10);
}

function fechaHace(diasAtras: number): string {
  return fechaEnDias(-diasAtras);
}

function fechaHoy(): string {
  return fechaEnDias(0);
}

/**
 * Distingue el período ACTUAL del ANTERIOR por la fecha `desde` de la URL — `periodoAnterior` (en
 * `DashboardPage.tsx`) siempre desplaza el período elegido hacia atrás, así que cualquier fecha de
 * corte ESTRICTAMENTE ENTRE el `desde` actual (`fechaHace(30)` en las pruebas que llenan el rango
 * a mano) y el `desde` del período anterior (~61 días atrás: el mismo rango de 31 días, desplazado
 * antes de ese) sirve — se usa el punto medio (~45 días atrás) para no depender de cuándo se
 * ejecute la prueba.
 */
function corteEntrePeriodos(): string {
  const d = new Date();
  d.setDate(d.getDate() - 45);
  return d.toISOString().slice(0, 10);
}

test.describe('Dashboard — Fase 5: insights automáticos', () => {
  test('carga laboral desigual: un empleado muy por encima del promedio de su oficina', async ({ page }) => {
    await abrirDashboard(page);

    // Tres empleados en la misma oficina: uno con el cuádruple de recibidos que el promedio.
    await page.route('**/api/dashboard/empleados**', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([
          { ...EMPLEADOS[0], recibidos: 6, recibidosExternos: 6, coEmpleado: '00061' },
          { ...EMPLEADOS[1], recibidos: 6, recibidosExternos: 6, coEmpleado: '00046' },
          { ...EMPLEADOS[0], recibidos: 24, recibidosExternos: 24, coEmpleado: '00070', nombreCompleto: 'QUISPE MAMANI ROSA' },
        ]),
      }),
    );

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Hallazgos/ }).click();
    // Fase 7: "Carga laboral" es la sub-pestaña por defecto, pero se hace explícito el click en
    // vez de depender de eso — documenta la intención y no se rompe si el default cambia.
    await page.getByRole('tab', { name: /Carga laboral/ }).click();

    await expect(page.getByText(/QUISPE MAMANI ROSA tiene una carga/)).toBeVisible();
  });

  test('Fase 8: recibir la respuesta de la propia oficina no cuenta como carga nueva', async ({ page }) => {
    await abrirDashboard(page);

    // Misma forma que la prueba anterior (QUISPE con 24 recibidos vs. 6 de sus compañeros), pero
    // acá esos 24 son, en su mayoría, la propia oficina respondiéndole (recibidosMismaOficina:
    // 24 - 6 = 18) — solo 6 le llegaron de afuera, igual que sus compañeros. Sin la distinción de
    // Fase 8 esto dispararía la misma alerta que la prueba de arriba; con ella, no debería.
    await page.route('**/api/dashboard/empleados**', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([
          { ...EMPLEADOS[0], recibidos: 6, recibidosExternos: 6, coEmpleado: '00061' },
          { ...EMPLEADOS[1], recibidos: 6, recibidosExternos: 6, coEmpleado: '00046' },
          {
            ...EMPLEADOS[0], recibidos: 24, recibidosExternos: 6,
            coEmpleado: '00070', nombreCompleto: 'QUISPE MAMANI ROSA',
          },
        ]),
      }),
    );

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Hallazgos/ }).click();

    // Sin ninguna otra categoría con hallazgos, no hay sub-pestañas — el mensaje genérico ya
    // confirma que "Carga laboral" quedó en 0 (mismo criterio que la prueba "sin ningún hallazgo").
    await expect(page.getByText('Sin hallazgos relevantes en este período')).toBeVisible();
    await expect(page.getByText(/QUISPE MAMANI ROSA tiene una carga/)).toHaveCount(0);
  });

  test('tendencia: compara el período elegido contra el período anterior de igual duración', async ({ page }) => {
    await abrirDashboard(page);
    const corte = corteEntrePeriodos();

    // Anterior: UEPO por delante de OGA — al revés que `OFICINAS` (el fixture "actual" de arriba,
    // donde OGA domina) — un swap limpio que da una tendencia clara en ambos sentidos.
    const OFICINAS_ANTERIOR = [
      { ...OFICINAS[0], tasaAtencion: 0.30, tiempoPromedioHoras: 40, tasaAnulacion: 0.30 },
      { ...OFICINAS[1], tasaAtencion: 0.90, tiempoPromedioHoras: 2, tasaAnulacion: 0.01 },
    ];
    await page.route('**/api/dashboard/oficinas**', (route) => {
      const desde = new URL(route.request().url()).searchParams.get('desde') ?? '';
      const datos = desde < corte ? OFICINAS_ANTERIOR : OFICINAS;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(datos) });
    });

    await page.getByRole('button', { name: 'Dashboard' }).click();
    // Fase 9: la tendencia necesita un rango de fechas elegido — sin fechas, ya no se pide el
    // período anterior. `fechaHace(30)`/`fechaHoy()` reproducen el rango que antes era el default.
    await page.getByLabel('Desde').fill(fechaHace(30));
    await page.getByLabel('Hasta').fill(fechaHoy());
    await page.getByRole('tab', { name: /Hallazgos/ }).click();
    // Fase 7: "Tendencia" ya no es la sub-pestaña activa por defecto (esa es "Carga laboral").
    await page.getByRole('tab', { name: /Tendencia/ }).click();

    await expect(page.getByText(/OFICINA DE GESTIÓN ADMINISTRATIVA mejoró su índice global/)).toBeVisible();
    await expect(page.getByText(/UNIDAD DE ESTUDIOS, PROYECTOS Y OBRAS empeoró su índice global/)).toBeVisible();
  });

  test('sin ningún hallazgo, se explica en vez de mostrar la lista vacía sin más', async ({ page }) => {
    await abrirDashboard(page);
    // Mismos datos para el período actual y el anterior: sin diferencia, sin tendencia que reportar.
    await page.route('**/api/dashboard/oficinas**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OFICINAS) }),
    );
    // Ambos empleados con la misma carga (9 recibidos) y sin muestra para reproceso/complejidad
    // (regla 3/4 exige al menos 4 empleados) — ningún umbral se cruza.
    await page.route('**/api/dashboard/empleados**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPLEADOS) }),
    );

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Hallazgos/ }).click();

    await expect(page.getByText('Sin hallazgos relevantes en este período')).toBeVisible();
  });

  test('abrir Hallazgos después de "Por empleado" no vuelve a pedir la misma agregación', async ({ page }) => {
    await abrirDashboard(page);
    let pedidos = 0;
    await page.route('**/api/dashboard/empleados**', (route) => {
      pedidos += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPLEADOS) });
    });

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Por empleado/ }).click();
    await expect(page.getByText('ICHO SAN MARTIN LIZZETH')).toBeVisible();
    expect(pedidos).toBe(1);

    await page.getByRole('tab', { name: /Hallazgos/ }).click();
    await expect(page.getByText('Sin hallazgos relevantes en este período')).toBeVisible();
    expect(pedidos).toBe(1); // reusa lo que "Por empleado" ya había pedido para este mismo filtro
  });
});

test.describe('Dashboard — Fase 6: tipo de UUOO (instituciones vs. comités) y columnas reducidas', () => {
  test('"Por oficina" separa instituciones de comités en sub-pestañas con conteo, sin mezclar filas', async ({ page }) => {
    await abrirDashboard(page);
    await page.route('**/api/dashboard/oficinas**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([...OFICINAS, ...COMITES]) }),
    );

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Por oficina/ }).click();

    // Por defecto se abre en "Instituciones": las 2 oficinas reales, ningún comité.
    await expect(page.getByRole('tab', { name: 'Instituciones (2)' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Comités (2)' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'OFICINA DE GESTIÓN ADMINISTRATIVA', exact: true })).toBeVisible();
    await expect(page.getByText('COMITE DE EVALUACION PERMANENTE')).toHaveCount(0);

    await page.getByRole('tab', { name: 'Comités (2)' }).click();

    await expect(page.getByRole('cell', { name: 'COMITE DE EVALUACION PERMANENTE', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'COMITE DE EVALUACION - RJ 011-2026-MINEDU-UE-MCEBS', exact: true })).toBeVisible();
    await expect(page.getByText('OFICINA DE GESTIÓN ADMINISTRATIVA')).toHaveCount(0);
    await expect(page.getByText('UNIDAD DE ESTUDIOS, PROYECTOS Y OBRAS')).toHaveCount(0);
  });

  test('el índice global se calcula por separado en cada categoría, no sobre las 4 oficinas mezcladas', async ({ page }) => {
    await abrirDashboard(page);
    await page.route('**/api/dashboard/oficinas**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([...OFICINAS, ...COMITES]) }),
    );

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Por oficina/ }).click();

    // Instituciones: OGA domina a UEPO en las 3 dimensiones — grupo de 2, ±1/√2 ≈ ±0,71.
    await expect(page.locator('[title^="Índice 0.71 — percentil 100"]')).toHaveText('Alto');
    await expect(page.locator('[title^="Índice -0.71 — percentil 0"]')).toHaveText('Bajo');

    // Comités: si el grupo se calculara junto con instituciones (4 miembros), este valor exacto
    // ±0,71 no se repetiría — que aparezca de nuevo, ahora para el comité permanente, confirma que
    // el grupo de comparación se recalculó aparte, con sus propios 2 miembros.
    await page.getByRole('tab', { name: 'Comités (2)' }).click();
    await expect(page.locator('[title^="Índice 0.71 — percentil 100"]')).toHaveText('Alto');
    await expect(page.locator('[title^="Índice -0.71 — percentil 0"]')).toHaveText('Bajo');
  });

  test('"Por empleado" separa por la categoría de la oficina del empleado', async ({ page }) => {
    await abrirDashboard(page);
    await page.route('**/api/dashboard/empleados**', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([
          ...EMPLEADOS,
          {
            ...EMPLEADOS[0], coEmpleado: '00099', nombreCompleto: 'RAMOS DIAZ PEDRO',
            coDependencia: '00022', nombreDependencia: 'COMITE DE EVALUACION PERMANENTE', esComite: true,
          },
        ]),
      }),
    );

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Por empleado/ }).click();

    await expect(page.getByRole('tab', { name: 'Instituciones (2)' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Comités (1)' })).toBeVisible();
    await expect(page.getByText('ICHO SAN MARTIN LIZZETH')).toBeVisible();
    await expect(page.getByText('RAMOS DIAZ PEDRO')).toHaveCount(0);

    await page.getByRole('tab', { name: 'Comités (1)' }).click();
    await expect(page.getByText('RAMOS DIAZ PEDRO')).toBeVisible();
    await expect(page.getByText('ICHO SAN MARTIN LIZZETH')).toHaveCount(0);
  });

  test('"Por oficina" muestra 8 columnas (valor y nivel fusionados), sin columnas "Nivel — ..." separadas', async ({ page }) => {
    await abrirDashboard(page);
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Por oficina/ }).click();

    const encabezados = page.locator('.tabla-oficinas thead th');
    await expect(encabezados).toHaveCount(8);
    await expect(page.getByRole('columnheader', { name: 'Oficina' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Tasa de atención' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Tiempo promedio' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Índice global' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /^Nivel/ })).toHaveCount(0);
  });
});

test.describe('Dashboard — Fase 7: hallazgos por categoría (sub-pestañas + orden por severidad)', () => {
  test('separa los hallazgos en sub-pestañas por categoría, con conteo, sin mezclar', async ({ page }) => {
    await abrirDashboard(page);

    // Carga laboral: 1 hallazgo (QUISPE por encima de sus 2 compañeros). Tendencia: 2 hallazgos
    // (mismo swap OGA/UEPO ya usado en Fase 5). Calidad y Complejidad quedan en 0.
    await page.route('**/api/dashboard/empleados**', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([
          { ...EMPLEADOS[0], recibidos: 6, recibidosExternos: 6, coEmpleado: '00061' },
          { ...EMPLEADOS[1], recibidos: 6, recibidosExternos: 6, coEmpleado: '00046' },
          { ...EMPLEADOS[0], recibidos: 24, recibidosExternos: 24, coEmpleado: '00070', nombreCompleto: 'QUISPE MAMANI ROSA' },
        ]),
      }),
    );
    const corte = corteEntrePeriodos();
    const OFICINAS_ANTERIOR = [
      { ...OFICINAS[0], tasaAtencion: 0.30, tiempoPromedioHoras: 40, tasaAnulacion: 0.30 },
      { ...OFICINAS[1], tasaAtencion: 0.90, tiempoPromedioHoras: 2, tasaAnulacion: 0.01 },
    ];
    await page.route('**/api/dashboard/oficinas**', (route) => {
      const desde = new URL(route.request().url()).searchParams.get('desde') ?? '';
      const datos = desde < corte ? OFICINAS_ANTERIOR : OFICINAS;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(datos) });
    });

    await page.getByRole('button', { name: 'Dashboard' }).click();
    // Fase 9: la tendencia necesita un rango de fechas elegido — sin fechas, ya no se pide el
    // período anterior, y esta prueba depende de que sí se pida (2 hallazgos de tendencia).
    await page.getByLabel('Desde').fill(fechaHace(30));
    await page.getByLabel('Hasta').fill(fechaHoy());
    await page.getByRole('tab', { name: /Hallazgos/ }).click();

    await expect(page.getByRole('tab', { name: 'Carga laboral (1)' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Calidad (0)' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Complejidad (0)' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Tendencia (2)' })).toBeVisible();

    // Por defecto, "Carga laboral": solo ese hallazgo, nada de tendencia todavía.
    await expect(page.getByText(/QUISPE MAMANI ROSA tiene una carga/)).toBeVisible();
    await expect(page.getByText(/mejoró su índice global/)).toHaveCount(0);

    await page.getByRole('tab', { name: 'Tendencia (2)' }).click();
    await expect(page.getByText(/mejoró su índice global/)).toBeVisible();
    await expect(page.getByText(/QUISPE MAMANI ROSA tiene una carga/)).toHaveCount(0);
  });

  test('dentro de una categoría, el hallazgo más severo aparece primero', async ({ page }) => {
    await abrirDashboard(page);

    // 3 empleados base (6 recibidos) + 2 sobrecargados con distinta proporción — promedio = 19.6.
    // TORRES QUISPE MARIA: 50/19.6 ≈ 2.55× (155% de exceso) — el más severo, debe ir primero.
    // VARGAS LEON PEDRO: 30/19.6 ≈ 1.53× (53% de exceso) — cruza el umbral, pero menos.
    // `cargaPonderada` se ajusta proporcional a `recibidos` en los 5 (complejidad = 1.5 siempre)
    // para que la regla 3 (complejidad) no dispare por accidente y contamine la prueba.
    await page.route('**/api/dashboard/empleados**', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([
          { ...EMPLEADOS[0], recibidos: 6, recibidosExternos: 6, cargaPonderada: 9, coEmpleado: '00061' },
          { ...EMPLEADOS[1], recibidos: 6, recibidosExternos: 6, cargaPonderada: 9, coEmpleado: '00046' },
          { ...EMPLEADOS[0], recibidos: 6, recibidosExternos: 6, cargaPonderada: 9, coEmpleado: '00070', nombreCompleto: 'RAMOS DIAZ ELSA' },
          { ...EMPLEADOS[0], recibidos: 30, recibidosExternos: 30, cargaPonderada: 45, coEmpleado: '00071', nombreCompleto: 'VARGAS LEON PEDRO' },
          { ...EMPLEADOS[0], recibidos: 50, recibidosExternos: 50, cargaPonderada: 75, coEmpleado: '00072', nombreCompleto: 'TORRES QUISPE MARIA' },
        ]),
      }),
    );

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Hallazgos/ }).click();
    await page.getByRole('tab', { name: /Carga laboral/ }).click();

    const filas = page.locator('.insights-item');
    await expect(filas).toHaveCount(2);
    await expect(filas.nth(0)).toContainText('TORRES QUISPE MARIA');
    await expect(filas.nth(1)).toContainText('VARGAS LEON PEDRO');
  });

  test('una categoría vacía muestra su propio mensaje, no el mensaje global (que sí tiene hallazgos en otra)', async ({ page }) => {
    await abrirDashboard(page);
    // Mismo fixture de carga laboral que ya prueba la separación — Calidad/Complejidad quedan
    // vacías (sin muestra suficiente) mientras Carga laboral sí tiene un hallazgo.
    await page.route('**/api/dashboard/empleados**', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([
          { ...EMPLEADOS[0], recibidos: 6, recibidosExternos: 6, coEmpleado: '00061' },
          { ...EMPLEADOS[1], recibidos: 6, recibidosExternos: 6, coEmpleado: '00046' },
          { ...EMPLEADOS[0], recibidos: 24, recibidosExternos: 24, coEmpleado: '00070', nombreCompleto: 'QUISPE MAMANI ROSA' },
        ]),
      }),
    );

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Hallazgos/ }).click();
    await page.getByRole('tab', { name: 'Calidad (0)' }).click();

    await expect(page.getByText('Sin hallazgos en esta categoría en este período.')).toBeVisible();
    await expect(page.getByText('Sin hallazgos relevantes en este período')).toHaveCount(0);
  });
});

test.describe('Dashboard — Fase 9: fecha opcional (global por defecto) y glosario de indicadores', () => {
  test('sin fechas puestas, pide sin desde/hasta y avisa que muestra todos los datos', async ({ page }) => {
    const urlsOficinas: string[] = [];
    await page.route('**/api/dependencias', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
    await page.route('**/api/dashboard/tipos-documento', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TIPOS_DOCUMENTO) }),
    );
    await page.route('**/api/dashboard/oficinas**', (route) => {
      urlsOficinas.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OFICINAS) });
    });
    await page.route('**/api/dashboard/empleados**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPLEADOS) }),
    );
    await page.route('**/api/dashboard/pendientes/oficinas**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PENDIENTES) }),
    );
    await page.route('**/api/dashboard/resumen/estado', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESUMEN_ESTADO) }),
    );
    await iniciarSesionSimulada(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'Dashboard' }).click();

    await expect(page.getByText('Mostrando todos los datos disponibles en la base de datos.')).toBeVisible();
    expect(urlsOficinas).toHaveLength(1);
    expect(urlsOficinas[0]).not.toContain('desde=');
    expect(urlsOficinas[0]).not.toContain('hasta=');
    // Los campos de fecha del formulario quedan vacíos, no en "últimos 30 días".
    await expect(page.getByLabel('Desde')).toHaveValue('');
    await expect(page.getByLabel('Hasta')).toHaveValue('');
  });

  test('con un solo extremo puesto, el rango queda abierto de ese lado', async ({ page }) => {
    const urlsOficinas: string[] = [];
    await abrirDashboard(page);
    await page.route('**/api/dashboard/oficinas**', (route) => {
      urlsOficinas.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OFICINAS) });
    });

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByLabel('Desde').fill(fechaHace(30));

    await expect.poll(() => urlsOficinas.some((u) => u.includes(`desde=${fechaHace(30)}`))).toBe(true);
    expect(urlsOficinas.at(-1)).not.toContain('hasta=');
    await expect(page.getByText(`Mostrando desde el ${fechaHace(30)} en adelante.`)).toBeVisible();
  });

  test('pasar de sin fechas a con fechas vuelve a pedir la agregación', async ({ page }) => {
    let pedidos = 0;
    await abrirDashboard(page);
    await page.route('**/api/dashboard/oficinas**', (route) => {
      pedidos += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OFICINAS) });
    });

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await expect.poll(() => pedidos).toBe(1);

    // Cada `.fill()` es un cambio de filtro independiente (desde/hasta abierto, luego el rango
    // completo) — 2 pedidos más, no 1: llenar "Desde" solo ya dispara uno con el rango abierto.
    await page.getByLabel('Desde').fill(fechaHace(30));
    await expect.poll(() => pedidos).toBe(2);
    await page.getByLabel('Hasta').fill(fechaHoy());

    await expect.poll(() => pedidos).toBe(3);
    await expect(page.getByText(`Mostrando del ${fechaHace(30)} al ${fechaHoy()}.`)).toBeVisible();
  });

  test('el glosario de "Por oficina" está cerrado por defecto y muestra las definiciones al abrirlo', async ({ page }) => {
    await abrirDashboard(page);
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Por oficina/ }).click();

    const glosario = page.locator('.glosario');
    await expect(glosario.getByText('Recibidos', { exact: true })).not.toBeVisible();

    await glosario.getByText('Qué mide cada indicador').click();

    await expect(glosario.getByText('Recibidos', { exact: true })).toBeVisible();
    await expect(glosario.getByText(/Documentos recibidos en el período elegido/)).toBeVisible();
    await expect(glosario.getByText('Índice global', { exact: true })).toBeVisible();
    await expect(glosario.getByText(/Puntaje único que combina tasa de atención/)).toBeVisible();
  });

  test('el glosario de "Por empleado" tiene el mismo contenido', async ({ page }) => {
    await abrirDashboard(page);
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await page.getByRole('tab', { name: /Por empleado/ }).click();
    await expect(page.getByText('ICHO SAN MARTIN LIZZETH')).toBeVisible();

    const glosario = page.locator('.glosario');
    await glosario.getByText('Qué mide cada indicador').click();

    await expect(glosario.getByText('Tiempo promedio', { exact: true })).toBeVisible();
    await expect(glosario.getByText(/Horas promedio entre la recepción/)).toBeVisible();
  });
});
