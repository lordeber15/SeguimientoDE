import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { estadoActual, type UsuarioAutenticado } from '../services/authService';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      usuario?: UsuarioAutenticado;
    }
  }
}

interface Claims {
  sub: string;
  nombre: string;
  dni: string | null;
  dep: string | null;
  depNombre: string | null;
  codemp: string | null;
  /** Solo para que el frontend pinte u oculte botones. El servidor no se fía de esto. */
  roles: string[];
}

export function firmarToken(usuario: UsuarioAutenticado): string {
  const secreto = process.env.JWT_SECRET;
  if (!secreto) throw new Error('JWT_SECRET no está configurado');

  const claims: Claims = {
    sub: usuario.codUser,
    nombre: usuario.nombre,
    dni: usuario.nuDni,
    dep: usuario.coDependencia,
    depNombre: usuario.deDependencia,
    codemp: usuario.cempCodemp,
    roles: usuario.roles,
  };

  return jwt.sign(claims, secreto, {
    algorithm: 'HS256',
    expiresIn: process.env.JWT_EXPIRACION ?? '8h',
  } as jwt.SignOptions);
}

/**
 * Verifica el token y **vuelve a leer los roles de la BD** en cada petición.
 *
 * Es el punto importante: el JWT lleva los roles solo para que el frontend decida qué mostrar. Si
 * el servidor se fiara del claim, retirar el rol de administrador a alguien no tendría efecto
 * hasta que caducara su token — ocho horas de acceso indebido.
 */
export async function requiereAuth(req: Request, res: Response, next: NextFunction) {
  const cabecera = req.headers.authorization ?? '';
  const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7).trim() : '';

  if (!token) {
    return res.status(401).json({ message: 'Falta el token de sesión' });
  }

  let claims: Claims;
  try {
    claims = jwt.verify(token, process.env.JWT_SECRET ?? '', {
      algorithms: ['HS256'],
    }) as unknown as Claims;
  } catch (error) {
    const expirado = error instanceof jwt.TokenExpiredError;
    return res.status(401).json({
      message: expirado ? 'La sesión ha caducado. Vuelva a entrar.' : 'Sesión inválida',
      expirado,
    });
  }

  try {
    const estado = await estadoActual(claims.sub);

    if (!estado) {
      return res.status(401).json({ message: 'El usuario ya no existe en el sistema' });
    }
    if (!estado.habilitado) {
      return res.status(403).json({ message: 'Su acceso a esta aplicación está deshabilitado.' });
    }

    req.usuario = {
      codUser: claims.sub,
      cempCodemp: claims.codemp,
      nombre: claims.nombre,
      nuDni: claims.dni,
      coDependencia: claims.dep,
      deDependencia: claims.depNombre,
      roles: estado.roles,
      permisos: estado.permisos,
    };

    next();
  } catch (error) {
    console.error('Error al validar la sesión:', error);
    res.status(500).json({ message: 'Error al validar la sesión' });
  }
}

/** Exige un permiso concreto, no un rol: así cambiar qué puede hacer un rol no toca las rutas. */
export function requierePermiso(permiso: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.usuario) {
      return res.status(401).json({ message: 'Falta el token de sesión' });
    }
    if (!req.usuario.permisos.includes(permiso)) {
      return res.status(403).json({ message: 'No tiene permiso para esta operación' });
    }
    next();
  };
}

export function requiereRol(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.usuario) {
      return res.status(401).json({ message: 'Falta el token de sesión' });
    }
    if (!roles.some((rol) => req.usuario!.roles.includes(rol))) {
      return res.status(403).json({ message: 'No tiene permiso para esta operación' });
    }
    next();
  };
}
