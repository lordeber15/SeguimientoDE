import { test, expect } from '@playwright/test';
import { iniciarSesionSimulada, USUARIO_PRUEBA } from './sesion';

test.describe('Sesión — con API simulada', () => {
  test('sin token la aplicación muestra el login, no los datos', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Seguimiento SGD' })).toBeVisible();
    await expect(page.getByLabel('Usuario')).toBeVisible();
    await expect(page.getByLabel('Contraseña')).toBeVisible();
    // Nada de la aplicación debe verse antes de entrar.
    await expect(page.locator('.app-header')).toHaveCount(0);
  });

  test('unas credenciales incorrectas se explican y no dejan entrar', async ({ page }) => {
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Usuario o contraseña incorrectos. Intentos restantes: 9.' }),
      }),
    );

    await page.goto('/');
    await page.getByLabel('Usuario').fill('08365245');
    await page.getByLabel('Contraseña').fill('mala');
    await page.getByRole('button', { name: 'Entrar' }).click();

    await expect(page.getByRole('alert')).toContainText('Intentos restantes: 9');
    await expect(page.locator('.app-header')).toHaveCount(0);
    // La contraseña se limpia para que un segundo intento no reenvíe la fallida.
    await expect(page.getByLabel('Contraseña')).toHaveValue('');
  });

  test('el bloqueo por intentos se muestra tal cual lo manda el servidor', async ({ page }) => {
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Demasiados intentos fallidos. Vuelva a intentarlo en 15 minuto(s).' }),
      }),
    );

    await page.goto('/');
    await page.getByLabel('Usuario').fill('08365245');
    await page.getByLabel('Contraseña').fill('mala');
    await page.getByRole('button', { name: 'Entrar' }).click();

    await expect(page.getByRole('alert')).toContainText('15 minuto(s)');
  });

  test('tras entrar se ve el nombre y se puede salir', async ({ page }) => {
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'token-de-prueba', usuario: USUARIO_PRUEBA }),
      }),
    );
    await page.route('**/api/dependencias', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );

    await page.goto('/');
    await page.getByLabel('Usuario').fill('08365245');
    await page.getByLabel('Contraseña').fill('correcta');
    await page.getByRole('button', { name: 'Entrar' }).click();

    await expect(page.locator('.app-sesion-nombre')).toHaveText(USUARIO_PRUEBA.nombre);

    await page.getByRole('button', { name: 'Salir' }).click();
    await expect(page.getByRole('heading', { name: 'Seguimiento SGD' })).toBeVisible();
    // Salir debe vaciar el token: recargar no puede devolver la sesión.
    expect(await page.evaluate(() => sessionStorage.getItem('seguimiento.token'))).toBeNull();
  });

  test('un 401 en cualquier petición devuelve al login', async ({ page }) => {
    await iniciarSesionSimulada(page);
    await page.route('**/api/dependencias', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'La sesión ha caducado. Vuelva a entrar.' }),
      }),
    );

    await page.goto('/');

    // El token caducó a media tarde: hay que llevar al login, no dejar una tabla que falla.
    await expect(page.getByRole('heading', { name: 'Seguimiento SGD' })).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Permisos — con API simulada', () => {
  test('sin "usuarios.gestionar" la pestaña de administración no existe', async ({ page }) => {
    await iniciarSesionSimulada(page, ['seguimiento.ver', 'documentos.ver']);
    await page.route('**/api/dependencias', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );

    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Seguimiento' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Usuarios' })).toHaveCount(0);
  });

  test('sin ningún permiso se explica en vez de mostrar una pantalla vacía', async ({ page }) => {
    await iniciarSesionSimulada(page, []);

    await page.goto('/');

    await expect(page.getByText(/todavía no tiene ningún permiso asignado/)).toBeVisible();
  });

  test('con "usuarios.gestionar" se listan los usuarios y sus roles', async ({ page }) => {
    await iniciarSesionSimulada(page);
    // La vista inicial es Seguimiento y pide dependencias: sin simularla iría al backend real,
    // devolvería 401 y la aplicación cerraría la sesión antes de poder pulsar nada.
    await page.route('**/api/dependencias', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
    await page.route('**/api/admin/usuarios', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            codUser: '08365245',
            nombre: 'LOPEZ HERENCIA GERMAN',
            nuDni: '08365245',
            coDependencia: '00009',
            deDependencia: 'OGA-UL',
            habilitado: true,
            feUltimoAcceso: '2026-08-23T19:11:15.153Z',
            roles: ['admin'],
            estadoSgd: 'A',
            existeEnSgd: true,
          },
          {
            codUser: '40226998',
            nombre: 'PEREZ GOMEZ ANA',
            nuDni: '40226998',
            coDependencia: '00010',
            deDependencia: 'OPP',
            habilitado: false,
            feUltimoAcceso: null,
            roles: [],
            estadoSgd: 'X',
            existeEnSgd: true,
          },
        ]),
      }),
    );
    await page.route('**/api/admin/roles', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { codigo: 'admin', nombre: 'Administrador', descripcion: null, delSistema: true, permisos: [], usuarios: 1 },
          { codigo: 'consulta', nombre: 'Consulta', descripcion: null, delSistema: true, permisos: [], usuarios: 0 },
        ]),
      }),
    );

    await page.goto('/');
    await page.getByRole('button', { name: 'Usuarios' }).click();

    await expect(page.getByText('LOPEZ HERENCIA GERMAN')).toBeVisible();
    await expect(page.getByText('PEREZ GOMEZ ANA')).toBeVisible();
    // El estado del SGD se muestra traducido: 'X' no significa nada para quien administra.
    await expect(page.getByText('Dado de baja')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /Administrador para LOPEZ/ })).toBeChecked();
    // Nadie puede quitarse el acceso a sí mismo.
    await expect(page.getByRole('button', { name: 'Deshabilitar' })).toBeDisabled();
  });
});
