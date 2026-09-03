import { apiJson, API_URL, ApiError, guardarToken } from './cliente';

export interface UsuarioSesion {
  codUser: string;
  nombre: string;
  nuDni: string | null;
  coDependencia: string | null;
  deDependencia: string | null;
  roles: string[];
  permisos: string[];
}

/**
 * El login es la única llamada sin token, así que no pasa por `apiFetch`: su manejo del 401
 * —vaciar sesión y redirigir— es justo lo contrario de lo que hace falta aquí, donde un 401
 * significa "credenciales incorrectas" y hay que mostrarlo en el formulario.
 */
export async function login(usuario: string, clave: string): Promise<UsuarioSesion> {
  const response = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, clave }),
  });

  const cuerpo = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(
      cuerpo?.message ?? `No se pudo iniciar sesión (HTTP ${response.status})`,
      response.status,
    );
  }

  guardarToken(cuerpo.token);
  return cuerpo.usuario;
}

export function fetchSesion(): Promise<{ usuario: UsuarioSesion }> {
  return apiJson('/api/auth/sesion', 'validar la sesión');
}

export function tienePermiso(usuario: UsuarioSesion | null, permiso: string): boolean {
  return Boolean(usuario?.permisos.includes(permiso));
}
