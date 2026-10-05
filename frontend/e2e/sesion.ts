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

  // `SeguimientoPage` (la vista inicial) re-engancha al job de ingesta activo con `rag.gestionar`
  // ANTES de que cualquier prueba navegue a otra pestaña (ver su efecto de "re-enganche, una sola
  // vez al montar"). Sin este mock, esa llamada cae al backend real, que rechaza el token de
  // prueba con 401 — y un 401 en CUALQUIER petición cierra la sesión simulada entera (ver
  // `apiFetch` en `api/cliente.ts`), devolviendo la app al login aunque la prueba nunca haya
  // tocado el panel de RAG. Las pruebas que sí les interesa ese job (`ragPanel.spec.ts`) registran
  // su propio `page.route` después de llamar aquí, que gana por ser el más reciente.
  await page.route('**/api/rag/ingesta', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
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
