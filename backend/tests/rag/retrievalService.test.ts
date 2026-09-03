/**
 * `retrievalService.ts`, aislado con mocks para la lógica de control (qué rama se consulta, el
 * filtro de permisos, el guardarraíl exacto/HNSW, la fusión RRF) — igual que el resto de `rag/*
 * .test.ts` de este proyecto: el SQL crudo se verificó aparte contra la BD real (ver
 * docs/PLAN-RAG-IMPLEMENTACION.md, sección de Fase 5), mockearlo aquí solo daría cobertura falsa.
 */

const modeloActivo = jest.fn();
const tablaVectores = jest.fn();
const crearEmbeddingProvider = jest.fn();
const query = jest.fn();
const getDocumentosExpediente = jest.fn();

jest.mock('../../src/rag/embeddingModelService', () => ({
  modeloActivo: (...a: unknown[]) => modeloActivo(...a),
  tablaVectores: (...a: unknown[]) => tablaVectores(...a),
}));

jest.mock('../../src/ai/providerFactory', () => ({
  crearEmbeddingProvider: (...a: unknown[]) => crearEmbeddingProvider(...a),
}));

jest.mock('../../src/services/documentoService', () => ({
  getDocumentosExpediente: (...a: unknown[]) => getDocumentosExpediente(...a),
}));

jest.mock('../../src/config/appDatabase', () => ({
  appSequelize: {
    query: (...a: unknown[]) => query(...a),
    transaction: (cb: (tx: unknown) => Promise<unknown>) => cb({}),
  },
}));

type RetrievalSvc = typeof import('../../src/rag/retrievalService');
let retrieval: RetrievalSvc;

beforeAll(() => {
  jest.isolateModules(() => {
    retrieval = require('../../src/rag/retrievalService');
  });
});

interface FilaMock { chunk_id: number }

function instalarRamas(opts: { vec?: FilaMock[]; fts?: FilaMock[]; detalles?: Record<number, object> }) {
  const detalles = opts.detalles ?? {};
  query.mockReset().mockImplementation((sql: string) => {
    if (sql.includes('rag.embedding_')) return Promise.resolve(opts.vec ?? []);
    if (sql.includes('plainto_tsquery')) return Promise.resolve(opts.fts ?? []);
    if (sql.includes('FROM rag.chunk WHERE id = ANY')) {
      const idsPedidos = new Set([...(opts.vec ?? []), ...(opts.fts ?? [])].map((f) => f.chunk_id));
      const filas = [...idsPedidos]
        .filter((id) => detalles[id])
        .map((id) => ({ chunk_id: id, ...detalles[id] }));
      return Promise.resolve(filas);
    }
    return Promise.resolve(undefined); // SET LOCAL, etc.
  });
}

beforeEach(() => {
  modeloActivo.mockReset().mockResolvedValue(null);
  tablaVectores.mockReset().mockReturnValue('embedding_1024');
  crearEmbeddingProvider.mockReset();
  getDocumentosExpediente.mockReset();
  query.mockReset();
});

describe('buscarHibrido — sin modelo activo', () => {
  it('omite la rama vectorial por completo: FTS puro, funciona hoy sin ninguna clave', async () => {
    instalarRamas({ fts: [{ chunk_id: 1 }], detalles: { 1: { texto: 't', ruta_titulos: null, ord: 0, sha256: 's1' } } });

    const r = await retrieval.buscarHibrido('consulta', { coDependencia: null });

    expect(r.candidatosVec).toBe(0);
    expect(crearEmbeddingProvider).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes('rag.embedding_'))).toBe(false);
  });
});

describe('buscarHibrido — filtro de permisos (el más importante del diseño)', () => {
  it('pasa la misma coDependencia como bind[0] en la rama FTS', async () => {
    instalarRamas({ fts: [] });
    await retrieval.buscarHibrido('consulta', { coDependencia: '00104' });

    const llamadaFts = query.mock.calls.find(([sql]) => String(sql).includes('plainto_tsquery'));
    expect(llamadaFts?.[1]?.bind?.[0]).toBe('00104');
  });

  it('con coDependencia=null (admin/jefe), el filtro no restringe (bind NULL)', async () => {
    instalarRamas({ fts: [] });
    await retrieval.buscarHibrido('consulta', { coDependencia: null });

    const llamadaFts = query.mock.calls.find(([sql]) => String(sql).includes('plainto_tsquery'));
    expect(llamadaFts?.[1]?.bind?.[0]).toBeNull();
  });
});

describe('buscarHibrido — fusión RRF', () => {
  it('un chunk presente en ambas ramas supera a uno que solo aparece en una, aunque ese sea rank 1 allí', async () => {
    modeloActivo.mockResolvedValue({ id: 7, proveedor: 'ollama', modelo: 'bge-m3', dimension: 1024, activo: true, backfillPct: 0 });
    crearEmbeddingProvider.mockReturnValue({
      dimension: 1024,
      embeber: jest.fn().mockResolvedValue({ vectores: [[0.1, 0.2]], uso: { tokensIn: 1, tokensOut: 0, estimado: true } }),
    });

    instalarRamas({
      fts: [{ chunk_id: 10 }],
      vec: [{ chunk_id: 20 }, { chunk_id: 10 }], // 20 es rank1 en vec; 10 es rank1 en fts Y rank2 en vec
      detalles: {
        10: { texto: 'aparece en ambas ramas', ruta_titulos: null, ord: 0, sha256: 'sha-10' },
        20: { texto: 'solo en vectorial', ruta_titulos: null, ord: 0, sha256: 'sha-20' },
      },
    });

    const r = await retrieval.buscarHibrido('consulta', { coDependencia: null });

    expect(r.chunks.map((c) => c.chunkId)).toEqual([10, 20]);
  });
});

describe('buscarHibrido — guardarraíl exacto/HNSW', () => {
  it('con pocos candidatos, fuerza escaneo exacto', async () => {
    instalarRamas({ fts: [{ chunk_id: 1 }] });
    const r = await retrieval.buscarHibrido('consulta', { coDependencia: null });

    expect(r.escaneoExacto).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql === 'SET LOCAL enable_indexscan = off')).toBe(true);
  });

  it('con muchos candidatos, usa el modo relajado de HNSW en vez de forzar exacto', async () => {
    const muchos = Array.from({ length: 2001 }, (_, i) => ({ chunk_id: i }));
    instalarRamas({ fts: muchos });
    const r = await retrieval.buscarHibrido('consulta', { coDependencia: null });

    expect(r.escaneoExacto).toBe(false);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("hnsw.iterative_scan = 'relaxed_order'")),
    ).toBe(true);
  });
});

describe('elegirDocumentoParaCita', () => {
  it('nunca resuelve solo por chunk_id: siempre consulta rag.documento con el filtro de permisos, y trae nu_ann/nu_emi/nu_ane', async () => {
    query.mockReset().mockResolvedValue([{ id: 501, nu_ann: '2026', nu_emi: '0000000123', nu_ane: 0 }]);

    const doc = await retrieval.elegirDocumentoParaCita('sha-x', { coDependencia: '00104' }, { nuAnnExp: '2026', nuSecExp: '0000000001' });

    expect(doc).toEqual({ id: 501, nuAnn: '2026', nuEmi: '0000000123', nuAne: 0 });
    const [sql, opts] = query.mock.calls[0];
    expect(String(sql)).toMatch(/FROM rag\.documento/);
    expect(opts.bind).toEqual(['sha-x', '00104', '2026', '0000000001']);
  });

  it('si ningún documento accesible comparte ese contenido, devuelve null (el chunk queda invisible)', async () => {
    query.mockReset().mockResolvedValue([]);
    const doc = await retrieval.elegirDocumentoParaCita('sha-x', { coDependencia: '00104' });
    expect(doc).toBeNull();
  });
});

describe('estadoExpediente', () => {
  it('reusa getDocumentosExpediente (la misma cronología del PDF unificado) en vez de reimplementarla', async () => {
    getDocumentosExpediente.mockResolvedValue([
      {
        nuAnn: '2026', nuEmi: '1', numeroExpediente: 'X', coTipDoc: null, tipoDocumento: 'INFORME',
        numeroDocumento: '5', titulo: 't', asunto: 'un asunto', fechaEmision: '01/01/2026',
        dependenciaEmisora: 'OGA', dependenciaDestino: 'UL', estado: 'Atendido',
        tieneArchivo: true, numAnexos: 0,
      },
    ]);

    const timeline = await retrieval.estadoExpediente('2026', '0000000001');

    expect(getDocumentosExpediente).toHaveBeenCalledWith('2026', '0000000001');
    expect(timeline).toEqual([
      {
        fecha: '01/01/2026', tipoDocumento: 'INFORME', numeroDocumento: '5', asunto: 'un asunto',
        dependenciaEmisora: 'OGA', dependenciaDestino: 'UL', estado: 'Atendido',
      },
    ]);
  });
});

describe('buscarExpedientes', () => {
  it('escapa los comodines de LIKE y los envía como bind, nunca interpolados en el SQL', async () => {
    query.mockResolvedValue([]);

    await retrieval.buscarExpedientes('DE%_2026', null);

    const [sql, opts] = query.mock.calls[0];
    expect(String(sql)).not.toContain('DE%_2026');
    expect(opts.bind[0]).toBe('DE\\%\\_2026');
  });

  it('sin par (no matchea año-secuencia), bindea nuAnnExp/nuSecExp como null', async () => {
    query.mockResolvedValue([]);

    await retrieval.buscarExpedientes('DE000020260000062', null);

    const [, opts] = query.mock.calls[0];
    expect(opts.bind[1]).toBeNull();
    expect(opts.bind[2]).toBeNull();
  });

  it('con un par literal, lo bindea junto al término para el acceso directo por clave exacta', async () => {
    query.mockResolvedValue([]);

    await retrieval.buscarExpedientes('2026-325', { nuAnnExp: '2026', nuSecExp: '0000000325' });

    const [, opts] = query.mock.calls[0];
    expect(opts.bind).toEqual(['2026-325', '2026', '0000000325', 20]);
  });

  it('el acceso directo por clave exacta solo alcanza expedientes sin numero_sgd todavía — si no, ' +
    'un "año-secuencia" tecleado a mano puede coincidir con la clave interna de OTRO expediente ya ' +
    'indexado y traerlo de regalo, aunque su número visible no tenga nada que ver', async () => {
    query.mockResolvedValue([]);

    await retrieval.buscarExpedientes('2026-325', { nuAnnExp: '2026', nuSecExp: '0000000325' });

    const [sql] = query.mock.calls[0];
    expect(String(sql)).toContain('nu_ann_exp = $2 AND nu_sec_exp = $3 AND numero_sgd IS NULL');
  });

  it('mapea las columnas de rag.expediente y convierte los contadores a number', async () => {
    query.mockResolvedValue([
      { nuAnnExp: '2026', nuSecExp: '0000000062', numeroExpediente: 'DE000020260000062', documentos: '12', ingestados: '5' },
    ]);

    const r = await retrieval.buscarExpedientes('DE000020260000062', null);

    expect(r).toEqual([
      { nuAnnExp: '2026', nuSecExp: '0000000062', numeroExpediente: 'DE000020260000062', documentos: 12, ingestados: 5 },
    ]);
  });
});

describe('recortarPorPresupuesto', () => {
  it('se detiene cuando el siguiente chunk excedería el presupuesto, pero nunca deja el resultado vacío', () => {
    const chunk = (texto: string) => ({ chunkId: 1, texto, rutaTitulos: null, ord: 0, sha256: 's', score: 1 });
    const largo = 'x'.repeat(3500); // ~1000 tokens a 3.5 chars/token

    const resultado = retrieval.recortarPorPresupuesto([chunk(largo), chunk(largo), chunk(largo)], 1500);
    expect(resultado.length).toBe(1);

    // Aunque el primer chunk YA exceda el presupuesto él solo, se conserva: un chat sin ningún
    // fragmento es peor que uno con uno solo, más largo de lo ideal.
    const soloUno = retrieval.recortarPorPresupuesto([chunk(largo)], 10);
    expect(soloUno.length).toBe(1);
  });
});
