/**
 * `calidadProcesosController.ts` — validación de parámetros, mismo criterio de aislamiento que
 * `dashboardController.test.ts`: se mockea el servicio, se prueba solo el controlador.
 */
const listarProcesos = jest.fn();
const flujoProceso = jest.fn();
const propuestaMejora = jest.fn();
const renombrarProceso = jest.fn();

jest.mock('../../src/services/calidadProcesosService', () => ({
  listarProcesos: (...args: unknown[]) => listarProcesos(...args),
  flujoProceso: (...args: unknown[]) => flujoProceso(...args),
  propuestaMejora: (...args: unknown[]) => propuestaMejora(...args),
  renombrarProceso: (...args: unknown[]) => renombrarProceso(...args),
}));

import type { Request, Response } from 'express';
import {
  getFlujo,
  getProcesos,
  getPropuesta,
  putNombreProceso,
} from '../../src/controllers/calidadProcesosController';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

const CLAVE = 'abc0000000000001';

beforeEach(() => {
  listarProcesos.mockReset();
  flujoProceso.mockReset();
  propuestaMejora.mockReset();
  renombrarProceso.mockReset();
});

describe('getProcesos — filtro', () => {
  it('soloCerrados es true por defecto', async () => {
    listarProcesos.mockResolvedValue([]);
    const req = { query: {} } as unknown as Request;
    await getProcesos(req, mockRes());
    expect(listarProcesos).toHaveBeenCalledWith(expect.objectContaining({ soloCerrados: true }));
  });

  it("soloCerrados pasa a false solo con el string 'false' explícito", async () => {
    listarProcesos.mockResolvedValue([]);
    const req = { query: { soloCerrados: 'false' } } as unknown as Request;
    await getProcesos(req, mockRes());
    expect(listarProcesos).toHaveBeenCalledWith(expect.objectContaining({ soloCerrados: false }));
  });

  it('rechaza una fecha con formato inválido', async () => {
    const req = { query: { desde: '01-01-2026' } } as unknown as Request;
    const res = mockRes();
    await getProcesos(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(listarProcesos).not.toHaveBeenCalled();
  });

  it('rechaza un rango invertido y uno mayor a 366 días, igual que el dashboard', async () => {
    const res1 = mockRes();
    await getProcesos({ query: { desde: '2026-06-01', hasta: '2026-01-01' } } as unknown as Request, res1);
    expect(res1.status).toHaveBeenCalledWith(400);

    const res2 = mockRes();
    await getProcesos({ query: { desde: '2025-01-01', hasta: '2026-06-01' } } as unknown as Request, res2);
    expect(res2.status).toHaveBeenCalledWith(400);
  });

  it('acepta un rango con un solo extremo, sin exigir el otro', async () => {
    listarProcesos.mockResolvedValue([]);
    const req = { query: { desde: '2026-01-01' } } as unknown as Request;
    const res = mockRes();
    await getProcesos(req, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(listarProcesos).toHaveBeenCalledWith(
      expect.objectContaining({ desde: '2026-01-01', hasta: undefined }),
    );
  });

  it('rellena el código de dependencia con ceros a la izquierda', async () => {
    listarProcesos.mockResolvedValue([]);
    const req = { query: { coDependencia: '12' } } as unknown as Request;
    await getProcesos(req, mockRes());
    expect(listarProcesos).toHaveBeenCalledWith(expect.objectContaining({ coDependencia: '00012' }));
  });

  it('500 si el servicio lanza', async () => {
    listarProcesos.mockRejectedValue(new Error('boom'));
    const res = mockRes();
    await getProcesos({ query: {} } as unknown as Request, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('getFlujo / getPropuesta — clave de proceso', () => {
  it('rechaza una clave que no tiene forma de hash', async () => {
    const res = mockRes();
    await getFlujo({ params: { clave: 'no-es-un-hash' }, query: {} } as unknown as Request, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(flujoProceso).not.toHaveBeenCalled();
  });

  it('404 si el servicio no encuentra expedientes con esos filtros', async () => {
    flujoProceso.mockResolvedValue(null);
    const res = mockRes();
    await getFlujo({ params: { clave: CLAVE }, query: {} } as unknown as Request, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('getFlujo delega en el servicio con la clave y el filtro parseado', async () => {
    flujoProceso.mockResolvedValue({ clave: CLAVE });
    const res = mockRes();
    await getFlujo({ params: { clave: CLAVE }, query: { coDependencia: '9' } } as unknown as Request, res);
    expect(flujoProceso).toHaveBeenCalledWith(CLAVE, expect.objectContaining({ coDependencia: '00009' }));
    expect(res.json).toHaveBeenCalledWith({ clave: CLAVE });
  });

  it('getPropuesta delega en el servicio y responde 404 si no hay datos', async () => {
    propuestaMejora.mockResolvedValue(null);
    const res = mockRes();
    await getPropuesta({ params: { clave: CLAVE }, query: {} } as unknown as Request, res);
    expect(propuestaMejora).toHaveBeenCalledWith(CLAVE, expect.any(Object));
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('putNombreProceso', () => {
  it('rechaza un nombre vacío', async () => {
    const req = { params: { clave: CLAVE }, body: { nombre: '   ' } } as unknown as Request;
    const res = mockRes();
    await putNombreProceso(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(renombrarProceso).not.toHaveBeenCalled();
  });

  it('rechaza un nombre demasiado largo', async () => {
    const req = {
      params: { clave: CLAVE },
      body: { nombre: 'x'.repeat(121) },
    } as unknown as Request;
    const res = mockRes();
    await putNombreProceso(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('llama al servicio con el actor de la sesión y responde ok', async () => {
    renombrarProceso.mockResolvedValue(undefined);
    const req = {
      params: { clave: CLAVE },
      body: { nombre: 'Pago de consultores' },
      usuario: { codUser: '08365245' },
    } as unknown as Request;
    const res = mockRes();
    await putNombreProceso(req, res);
    expect(renombrarProceso).toHaveBeenCalledWith(CLAVE, 'Pago de consultores', '08365245');
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});
