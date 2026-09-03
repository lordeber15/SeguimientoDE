import type { Request, Response } from 'express';
import { AuthError, login } from '../services/authService';
import { firmarToken } from '../middlewares/authMiddleware';

export async function postLogin(req: Request, res: Response) {
  const usuario = typeof req.body?.usuario === 'string' ? req.body.usuario.trim() : '';
  const clave = typeof req.body?.clave === 'string' ? req.body.clave : '';

  if (!usuario || !clave) {
    return res.status(400).json({ message: 'Indique usuario y contraseña' });
  }

  try {
    const autenticado = await login(usuario, clave, req.ip);
    res.json({
      token: firmarToken(autenticado),
      usuario: {
        codUser: autenticado.codUser,
        nombre: autenticado.nombre,
        nuDni: autenticado.nuDni,
        coDependencia: autenticado.coDependencia,
        deDependencia: autenticado.deDependencia,
        roles: autenticado.roles,
        permisos: autenticado.permisos,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status).json({ message: error.message });
    }
    console.error('Error en el login:', error);
    res.status(500).json({ message: 'Error al procesar el inicio de sesión' });
  }
}

/** Devuelve la sesión vigente. El middleware ya releyó roles y permisos de la BD. */
export function getSesion(req: Request, res: Response) {
  res.json({ usuario: req.usuario });
}
