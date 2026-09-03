export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3012';

const CLAVE_TOKEN = 'seguimiento.token';

let token: string | null = null;
let alPerderSesion: (() => void) | null = null;

/**
 * El token vive en `sessionStorage`, no en `localStorage`: se pierde al cerrar la pestaña, que es
 * lo que se quiere en un equipo compartido de oficina. Se mantiene además en memoria para no ir
 * al almacenamiento en cada petición.
 */
export function cargarTokenGuardado(): string | null {
  if (token) return token;
  try {
    token = sessionStorage.getItem(CLAVE_TOKEN);
  } catch {
    token = null; // almacenamiento bloqueado: se trabaja solo en memoria
  }
  return token;
}

export function guardarToken(nuevo: string | null) {
  token = nuevo;
  try {
    if (nuevo) sessionStorage.setItem(CLAVE_TOKEN, nuevo);
    else sessionStorage.removeItem(CLAVE_TOKEN);
  } catch {
    // Sin almacenamiento la sesión dura lo que dure la página. No es motivo para fallar.
  }
}

/** Lo invoca el proveedor de sesión para llevar al login cuando el backend responde 401. */
export function registrarCierreDeSesion(callback: () => void) {
  alPerderSesion = callback;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function mensajeDeError(response: Response, porDefecto: string): Promise<string> {
  const detalle = await response
    .clone()
    .json()
    .then((j: { message?: string }) => j.message)
    .catch(() => null);
  return detalle ?? porDefecto;
}

/**
 * `fetch` con el token de sesión.
 *
 * Un 401 vacía la sesión y avisa al proveedor: si el token caducó a media tarde, el usuario ve la
 * pantalla de entrada en vez de una tabla que falla sin explicación.
 */
export async function apiFetch(ruta: string, opciones: RequestInit = {}): Promise<Response> {
  const actual = cargarTokenGuardado();
  const cabeceras = new Headers(opciones.headers);
  if (actual) cabeceras.set('Authorization', `Bearer ${actual}`);

  const response = await fetch(`${API_URL}${ruta}`, { ...opciones, headers: cabeceras });

  if (response.status === 401) {
    guardarToken(null);
    alPerderSesion?.();
    throw new ApiError(await mensajeDeError(response, 'Sesión no válida'), 401);
  }

  return response;
}

/** Igual que `apiFetch` pero devolviendo JSON y con el error ya formateado. */
export async function apiJson<T>(ruta: string, descripcion: string, opciones?: RequestInit): Promise<T> {
  const response = await apiFetch(ruta, opciones);

  if (!response.ok) {
    throw new ApiError(
      await mensajeDeError(response, `No se pudo ${descripcion} (HTTP ${response.status})`),
      response.status,
    );
  }

  return response.json() as Promise<T>;
}

/**
 * Descarga un archivo protegido y devuelve una URL de blob.
 *
 * Un `<a href>` normal no puede llevar la cabecera `Authorization`, así que con las rutas ya
 * protegidas cualquier enlace directo devolvería 401. Quien llame debe liberar la URL con
 * `URL.revokeObjectURL` cuando termine.
 */
export async function descargarComoBlobUrl(ruta: string): Promise<string> {
  const response = await apiFetch(ruta);

  if (!response.ok) {
    throw new ApiError(
      await mensajeDeError(response, `No se pudo obtener el archivo (HTTP ${response.status})`),
      response.status,
    );
  }

  return URL.createObjectURL(await response.blob());
}
