/**
 * `dashboardPesosService.ts` (Fase 3) — el catálogo de pesos y su sugerencia salen del espejo
 * local (`dashboard.participacion`, vía `appSequelize`); la descripción de cada tipo de documento
 * se completa con una consulta liviana al SGD (`sequelize`), igual que `dashboardService.tiposDocumento`.
 */
jest.mock('../../src/config/appDatabase', () => ({
  appSequelize: { query: jest.fn() },
}));
jest.mock('../../src/config/database', () => ({
  DB_SCHEMA: 'idosgd',
  sequelize: { query: jest.fn() },
}));

import { appSequelize } from '../../src/config/appDatabase';
import { sequelize } from '../../src/config/database';
import { actualizarPeso, listarPesos } from '../../src/services/dashboardPesosService';

const mockAppQuery = appSequelize.query as jest.Mock;
const mockSgdQuery = sequelize.query as jest.Mock;

beforeEach(() => {
  mockAppQuery.mockReset();
  mockSgdQuery.mockReset().mockResolvedValue([]);
});

describe('listarPesos — sugerencia por percentil sobre el espejo, descripción desde el SGD', () => {
  it('bindea la muestra mínima (5) en la CTE de percentil', async () => {
    mockAppQuery.mockResolvedValue([]);

    await listarPesos();

    expect(mockAppQuery).toHaveBeenCalledTimes(1);
    const [sql, opts] = mockAppQuery.mock.calls[0];
    expect(opts.bind).toEqual([5]);
    expect(String(sql)).toContain('PERCENT_RANK() OVER (ORDER BY mediana_segundos)');
    expect(String(sql)).toContain('WHERE muestra >= $1');
    expect(String(sql)).toContain('LEFT JOIN dashboard.tipo_documento_peso w ON w.co_tip_doc = u.co_tip_doc');
  });

  it('combina el peso del espejo con la descripción del catálogo SGD, por código', async () => {
    mockAppQuery.mockResolvedValue([{
      coTipDoc: '232', muestraAtendidos: '40', medianaSegundos: 7200,
      pesoSugerido: 1.42, peso: '1.5', actualizadoPor: '08365245', feActualizado: '2026-08-01T00:00:00Z',
    }]);
    mockSgdQuery.mockResolvedValue([{ codigo: '232', descripcion: 'PROVEÍDO' }]);

    const [fila] = await listarPesos();

    expect(fila).toEqual({
      coTipDoc: '232', descripcion: 'PROVEÍDO',
      peso: 1.5, pesoSugerido: 1.42, muestraAtendidos: 40, medianaHoras: 2,
      actualizadoPor: '08365245', feActualizado: '2026-08-01T00:00:00Z',
    });
  });

  it('un tipo sin fila en el catálogo del SGD queda con descripcion null, no falla', async () => {
    mockAppQuery.mockResolvedValue([{
      coTipDoc: '999', muestraAtendidos: '0', medianaSegundos: null,
      pesoSugerido: null, peso: '1', actualizadoPor: null, feActualizado: null,
    }]);
    mockSgdQuery.mockResolvedValue([]);

    const [fila] = await listarPesos();

    expect(fila.descripcion).toBeNull();
    expect(fila.pesoSugerido).toBeNull();
    expect(fila.medianaHoras).toBeNull();
    expect(fila.peso).toBe(1);
  });

  it('redondea pesoSugerido y medianaHoras a 2 decimales', async () => {
    mockAppQuery.mockResolvedValue([{
      coTipDoc: '232', muestraAtendidos: '12', medianaSegundos: 12345,
      pesoSugerido: 1.666666, peso: '1', actualizadoPor: null, feActualizado: null,
    }]);

    const [fila] = await listarPesos();

    expect(fila.pesoSugerido).toBe(1.67);
    expect(fila.medianaHoras).toBe(3.43); // 12345 / 3600 = 3.4291...
  });
});

describe('actualizarPeso — upsert + rastro en app.auditoria', () => {
  it('inserta/actualiza dashboard.tipo_documento_peso con el actor y deja auditoría', async () => {
    mockAppQuery.mockResolvedValue([]);

    await actualizarPeso('232', 1.8, '08365245');

    expect(mockAppQuery).toHaveBeenCalledTimes(2);

    const [sqlUpsert, optsUpsert] = mockAppQuery.mock.calls[0];
    expect(String(sqlUpsert)).toContain('INSERT INTO dashboard.tipo_documento_peso');
    expect(String(sqlUpsert)).toContain('ON CONFLICT (co_tip_doc) DO UPDATE');
    expect(optsUpsert.bind).toEqual(['232', 1.8, '08365245']);

    const [sqlAuditoria, optsAuditoria] = mockAppQuery.mock.calls[1];
    expect(String(sqlAuditoria)).toContain('app.auditoria');
    expect(String(sqlAuditoria)).toContain('dashboard.peso.cambiar');
    expect(optsAuditoria.bind[0]).toBe('08365245');
    expect(JSON.parse(optsAuditoria.bind[1])).toEqual({ coTipDoc: '232', peso: 1.8 });
  });
});
