import type { Request, Response } from 'express';

jest.mock('../../src/services/documentoService', () => ({
  getInteraccionesUsuario: jest.fn(),
  getInteraccionesExpediente: jest.fn(),
}));

import { getInteraccionesExpediente } from '../../src/services/documentoService';
import { getInteraccionesCompletas } from '../../src/controllers/documentoController';

const mockInteraccionesExpediente = getInteraccionesExpediente as jest.Mock;

function fakeResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as unknown as Response;
}

describe('getInteraccionesCompletas', () => {
  it('paddea la secuencia del expediente y envuelve el resultado con el total', async () => {
    const items = [{ nuAnn: '2026', nuEmi: '0000000383', recibidoPor: { coEmpleado: '00009' } }];
    mockInteraccionesExpediente.mockResolvedValue(items);
    const res = fakeResponse();

    await getInteraccionesCompletas(
      { params: { nuAnnExp: '2026', nuSecExp: '58' } } as unknown as Request,
      res,
    );

    expect(mockInteraccionesExpediente).toHaveBeenCalledWith('2026', '0000000058');
    expect(res.json).toHaveBeenCalledWith({ total: 1, items });
  });

  it.each([
    ['año inválido', { nuAnnExp: '26', nuSecExp: '58' }],
    ['secuencia inválida', { nuAnnExp: '2026', nuSecExp: 'abc' }],
  ])('devuelve 400 con %s', async (_caso, params) => {
    const res = fakeResponse();

    await getInteraccionesCompletas({ params } as unknown as Request, res);

    expect(mockInteraccionesExpediente).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('devuelve 500 y no filtra el detalle del error si la consulta falla', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockInteraccionesExpediente.mockRejectedValue(new Error('column "x" does not exist'));
    const res = fakeResponse();

    await getInteraccionesCompletas(
      { params: { nuAnnExp: '2026', nuSecExp: '0000000058' } } as unknown as Request,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Error al obtener el expediente completo' });
  });
});
