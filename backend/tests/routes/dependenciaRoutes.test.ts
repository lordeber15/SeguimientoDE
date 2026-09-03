import express from 'express';
import request from 'supertest';
import type { Request, Response } from 'express';

const mockGetAllDependencias = jest.fn((_req: Request, res: Response) => res.status(200).json([{ mock: true }]));

jest.mock('../../src/controllers/dependenciaController', () => ({
  getAllDependencias: (req: Request, res: Response) => mockGetAllDependencias(req, res),
}));

import dependenciaRoutes from '../../src/routes/dependenciaRoutes';

describe('dependenciaRoutes', () => {
  it('GET / delega en el controlador getAllDependencias', async () => {
    const app = express();
    app.use('/api/dependencias', dependenciaRoutes);

    const res = await request(app).get('/api/dependencias');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ mock: true }]);
    expect(mockGetAllDependencias).toHaveBeenCalledTimes(1);
  });
});
