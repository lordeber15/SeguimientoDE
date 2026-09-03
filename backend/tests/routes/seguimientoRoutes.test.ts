import express from 'express';
import request from 'supertest';
import type { Request, Response } from 'express';

const mockGetUsuarios = jest.fn((_req: Request, res: Response) => res.status(200).json([{ mock: 'usuarios' }]));
const mockGetExpedientes = jest.fn((_req: Request, res: Response) => res.status(200).json({ mock: 'expedientes' }));
const mockGetBuscarExpediente = jest.fn((_req: Request, res: Response) => res.status(200).json([{ mock: 'busqueda' }]));

jest.mock('../../src/controllers/seguimientoController', () => ({
  getUsuarios: (req: Request, res: Response) => mockGetUsuarios(req, res),
  getExpedientes: (req: Request, res: Response) => mockGetExpedientes(req, res),
  getBuscarExpediente: (req: Request, res: Response) => mockGetBuscarExpediente(req, res),
}));

import seguimientoRoutes from '../../src/routes/seguimientoRoutes';

function app() {
  const instancia = express();
  instancia.use('/api/seguimiento', seguimientoRoutes);
  return instancia;
}

describe('seguimientoRoutes', () => {
  it('GET /usuarios/:coDependencia delega en getUsuarios con el parámetro de ruta', async () => {
    const res = await request(app()).get('/api/seguimiento/usuarios/00009');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ mock: 'usuarios' }]);
    expect(mockGetUsuarios.mock.calls[0][0].params).toEqual({ coDependencia: '00009' });
  });

  it('GET /expedientes delega en getExpedientes con los parámetros de consulta', async () => {
    const res = await request(app()).get('/api/seguimiento/expedientes?dependencia=00009&usuario=00003');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mock: 'expedientes' });
    expect(mockGetExpedientes.mock.calls[0][0].query).toEqual({ dependencia: '00009', usuario: '00003' });
  });

  it('GET /expedientes/buscar delega en getBuscarExpediente, no en getExpedientes', async () => {
    const res = await request(app()).get('/api/seguimiento/expedientes/buscar?q=OGAUL');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ mock: 'busqueda' }]);
    expect(mockGetBuscarExpediente.mock.calls[0][0].query).toEqual({ q: 'OGAUL' });
    expect(mockGetExpedientes).not.toHaveBeenCalled();
  });
});
