import request from 'supertest';
import type { Express } from 'express';

// app.ts lee CORS_ORIGIN de process.env al momento de importarse, así que cada test
// necesita su propio módulo fresco (jest.resetModules) tras fijar la variable de entorno.
function cargarApp(): Express {
  let mod: { default: Express };
  jest.isolateModules(() => {
    mod = require('../src/app');
  });
  return mod!.default;
}

describe('app', () => {
  const originalCorsOrigin = process.env.CORS_ORIGIN;

  afterEach(() => {
    if (originalCorsOrigin === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = originalCorsOrigin;
  });

  it('GET /health responde ok', async () => {
    delete process.env.CORS_ORIGIN;
    const app = cargarApp();

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('sin CORS_ORIGIN configurado, permite cualquier origen', async () => {
    delete process.env.CORS_ORIGIN;
    const app = cargarApp();

    const res = await request(app).get('/health').set('Origin', 'http://cualquier-origen.test');

    expect(res.headers['access-control-allow-origin']).toBe('http://cualquier-origen.test');
  });

  it('con CORS_ORIGIN configurado, solo permite los orígenes listados', async () => {
    process.env.CORS_ORIGIN = 'http://permitido.test, http://tambien-permitido.test';
    const app = cargarApp();

    const permitido = await request(app).get('/health').set('Origin', 'http://permitido.test');
    expect(permitido.headers['access-control-allow-origin']).toBe('http://permitido.test');

    const noPermitido = await request(app).get('/health').set('Origin', 'http://no-permitido.test');
    expect(noPermitido.headers['access-control-allow-origin']).toBeUndefined();
  });
});
