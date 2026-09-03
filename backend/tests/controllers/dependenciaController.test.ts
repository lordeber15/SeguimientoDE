import type { Request, Response } from 'express';

jest.mock('../../src/models', () => ({
  Dependencia: { findAll: jest.fn() },
  Empleado: {},
  sequelize: { query: jest.fn() },
}));

import { Dependencia, sequelize } from '../../src/models';
import { getAllDependencias } from '../../src/controllers/dependenciaController';

const mockFindAll = Dependencia.findAll as jest.Mock;
const mockQuery = sequelize.query as jest.Mock;

function fakeInstance(data: Record<string, unknown>) {
  return { toJSON: () => data };
}

function fakeResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as unknown as Response;
}

// Responde según a qué función de dominio apunta el SQL, devolviendo una descripción
// derivada del código para poder aseverar sobre qué códigos se enviaron (bind[0]).
function mockQueryPorDominio() {
  mockQuery.mockImplementation((sql: string, options: { bind: [string[]] }) => {
    const codigos = options.bind[0];
    const prefijo = sql.includes('pk_sgd_descripcion_de_dominios') ? 'TipoEnc' : 'Cargo';
    return Promise.resolve(codigos.map((codigo) => ({ codigo, descripcion: `${prefijo}-${codigo}` })));
  });
}

describe('getAllDependencias', () => {
  it('mapea jefe, tipoEncargaturaDescripcion y cargoDescripcion correctamente', async () => {
    mockQueryPorDominio();
    mockFindAll.mockResolvedValue([
      fakeInstance({
        coDependencia: '01',
        deDependencia: 'Gerencia General',
        coTipoEncargatura: '1',
        coCargo: 'C01',
        jefe: { cempCodemp: 'E01', cempApepat: 'Perez', cempApemat: 'Lopez', cempDenom: 'Juan' },
        padre: null,
      }),
    ]);

    const res = fakeResponse();
    await getAllDependencias({} as Request, res);

    expect(res.json).toHaveBeenCalledWith([
      expect.objectContaining({
        coDependencia: '01',
        jefe: expect.objectContaining({ nombreCompleto: 'Perez Lopez Juan' }),
        tipoEncargaturaDescripcion: 'TipoEnc-1',
        cargoDescripcion: 'Cargo-C01',
      }),
    ]);
  });

  it('deja jefe en null cuando la dependencia no tiene jefe asignado', async () => {
    mockQueryPorDominio();
    mockFindAll.mockResolvedValue([
      fakeInstance({
        coDependencia: '02',
        deDependencia: 'Sin jefe',
        coTipoEncargatura: null,
        coCargo: null,
        jefe: null,
        padre: { coDependencia: '01', deDependencia: 'Gerencia General' },
      }),
    ]);

    const res = fakeResponse();
    await getAllDependencias({} as Request, res);

    const [data] = (res.json as jest.Mock).mock.calls[0];
    expect(data[0].jefe).toBeNull();
    expect(data[0].padre).toEqual({ coDependencia: '01', deDependencia: 'Gerencia General' });
  });

  it('omite apellidos/nombre vacíos al armar nombreCompleto', async () => {
    mockQueryPorDominio();
    mockFindAll.mockResolvedValue([
      fakeInstance({
        coDependencia: '03',
        coTipoEncargatura: null,
        coCargo: null,
        jefe: { cempCodemp: 'E02', cempApepat: 'Rios', cempApemat: null, cempDenom: null },
        padre: null,
      }),
    ]);

    const res = fakeResponse();
    await getAllDependencias({} as Request, res);

    const [data] = (res.json as jest.Mock).mock.calls[0];
    expect(data[0].jefe.nombreCompleto).toBe('Rios');
  });

  it('deduplica los códigos antes de resolverlos contra la BD', async () => {
    mockQueryPorDominio();
    mockFindAll.mockResolvedValue([
      fakeInstance({ coDependencia: '01', coTipoEncargatura: '1', coCargo: 'C01', jefe: null, padre: null }),
      fakeInstance({ coDependencia: '02', coTipoEncargatura: '1', coCargo: 'C01', jefe: null, padre: null }),
    ]);

    const res = fakeResponse();
    await getAllDependencias({} as Request, res);

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const llamadaTipoEnc = mockQuery.mock.calls.find(([sql]) => sql.includes('pk_sgd_descripcion_de_dominios'));
    const llamadaCargo = mockQuery.mock.calls.find(([sql]) => sql.includes('pk_sgd_descripcion_de_cargo'));

    expect(llamadaTipoEnc?.[1].bind[0]).toEqual(['1']);
    expect(llamadaCargo?.[1].bind[0]).toEqual(['C01']);
  });

  it('no consulta la BD para resolver dominios cuando todos los códigos son null', async () => {
    mockFindAll.mockResolvedValue([
      fakeInstance({ coDependencia: '01', coTipoEncargatura: null, coCargo: null, jefe: null, padre: null }),
    ]);

    const res = fakeResponse();
    await getAllDependencias({} as Request, res);

    expect(mockQuery).not.toHaveBeenCalled();
    const [data] = (res.json as jest.Mock).mock.calls[0];
    expect(data[0].tipoEncargaturaDescripcion).toBeNull();
    expect(data[0].cargoDescripcion).toBeNull();
  });

  it('consulta con where inBaja=0 y orden por deDependencia', async () => {
    mockFindAll.mockResolvedValue([]);

    const res = fakeResponse();
    await getAllDependencias({} as Request, res);

    expect(mockFindAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { inBaja: '0' },
        order: [['deDependencia', 'ASC']],
      }),
    );
  });

  it('responde 500 cuando falla la consulta a la BD', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFindAll.mockRejectedValue(new Error('conexión perdida'));

    const res = fakeResponse();
    await getAllDependencias({} as Request, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Error al obtener dependencias' });

    consoleError.mockRestore();
  });
});
