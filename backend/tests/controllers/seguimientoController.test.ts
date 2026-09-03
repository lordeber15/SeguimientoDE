import type { Request, Response } from 'express';

jest.mock('../../src/services/seguimientoService', () => ({
  getUsuariosPorDependencia: jest.fn(),
  getExpedientesPorUsuario: jest.fn(),
}));

import { getExpedientesPorUsuario, getUsuariosPorDependencia } from '../../src/services/seguimientoService';
import { getExpedientes, getUsuarios } from '../../src/controllers/seguimientoController';

const mockUsuarios = getUsuariosPorDependencia as jest.Mock;
const mockExpedientes = getExpedientesPorUsuario as jest.Mock;

function fakeResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as unknown as Response;
}

describe('getUsuarios', () => {
  it('normaliza el código de dependencia a 5 dígitos antes de consultar', async () => {
    mockUsuarios.mockResolvedValue([]);
    const res = fakeResponse();

    await getUsuarios({ params: { coDependencia: '9' } } as unknown as Request, res);

    expect(mockUsuarios).toHaveBeenCalledWith('00009');
    expect(res.json).toHaveBeenCalledWith([]);
  });

  it('devuelve 400 si el código no es numérico', async () => {
    const res = fakeResponse();

    await getUsuarios({ params: { coDependencia: 'abc' } } as unknown as Request, res);

    expect(mockUsuarios).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('devuelve 500 y no filtra el detalle del error si la consulta falla', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsuarios.mockRejectedValue(new Error('column "x" does not exist'));
    const res = fakeResponse();

    await getUsuarios({ params: { coDependencia: '00009' } } as unknown as Request, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Error al obtener los usuarios de la dependencia' });
  });
});

describe('getExpedientes', () => {
  it('pasa dependencia y usuario normalizados y envuelve el resultado con el total', async () => {
    const items = [{ nuAnnExp: '2026', nuSecExp: '0000000383' }];
    mockExpedientes.mockResolvedValue(items);
    const res = fakeResponse();

    await getExpedientes({ query: { dependencia: '9', usuario: '3' } } as unknown as Request, res);

    expect(mockExpedientes).toHaveBeenCalledWith('00009', '00003');
    expect(res.json).toHaveBeenCalledWith({ total: 1, items });
  });

  it.each([
    ['sin usuario', { dependencia: '00009' }],
    ['sin dependencia', { usuario: '00003' }],
    ['con código inválido', { dependencia: '00009', usuario: "1' OR '1'='1" }],
  ])('devuelve 400 %s', async (_caso, query) => {
    const res = fakeResponse();

    await getExpedientes({ query } as unknown as Request, res);

    expect(mockExpedientes).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
