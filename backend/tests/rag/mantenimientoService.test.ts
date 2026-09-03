/**
 * `mantenimientoService.ts` aislado con mocks — el mismo criterio que el resto de `rag/*.test.ts`:
 * lo que importa aislar aquí es la lógica de control (qué se borra, con qué corte, qué se
 * registra), no reimplementar en un mock el SQL crudo. La invariante más importante del diseño
 * (§6.6: el recolector NUNCA borra `rag.contenido`, solo `rag.chunk`) sí se verifica aquí porque
 * romperla en silencio borraría markdown irreproducible sin que ningún test lo note.
 */

const leerNumero = jest.fn();
const query = jest.fn();

jest.mock('../../src/rag/configService', () => ({
  leerNumero: (...a: unknown[]) => leerNumero(...a),
  leerBooleano: jest.fn(),
}));

jest.mock('../../src/config/appDatabase', () => ({
  appSequelize: { query: (...a: unknown[]) => query(...a) },
}));

type Mantenimiento = typeof import('../../src/rag/mantenimientoService');
let mantenimiento: Mantenimiento;

beforeAll(() => {
  jest.isolateModules(() => {
    mantenimiento = require('../../src/rag/mantenimientoService');
  });
});

beforeEach(() => {
  leerNumero.mockReset().mockResolvedValue(180);
  query.mockReset();
});

describe('ejecutarRetencion', () => {
  it('purga las tres tablas con el corte configurado y lo registra en rag.mantenimiento', async () => {
    leerNumero.mockResolvedValue(180);
    query.mockImplementation((sql: string) => {
      if (sql.includes('DELETE FROM app.login_intento')) return Promise.resolve([{ id: 1 }, { id: 2 }]);
      if (sql.includes('DELETE FROM rag.uso_token')) return Promise.resolve([{ id: 1 }]);
      if (sql.includes('DELETE FROM rag.retrieval_log')) return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    const r = await mantenimiento.ejecutarRetencion();

    expect(r).toEqual({ loginIntento: 2, usoToken: 1, retrievalLog: 0 });

    const llamadaLogin = query.mock.calls.find(([sql]) => String(sql).includes('app.login_intento'));
    expect(llamadaLogin?.[1]?.bind).toEqual([180]);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO rag.mantenimiento'))).toBe(true);
  });

  it('si una purga falla, registra el error en rag.mantenimiento y relanza en vez de tragárselo', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('DELETE FROM app.login_intento')) return Promise.reject(new Error('la BD se cayó'));
      return Promise.resolve(undefined);
    });

    await expect(mantenimiento.ejecutarRetencion()).rejects.toThrow('la BD se cayó');

    const registro = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO rag.mantenimiento'));
    expect(registro?.[1]?.bind).toContain('la BD se cayó');
  });
});

describe('ejecutarGC', () => {
  it('marca huérfanos nuevos, desmarca los vueltos a referenciar, y solo recolecta los que superaron el margen de gracia', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('SET fe_huerfano = now()')) return Promise.resolve([{ sha256: 'a' }, { sha256: 'b' }]);
      if (sql.includes('SET fe_huerfano = NULL')) return Promise.resolve(undefined);
      if (sql.includes('fe_huerfano IS NOT NULL AND fe_huerfano <')) return Promise.resolve([{ sha256: 'x' }]);
      if (sql.includes('DELETE FROM rag.chunk')) return Promise.resolve([{ id: 1 }, { id: 2 }, { id: 3 }]);
      return Promise.resolve(undefined);
    });

    const r = await mantenimiento.ejecutarGC();

    expect(r).toEqual({ marcados: 2, recolectados: 1, chunksBorrados: 3 });
  });

  it('nunca borra rag.contenido — solo rag.chunk (el markdown se conserva siempre, D1)', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('fe_huerfano IS NOT NULL AND fe_huerfano <')) return Promise.resolve([{ sha256: 'x' }, { sha256: 'y' }]);
      if (sql.includes('DELETE FROM rag.chunk')) return Promise.resolve([{ id: 1 }]);
      return Promise.resolve([]);
    });

    await mantenimiento.ejecutarGC();

    expect(query.mock.calls.some(([sql]) => /DELETE\s+FROM\s+rag\.contenido/i.test(String(sql)))).toBe(false);
    // Sí debe resetear el contador para que la ingesta sepa reconstruir si hace falta.
    expect(query.mock.calls.some(([sql]) => String(sql).includes('SET chunks_generados = 0'))).toBe(true);
  });

  it('si nada quedó huérfano, no borra nada y lo registra igual con filasAfectadas=0', async () => {
    query.mockResolvedValue([]);

    const r = await mantenimiento.ejecutarGC();

    expect(r).toEqual({ marcados: 0, recolectados: 0, chunksBorrados: 0 });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM rag.chunk'))).toBe(false);
  });
});
