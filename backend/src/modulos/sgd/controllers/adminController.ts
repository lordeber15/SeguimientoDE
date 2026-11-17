import type { Request, Response } from 'express';
import {
  AdminError,
  asignarRoles,
  cambiarHabilitado,
  listarAccesos,
  listarRoles,
  listarUsuarios,
} from '../services/adminService';

function manejar(res: Response, error: unknown, contexto: string) {
  if (error instanceof AdminError) {
    return res.status(error.status).json({ message: error.message });
  }
  console.error(`${contexto}:`, error);
  return res.status(500).json({ message: 'Error al procesar la operación' });
}

export async function getUsuarios(_req: Request, res: Response) {
  try {
    res.json(await listarUsuarios());
  } catch (error) {
    manejar(res, error, 'Error al listar usuarios');
  }
}

export async function getRoles(_req: Request, res: Response) {
  try {
    res.json(await listarRoles());
  } catch (error) {
    manejar(res, error, 'Error al listar roles');
  }
}

export async function putRolesUsuario(req: Request, res: Response) {
  const { codUser } = req.params;
  const roles = req.body?.roles;

  if (!Array.isArray(roles) || roles.some((r) => typeof r !== 'string')) {
    return res.status(400).json({ message: 'Se espera "roles" como lista de códigos' });
  }

  try {
    await asignarRoles(codUser, roles, req.usuario!.codUser);
    res.json({ ok: true });
  } catch (error) {
    manejar(res, error, `Error al asignar roles a ${codUser}`);
  }
}

export async function putHabilitado(req: Request, res: Response) {
  const { codUser } = req.params;
  const habilitado = req.body?.habilitado;

  if (typeof habilitado !== 'boolean') {
    return res.status(400).json({ message: 'Se espera "habilitado" booleano' });
  }

  try {
    await cambiarHabilitado(codUser, habilitado, req.usuario!.codUser);
    res.json({ ok: true });
  } catch (error) {
    manejar(res, error, `Error al cambiar el acceso de ${codUser}`);
  }
}

export async function getAccesos(req: Request, res: Response) {
  const limite = Number(req.query.limite ?? 100);

  try {
    res.json(await listarAccesos(Number.isFinite(limite) ? limite : 100));
  } catch (error) {
    manejar(res, error, 'Error al listar accesos');
  }
}
