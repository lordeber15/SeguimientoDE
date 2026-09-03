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

test.describe('Página de Dependencias — integración real', () => {
  test('carga la lista de dependencias desde el backend', async ({ page }) => {
    await irADependencias(page, iniciarSesionReal);

    await expect(page.getByRole('heading', { name: 'Seguimiento de Dependencias' })).toBeVisible();

    // Espera a que salga del estado "cargando" (skeleton) hacia tabla o error.
    await expect(page.getByRole('status', { name: 'Cargando dependencias' })).toBeHidden({ timeout: 15_000 });

    const errorMessage = page.getByRole('alert');
    if (await errorMessage.isVisible().catch(() => false)) {
      test.fail(true, `El backend respondió con error: ${await errorMessage.innerText()}`);
      return;
    }

    await expect(page.getByRole('columnheader', { name: 'Dependencia' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Jefe / Responsable' })).toBeVisible();

    const filas = page.locator('tbody tr');
    await expect(filas.first()).toBeVisible();

    const contador = page.locator('.result-count');
    await expect(contador).toContainText('de');
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
    await expect(page.getByText('No se encontraron dependencias que coincidan con la búsqueda.')).toBeVisible();
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
    await expect(page.getByText('No se encontraron dependencias que coincidan con la búsqueda.')).toBeVisible();
  });

  test('muestra "Sin jefe asignado" cuando la dependencia no tiene jefe', async ({ page }) => {
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
          },
        ]),
      });
    });

    await irADependencias(page);

    await expect(page.getByText('Dependencia de Prueba')).toBeVisible();
    await expect(page.getByText('DEP-TEST')).toBeVisible();
    await expect(page.getByText('Sin jefe asignado')).toBeVisible();
    await expect(page.locator('tbody tr').first().locator('td').nth(3)).toHaveText('—');
  });
});
