import { apiJson } from './cliente';

export interface UsuarioAdmin {
  codUser: string;
  nombre: string | null;
  nuDni: string | null;
  coDependencia: string | null;
  deDependencia: string | null;
  habilitado: boolean;
  feUltimoAcceso: string | null;
  roles: string[];
  estadoSgd: string | null;
  existeEnSgd: boolean;
}

export interface Rol {
  codigo: string;
  nombre: string;
  descripcion: string | null;
  delSistema: boolean;
  permisos: string[];
  usuarios: number;
}

export interface Acceso {
  codUser: string;
  ip: string | null;
  exito: boolean;
  motivo: string | null;
  feIntento: string;
}

export function fetchUsuariosAdmin(): Promise<UsuarioAdmin[]> {
  return apiJson('/api/admin/usuarios', 'obtener la lista de usuarios');
}

export function fetchRoles(): Promise<Rol[]> {
  return apiJson('/api/admin/roles', 'obtener los roles');
}

export function guardarRoles(codUser: string, roles: string[]): Promise<{ ok: true }> {
  return apiJson(`/api/admin/usuarios/${encodeURIComponent(codUser)}/roles`, 'guardar los roles', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roles }),
  });
}

export function cambiarHabilitado(codUser: string, habilitado: boolean): Promise<{ ok: true }> {
  return apiJson(
    `/api/admin/usuarios/${encodeURIComponent(codUser)}/habilitado`,
    'cambiar el acceso del usuario',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ habilitado }),
    },
  );
}

export function fetchAccesos(limite = 100): Promise<Acceso[]> {
  return apiJson(`/api/admin/accesos?limite=${limite}`, 'obtener el registro de accesos');
}
