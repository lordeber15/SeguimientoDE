import { test, type Page } from '@playwright/test';

export const PERMISOS_TODOS = [
  'seguimiento.ver',
  'documentos.ver',
  'pdf.unificar',
  'usuarios.gestionar',
  'auditoria.ver',
  'rag.gestionar',
  'rag.consultar',
  'dashboard.ver',
  'dashboard.gestionar',
  'calidad.ver',
];

export const USUARIO_PRUEBA = {
  codUser: '08365245',
  nombre: 'USUARIO DE PRUEBA',
  nuDni: '08365245',
  coDependencia: '00009',
  deDependencia: 'OGA-UL',
  roles: ['admin'],
  permisos: PERMISOS_TODOS,
};

/**
 * Deja la aplicación como si el usuario ya hubiera entrado.
 *
 * Desde la Fase 2 la app arranca en el login, así que cada prueba de las demás vistas necesita
 * una sesión. Se simula el endpoint `/api/auth/sesion` y se siembra un token cualquiera en
 * `sessionStorage`: el backend real nunca ve ese token porque todas las rutas están simuladas.
 */
export async function iniciarSesionSimulada(page: Page, permisos: string[] = PERMISOS_TODOS) {
  await page.route('**/api/auth/sesion', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ usuario: { ...USUARIO_PRUEBA, permisos } }),
    }),
  );

  await page.addInitScript(() => {
    sessionStorage.setItem('seguimiento.token', 'token-de-prueba');
  });
}

/**
 * Sesión REAL contra el backend, para las pruebas de integración.
 *
 * Necesita credenciales válidas del SGD, que no pueden vivir en el repositorio. Se pasan por
 * entorno y, si no están, la prueba se salta en vez de fallar:
 *
 *   E2E_USUARIO=... E2E_CLAVE=... npx playwright test
 */
export async function iniciarSesionReal(page: Page) {
  const usuario = process.env.E2E_USUARIO;
  const clave = process.env.E2E_CLAVE;

  test.skip(
    !usuario || !clave,
    'Defina E2E_USUARIO y E2E_CLAVE con credenciales del SGD para las pruebas de integración',
  );

  const api = process.env.VITE_API_URL ?? 'http://localhost:3012';
  const respuesta = await page.request.post(`${api}/api/auth/login`, {
    data: { usuario, clave },
  });

  if (!respuesta.ok()) {
    throw new Error(
      `No se pudo iniciar sesión con E2E_USUARIO (HTTP ${respuesta.status()}): `
        + `${(await respuesta.json().catch(() => ({}))).message ?? ''}`,
    );
  }

  const { token } = await respuesta.json();
  await page.addInitScript((valor) => {
    sessionStorage.setItem('seguimiento.token', valor as string);
  }, token);
}
