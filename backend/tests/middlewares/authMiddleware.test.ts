import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';

const estadoActual = jest.fn();
jest.mock('../../src/services/authService', () => ({
  estadoActual: (...a: unknown[]) => estadoActual(...a),
}));

type Middleware = typeof import('../../src/middlewares/authMiddleware');

let mw: Middleware;
const SECRETO = 'secreto-de-pruebas-suficientemente-largo';

const USUARIO = {
  codUser: '08365245',
  cempCodemp: '00003',
  nombre: 'USUARIO DE PRUEBA',
  nuDni: '08365245',
  coDependencia: '00009',
  deDependencia: 'OGA-UL',
  roles: ['admin'],
  permisos: ['seguimiento.ver', 'usuarios.gestionar'],
};

function respuestaFalsa() {
  const res = {
    codigo: 0,
    cuerpo: null as unknown,
    status(c: number) {
      this.codigo = c;
      return this;
    },
    json(b: unknown) {
      this.cuerpo = b;
      return this;
    },
  };
  return res as unknown as Response & { codigo: number; cuerpo: any };
}

beforeAll(() => {
  process.env.JWT_SECRET = SECRETO;
  jest.isolateModules(() => {
    mw = require('../../src/middlewares/authMiddleware');
  });
});

beforeEach(() => estadoActual.mockReset());

describe('requiereAuth', () => {
  it('rechaza sin cabecera Authorization', async () => {
    const res = respuestaFalsa();
    const next = jest.fn();
    await mw.requiereAuth({ headers: {} } as Request, res, next as NextFunction);

    expect(res.codigo).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rechaza un token firmado con otra clave', async () => {
    const ajeno = jwt.sign({ sub: '08365245', roles: ['admin'] }, 'otra-clave-distinta');
    const res = respuestaFalsa();
    const next = jest.fn();

    await mw.requiereAuth(
      { headers: { authorization: `Bearer ${ajeno}` } } as Request,
      res,
      next as NextFunction,
    );

    expect(res.codigo).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(estadoActual).not.toHaveBeenCalled(); // ni siquiera se consulta la BD
  });

  it('rechaza un token caducado indicándolo', async () => {
    const caducado = jwt.sign({ sub: '08365245' }, SECRETO, { expiresIn: '-1s' });
    const res = respuestaFalsa();

    await mw.requiereAuth(
      { headers: { authorization: `Bearer ${caducado}` } } as Request,
      res,
      jest.fn() as NextFunction,
    );

    expect(res.codigo).toBe(401);
    expect(res.cuerpo.expirado).toBe(true);
  });

  /**
   * El punto crítico del diseño: si el servidor se fiara de los roles del JWT, retirarle el rol
   * a alguien no surtiría efecto hasta que su token caducara.
   */
  it('usa los roles de la BD, no los del token', async () => {
    const token = mw.firmarToken(USUARIO);
    estadoActual.mockResolvedValue({ roles: ['consulta'], permisos: ['seguimiento.ver'], habilitado: true });

    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const next = jest.fn();
    await mw.requiereAuth(req, respuestaFalsa(), next as NextFunction);

    expect(next).toHaveBeenCalled();
    expect(req.usuario!.roles).toEqual(['consulta']);
    expect(req.usuario!.permisos).toEqual(['seguimiento.ver']);
  });

  it('rechaza a un usuario deshabilitado aunque su token sea válido', async () => {
    const token = mw.firmarToken(USUARIO);
    estadoActual.mockResolvedValue({ roles: ['admin'], permisos: [], habilitado: false });

    const res = respuestaFalsa();
    const next = jest.fn();
    await mw.requiereAuth(
      { headers: { authorization: `Bearer ${token}` } } as Request,
      res,
      next as NextFunction,
    );

    expect(res.codigo).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('rechaza si el usuario ya no existe en la BD', async () => {
    const token = mw.firmarToken(USUARIO);
    estadoActual.mockResolvedValue(null);

    const res = respuestaFalsa();
    await mw.requiereAuth(
      { headers: { authorization: `Bearer ${token}` } } as Request,
      res,
      jest.fn() as NextFunction,
    );

    expect(res.codigo).toBe(401);
  });
});

describe('requierePermiso / requiereRol', () => {
  const req = (permisos: string[], roles: string[] = []) =>
    ({ usuario: { ...USUARIO, permisos, roles } }) as Request;

  it('deja pasar con el permiso y corta sin él', () => {
    const next = jest.fn();
    mw.requierePermiso('usuarios.gestionar')(req(['usuarios.gestionar']), respuestaFalsa(), next);
    expect(next).toHaveBeenCalled();

    const res = respuestaFalsa();
    mw.requierePermiso('usuarios.gestionar')(req(['seguimiento.ver']), res, jest.fn());
    expect(res.codigo).toBe(403);
  });

  it('sin sesión responde 401, no 403', () => {
    const res = respuestaFalsa();
    mw.requierePermiso('x')({} as Request, res, jest.fn());
    expect(res.codigo).toBe(401);
  });

  it('requiereRol acepta cualquiera de los roles indicados', () => {
    const next = jest.fn();
    mw.requiereRol('admin', 'jefe')(req([], ['jefe']), respuestaFalsa(), next);
    expect(next).toHaveBeenCalled();

    const res = respuestaFalsa();
    mw.requiereRol('admin')(req([], ['consulta']), res, jest.fn());
    expect(res.codigo).toBe(403);
  });
});
