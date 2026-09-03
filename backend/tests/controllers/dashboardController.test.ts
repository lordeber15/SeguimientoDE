import type { Request, Response } from 'express';

jest.mock('../../src/services/dashboardService', () => ({
  desempenoPorOficina: jest.fn(),
  desempenoPorEmpleado: jest.fn(),
  pendientesAntiguosPorOficina: jest.fn(),
  tiposDocumento: jest.fn(),
}));
jest.mock('../../src/services/dashboardResumenService', () => ({
  estadoResumen: jest.fn(),
  refrescarResumen: jest.fn(),
  RefrescoOcupado: class RefrescoOcupado extends Error {},
}));
jest.mock('../../src/services/dashboardPesosService', () => ({
  listarPesos: jest.fn(),
  actualizarPeso: jest.fn(),
}));

import {
  getEmpleados,
  getOficinas,
  getPendientesOficinas,
  getPesosTipoDocumento,
  getResumenEstado,
  getTiposDocumento,
  postResumenRefrescar,
  putPesoTipoDocumento,
} from '../../src/controllers/dashboardController';
import { actualizarPeso, listarPesos } from '../../src/services/dashboardPesosService';
import {
  desempenoPorEmpleado,
  desempenoPorOficina,
  pendientesAntiguosPorOficina,
  tiposDocumento,
} from '../../src/services/dashboardService';
import { estadoResumen, refrescarResumen, RefrescoOcupado } from '../../src/services/dashboardResumenService';

const mockOficinas = desempenoPorOficina as jest.Mock;
const mockEmpleados = desempenoPorEmpleado as jest.Mock;
const mockPendientes = pendientesAntiguosPorOficina as jest.Mock;
const mockEstado = estadoResumen as jest.Mock;
const mockRefrescar = refrescarResumen as jest.Mock;
const mockTipos = tiposDocumento as jest.Mock;
const mockListarPesos = listarPesos as jest.Mock;
const mockActualizarPeso = actualizarPeso as jest.Mock;

function fakeResponse() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
}

function fakeRequest(query: Record<string, unknown>) {
  return { query } as unknown as Request;
}

/**
 * Los dos endpoints comparten `parsearFiltro`, así que toda la validación se prueba contra ambos:
 * si alguien la duplicara y arreglara solo uno, estos casos lo delatan.
 */
const HANDLERS = [
  ['getOficinas', getOficinas, mockOficinas] as const,
  ['getEmpleados', getEmpleados, mockEmpleados] as const,
];

describe.each(HANDLERS)('%s — validación del filtro', (_nombre, handler, mockServicio) => {
  beforeEach(() => jest.clearAllMocks());

  it('sin desde/hasta (Fase 9), consulta sin filtro de fecha en vez de devolver 400', async () => {
    mockServicio.mockResolvedValue([]);
    const res = fakeResponse();
    await handler(fakeRequest({}), res);

    expect(mockServicio).toHaveBeenCalledWith(expect.objectContaining({ desde: undefined, hasta: undefined }));
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  it('solo con "desde" (Fase 9), consulta con el rango abierto hacia adelante', async () => {
    mockServicio.mockResolvedValue([]);
    const res = fakeResponse();
    await handler(fakeRequest({ desde: '2026-01-01' }), res);

    expect(mockServicio).toHaveBeenCalledWith(expect.objectContaining({ desde: '2026-01-01', hasta: undefined }));
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  it('solo con "hasta" (Fase 9), consulta con el rango abierto hacia atrás', async () => {
    mockServicio.mockResolvedValue([]);
    const res = fakeResponse();
    await handler(fakeRequest({ hasta: '2026-01-31' }), res);

    expect(mockServicio).toHaveBeenCalledWith(expect.objectContaining({ desde: undefined, hasta: '2026-01-31' }));
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  it.each([
    ['formato con barras', { desde: '2026/01/01', hasta: '2026-01-31' }],
    ['formato con hora', { desde: '2026-01-01T00:00', hasta: '2026-01-31' }],
    ['año de 2 dígitos', { desde: '26-01-01', hasta: '2026-01-31' }],
  ])('con %s, devuelve 400 en vez de un rango mal interpretado', async (_caso, query) => {
    const res = fakeResponse();
    await handler(fakeRequest(query), res);

    expect(mockServicio).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('con "desde" de formato inválido y sin "hasta" (Fase 9), igual devuelve 400', async () => {
    const res = fakeResponse();
    await handler(fakeRequest({ desde: '2026/01/01' }), res);

    expect(mockServicio).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('con "desde" posterior a "hasta", devuelve 400', async () => {
    const res = fakeResponse();
    await handler(fakeRequest({ desde: '2026-02-01', hasta: '2026-01-01' }), res);

    expect(mockServicio).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('con un rango mayor a 366 días, devuelve 400 — evita un rango explícito mal puesto por error', async () => {
    const res = fakeResponse();
    await handler(fakeRequest({ desde: '2020-01-01', hasta: '2026-01-01' }), res);

    expect(mockServicio).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('solo con "desde", un rango de varios años NO devuelve 400 (Fase 9: el tope de 366 días solo aplica con ambos extremos)', async () => {
    mockServicio.mockResolvedValue([]);
    const res = fakeResponse();
    await handler(fakeRequest({ desde: '2020-01-01' }), res);

    expect(mockServicio).toHaveBeenCalledWith(expect.objectContaining({ desde: '2020-01-01', hasta: undefined }));
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  it('normaliza coDependencia a 5 dígitos, igual que seguimientoController', async () => {
    mockServicio.mockResolvedValue([]);
    const res = fakeResponse();

    await handler(fakeRequest({ desde: '2026-01-01', hasta: '2026-01-31', coDependencia: '9' }), res);

    expect(mockServicio).toHaveBeenCalledWith(expect.objectContaining({ coDependencia: '00009' }));
  });

  it('con coDependencia de formato inválido, devuelve 400', async () => {
    const res = fakeResponse();
    await handler(fakeRequest({ desde: '2026-01-01', hasta: '2026-01-31', coDependencia: 'abc' }), res);

    expect(mockServicio).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('cada endpoint consulta SOLO su propia agregación', () => {
  beforeEach(() => jest.clearAllMocks());

  it('getOficinas devuelve el arreglo de oficinas y no toca la agregación de empleados', async () => {
    mockOficinas.mockResolvedValue([{ coDependencia: '00009' }]);
    const res = fakeResponse();

    await getOficinas(fakeRequest({ desde: '2026-01-01', hasta: '2026-01-31' }), res);

    expect(mockOficinas).toHaveBeenCalledWith({
      desde: '2026-01-01', hasta: '2026-01-31',
      coDependencia: undefined, tipoDocumento: undefined,
    });
    expect(mockEmpleados).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith([{ coDependencia: '00009' }]);
  });

  it('getEmpleados devuelve el arreglo de empleados y no toca la agregación de oficinas', async () => {
    mockEmpleados.mockResolvedValue([{ coEmpleado: '00123' }]);
    const res = fakeResponse();

    await getEmpleados(fakeRequest({ desde: '2026-01-01', hasta: '2026-01-31' }), res);

    expect(mockEmpleados).toHaveBeenCalledWith({
      desde: '2026-01-01', hasta: '2026-01-31',
      coDependencia: undefined, tipoDocumento: undefined,
    });
    expect(mockOficinas).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith([{ coEmpleado: '00123' }]);
  });
});

describe('getTiposDocumento', () => {
  it('devuelve el catálogo tal cual lo entrega el servicio', async () => {
    mockTipos.mockResolvedValue([{ codigo: '232', descripcion: 'PROVEÍDO' }]);
    const res = fakeResponse();

    await getTiposDocumento({} as Request, res);

    expect(res.json).toHaveBeenCalledWith([{ codigo: '232', descripcion: 'PROVEÍDO' }]);
  });
});

describe('getPendientesOficinas — carga laboral (Fase 2), sin exigir desde/hasta', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sin ningún filtro, consulta igual — no hay rango obligatorio como en los otros endpoints', async () => {
    mockPendientes.mockResolvedValue([]);
    const res = fakeResponse();

    await getPendientesOficinas(fakeRequest({}), res);

    expect(mockPendientes).toHaveBeenCalledWith({ coDependencia: undefined, tipoDocumento: undefined });
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  it('normaliza coDependencia a 5 dígitos, igual que los otros endpoints', async () => {
    mockPendientes.mockResolvedValue([]);
    const res = fakeResponse();

    await getPendientesOficinas(fakeRequest({ coDependencia: '9' }), res);

    expect(mockPendientes).toHaveBeenCalledWith(expect.objectContaining({ coDependencia: '00009' }));
  });

  it('con coDependencia de formato inválido, devuelve 400 y no consulta', async () => {
    const res = fakeResponse();

    await getPendientesOficinas(fakeRequest({ coDependencia: 'abc' }), res);

    expect(mockPendientes).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('devuelve el arreglo tal cual lo entrega el servicio', async () => {
    mockPendientes.mockResolvedValue([{ coDependencia: '00003', pendientes: 90 }]);
    const res = fakeResponse();

    await getPendientesOficinas(fakeRequest({}), res);

    expect(res.json).toHaveBeenCalledWith([{ coDependencia: '00003', pendientes: 90 }]);
  });
});

describe('getResumenEstado', () => {
  beforeEach(() => jest.clearAllMocks());

  it('devuelve el estado tal cual lo entrega el servicio', async () => {
    mockEstado.mockResolvedValue({ ultimoRefresco: '2026-08-28', minutosDesde: 5, participaciones: 46000, ultimoError: null });
    const res = fakeResponse();

    await getResumenEstado({} as Request, res);

    expect(res.json).toHaveBeenCalledWith({ ultimoRefresco: '2026-08-28', minutosDesde: 5, participaciones: 46000, ultimoError: null });
  });
});

describe('postResumenRefrescar', () => {
  beforeEach(() => jest.clearAllMocks());

  it('devuelve el resultado del refresco', async () => {
    mockRefrescar.mockResolvedValue({ id: 1, participaciones: 46000, emisiones: 42000, msSgd: 8000, msTotal: 8500 });
    const res = fakeResponse();

    await postResumenRefrescar({} as Request, res);

    expect(mockRefrescar).toHaveBeenCalledWith('manual');
    expect(res.json).toHaveBeenCalledWith({ id: 1, participaciones: 46000, emisiones: 42000, msSgd: 8000, msTotal: 8500 });
  });

  it('si ya hay un refresco en curso, devuelve 409 en vez de un 500 genérico', async () => {
    mockRefrescar.mockRejectedValue(new RefrescoOcupado());
    const res = fakeResponse();

    await postResumenRefrescar({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(409);
  });
});

describe('getPesosTipoDocumento', () => {
  beforeEach(() => jest.clearAllMocks());

  it('devuelve el catálogo tal cual lo entrega el servicio', async () => {
    const catalogo = [{
      coTipDoc: '232', descripcion: 'PROVEÍDO', peso: 1.5, pesoSugerido: 1.42,
      muestraAtendidos: 40, medianaHoras: 2, actualizadoPor: '08365245', feActualizado: '2026-08-01',
    }];
    mockListarPesos.mockResolvedValue(catalogo);
    const res = fakeResponse();

    await getPesosTipoDocumento({} as Request, res);

    expect(res.json).toHaveBeenCalledWith(catalogo);
  });
});

describe('putPesoTipoDocumento', () => {
  beforeEach(() => jest.clearAllMocks());

  function fakeRequestPeso(coTipDoc: string, body: unknown) {
    return { params: { coTipDoc }, body, usuario: { codUser: '08365245' } } as unknown as Request;
  }

  it('con un peso válido, lo guarda con el actor de la sesión y responde ok', async () => {
    mockActualizarPeso.mockResolvedValue(undefined);
    const res = fakeResponse();

    await putPesoTipoDocumento(fakeRequestPeso('232', { peso: 1.8 }), res);

    expect(mockActualizarPeso).toHaveBeenCalledWith('232', 1.8, '08365245');
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it.each([0, -1, 10.01, Number.NaN, 'x', undefined, null])('rechaza un peso inválido (%p) sin llamar al servicio', async (peso) => {
    const res = fakeResponse();

    await putPesoTipoDocumento(fakeRequestPeso('232', { peso }), res);

    expect(mockActualizarPeso).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('acepta el límite superior (10) e inferior (justo mayor que 0)', async () => {
    mockActualizarPeso.mockResolvedValue(undefined);
    const res = fakeResponse();

    await putPesoTipoDocumento(fakeRequestPeso('232', { peso: 10 }), res);

    expect(res.status).not.toHaveBeenCalled();
    expect(mockActualizarPeso).toHaveBeenCalledWith('232', 10, '08365245');
  });
});
