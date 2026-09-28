import { test, expect, type Page } from '@playwright/test';
import { iniciarSesionReal, iniciarSesionSimulada } from './sesion';

// La vista por defecto de la app es "Seguimiento"; Dependencias vive detrás de la pestaña.
// Ojo: al abrir la app, Seguimiento TAMBIÉN pide /api/dependencias para poblar su combo, así
// que los tests con API simulada verán esa llamada además de la que hace esta página.
async function irADependencias(page: Page, sesion: (p: Page) => Promise<void> = iniciarSesionSimulada) {
  await sesion(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Dependencias' }).click();
}

/** Dependencias simuladas: 1 institución (con miembros) y 2 comités (con presidente y miembros
 *  compartidos), para poder probar filas expandibles y el buscador de persona en comités. */
function dependenciasSimuladas() {
  return [
    {
      coDependencia: '01',
      deDependencia: 'Oficina General de Administración',
      deSigla: 'OGA',
      coTipoEncargatura: null,
      jefe: { cempCodemp: 'E01', cempApepat: 'Rios', cempApemat: 'Soto', cempDenom: 'Juan', nombreCompleto: 'Rios Soto Juan' },
      padre: null,
      tipoEncargaturaDescripcion: null,
      cargoDescripcion: 'Jefe de Oficina',
      esComite: false,
      miembros: [
        { coEmpleado: 'E01', nombreCompleto: 'Rios Soto Juan', cargoDescripcion: 'Jefe de Oficina' },
        { coEmpleado: 'E02', nombreCompleto: 'Diaz Perez Ana', cargoDescripcion: 'Analista' },
      ],
    },
    {
      coDependencia: '02',
      deDependencia: 'Comité de Evaluación - RJ 001-2026',
      deSigla: 'RJ0012026',
      coTipoEncargatura: '1',
      jefe: {
        cempCodemp: 'E10',
        cempApepat: 'Lopez',
        cempApemat: 'Chamorro',
        cempDenom: 'Carlos',
        nombreCompleto: 'Lopez Chamorro Carlos',
      },
      padre: null,
      tipoEncargaturaDescripcion: 'Titular',
      cargoDescripcion: 'Presidente de Comité',
      esComite: true,
      miembros: [
        { coEmpleado: 'E20', nombreCompleto: 'Torres Ponce Erika', cargoDescripcion: 'Miembro' },
        { coEmpleado: 'E21', nombreCompleto: 'Jara Cardenas Richard', cargoDescripcion: 'Miembro' },
      ],
    },
    {
      coDependencia: '03',
      deDependencia: 'Comité de Evaluación - RJ 002-2026',
      deSigla: 'RJ0022026',
      coTipoEncargatura: '1',
      jefe: { cempCodemp: 'E22', cempApepat: 'Herrera', cempApemat: 'Burstein', cempDenom: 'Valia', nombreCompleto: 'Herrera Burstein Valia' },
      padre: null,
      tipoEncargaturaDescripcion: 'Titular',
      cargoDescripcion: 'Presidente de Comité',
      esComite: true,
      // Torres Ponce Erika también aparece acá, como miembro, para probar que el buscador de
      // persona agrupa sus dos comités con roles distintos ("Presidente" en 02 no aplica; acá
      // sigue siendo Miembro en ambos, pero en comités distintos).
      miembros: [{ coEmpleado: 'E20', nombreCompleto: 'Torres Ponce Erika', cargoDescripcion: 'Miembro' }],
    },
  ];
}

test.describe('Página de Dependencias — integración real', () => {
  test('carga instituciones y comités en sus pestañas', async ({ page }) => {
    await irADependencias(page, iniciarSesionReal);

    await expect(page.getByRole('heading', { name: 'Seguimiento de Dependencias' })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Cargando dependencias' })).toBeHidden({ timeout: 15_000 });

    const errorMessage = page.getByRole('alert');
    if (await errorMessage.isVisible().catch(() => false)) {
      test.fail(true, `El backend respondió con error: ${await errorMessage.innerText()}`);
      return;
    }

    const tabInstituciones = page.getByRole('tab', { name: /^Instituciones/ });
    const tabComites = page.getByRole('tab', { name: /^Comités/ });
    await expect(tabInstituciones).toBeVisible();
    await expect(tabComites).toBeVisible();

    await expect(page.getByRole('columnheader', { name: 'Dependencia' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Jefe / Responsable' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Miembros' })).toBeVisible();
    await expect(page.locator('tbody tr').first()).toBeVisible();

    await tabComites.click();
    await expect(page.getByRole('columnheader', { name: 'Presidente / Encargado' })).toBeVisible();
    await expect(page.locator('tbody tr').first()).toBeVisible();
  });

  test('filtra dependencias al escribir en el buscador', async ({ page }) => {
    await irADependencias(page, iniciarSesionReal);
    await expect(page.getByRole('status', { name: 'Cargando dependencias' })).toBeHidden({ timeout: 15_000 });

    const buscador = page.getByRole('searchbox', { name: 'Buscar dependencia' });
    const filas = page.locator('tbody tr');
    const totalInicial = await filas.count();
    test.skip(totalInicial === 0, 'No hay dependencias cargadas para filtrar');

    // Toma un término real de la primera fila para garantizar al menos un match.
    const primerNombre = (await page.locator('tbody tr').first().locator('.dep-name').first().innerText()).trim();
    const termino = primerNombre.slice(0, Math.min(4, primerNombre.length));

    await buscador.fill(termino);

    await expect(async () => {
      const filtradas = await filas.count();
      expect(filtradas).toBeGreaterThan(0);
      expect(filtradas).toBeLessThanOrEqual(totalInicial);
    }).toPass();

    // Un término sin coincidencias muestra el mensaje de "sin resultados".
    await buscador.fill('zzzzznoexiste12345');
    await expect(page.getByText('No se encontraron instituciones que coincidan con la búsqueda.')).toBeVisible();
  });
});

test.describe('Página de Dependencias — estados con API simulada', () => {
  test('muestra el estado de error y permite reintentar', async ({ page }) => {
    // El mock falla mientras `permitir` sea false, sin importar cuántas veces se pida el
    // endpoint: así el test no depende de cuántas llamadas haga la vista de Seguimiento.
    let permitir = false;
    await page.route('**/api/dependencias', async (route) => {
      if (permitir) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      } else {
        await route.fulfill({ status: 500, body: 'Internal Server Error' });
      }
    });

    await irADependencias(page);

    const alerta = page.getByRole('alert');
    await expect(alerta).toBeVisible();
    await expect(alerta).toContainText('No se pudo cargar la lista de dependencias.');
    await expect(alerta).toContainText('HTTP 500');

    permitir = true;
    await page.getByRole('button', { name: 'Reintentar' }).click();

    await expect(alerta).toBeHidden();
    await expect(page.getByText('No se encontraron instituciones que coincidan con la búsqueda.')).toBeVisible();
  });

  test('muestra "Sin jefe asignado" y "Sin miembros registrados" cuando la dependencia no tiene ninguno', async ({
    page,
  }) => {
    await page.route('**/api/dependencias', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            coDependencia: '999',
            deDependencia: 'Dependencia de Prueba',
            deSigla: 'DEP-TEST',
            coTipoEncargatura: null,
            jefe: null,
            padre: null,
            tipoEncargaturaDescripcion: null,
            cargoDescripcion: null,
            esComite: false,
            miembros: [],
          },
        ]),
      });
    });

    await irADependencias(page);

    await expect(page.getByText('Dependencia de Prueba')).toBeVisible();
    await expect(page.getByText('DEP-TEST')).toBeVisible();
    await expect(page.getByText('Sin jefe asignado')).toBeVisible();
    await expect(page.getByText('Sin miembros registrados')).toBeVisible();
    await expect(page.locator('tbody tr').first().locator('td').nth(3)).toHaveText('—');
  });

  test('separa instituciones y comités en pestañas con contador', async ({ page }) => {
    await page.route('**/api/dependencias', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dependenciasSimuladas()) }),
    );

    await irADependencias(page);

    const tabInstituciones = page.getByRole('tab', { name: 'Instituciones (1)' });
    const tabComites = page.getByRole('tab', { name: 'Comités (2)' });
    await expect(tabInstituciones).toBeVisible();
    await expect(tabComites).toBeVisible();
    await expect(tabInstituciones).toHaveAttribute('aria-selected', 'true');

    await expect(page.getByText('Oficina General de Administración')).toBeVisible();
    await expect(page.getByText('Comité de Evaluación - RJ 001-2026')).not.toBeVisible();

    await tabComites.click();
    await expect(tabComites).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Comité de Evaluación - RJ 001-2026')).toBeVisible();
    await expect(page.getByText('Comité de Evaluación - RJ 002-2026')).toBeVisible();
    await expect(page.getByText('Oficina General de Administración')).not.toBeVisible();
  });

  test('expande y oculta la lista de miembros de una dependencia', async ({ page }) => {
    await page.route('**/api/dependencias', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dependenciasSimuladas()) }),
    );

    await irADependencias(page);

    const boton = page.getByRole('button', { name: 'Ver (2)' });
    await expect(boton).toBeVisible();
    await expect(page.getByText('Diaz Perez Ana')).not.toBeVisible();

    await boton.click();
    await expect(page.getByText('Diaz Perez Ana')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ocultar' })).toBeVisible();

    await page.getByRole('button', { name: 'Ocultar' }).click();
    await expect(page.getByText('Diaz Perez Ana')).not.toBeVisible();
  });

  test('el buscador de persona solo aparece en Comités y agrupa presidente/miembro por comité', async ({ page }) => {
    await page.route('**/api/dependencias', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dependenciasSimuladas()) }),
    );

    await irADependencias(page);

    await expect(page.getByRole('searchbox', { name: 'Buscar persona en comités' })).toBeHidden();

    await page.getByRole('tab', { name: 'Comités (2)' }).click();
    const buscadorPersona = page.getByRole('searchbox', { name: 'Buscar persona en comités' });
    await expect(buscadorPersona).toBeVisible();

    // Presidente de un único comité.
    await buscadorPersona.fill('Lopez Chamorro');
    await expect(page.getByText('Lopez Chamorro Carlos — 1 comité')).toBeVisible();
    await expect(page.getByText('Presidente / Encargado')).toBeVisible();
    await expect(page.getByText('Comité de Evaluación - RJ 002-2026')).not.toBeVisible();

    // Miembro presente en los dos comités simulados.
    await buscadorPersona.fill('Torres Ponce');
    await expect(page.getByText('Torres Ponce Erika — 2 comités')).toBeVisible();
    const filasMiembro = page.locator('.lista-comites-persona li');
    await expect(filasMiembro).toHaveCount(2);
    await expect(filasMiembro.first().getByText('Miembro')).toBeVisible();

    // Sin coincidencias.
    await buscadorPersona.fill('zzzzznoexiste12345');
    await expect(page.getByText('Ninguna persona coincide en los comités.')).toBeVisible();
  });
});
