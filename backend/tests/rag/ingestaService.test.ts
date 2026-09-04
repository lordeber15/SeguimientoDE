/**
 * Guardas de `iniciarJobEmbedding`, aisladas con mocks.
 *
 * El resto del pipeline de embeddings (particiones, inserción de vectores, transición de estados,
 * segunda pasada idempotente) se verificó con un proveedor simulado contra la BD real —
 * mockear aquí cientos de líneas de SQL crudo solo daría una falsa sensación de cobertura. Lo que
 * SÍ vale la pena aislar es la lógica de control que decide si el job arranca siquiera: son las
 * tres barreras que evitan mezclar espacios vectoriales o gastar tokens sin proveedor.
 */

const embeddingsDisponibles = jest.fn();
const modeloActivo = jest.fn();
const registrarSiNoExiste = jest.fn();
const query = jest.fn();
const transaction = jest.fn();

jest.mock('../../src/ai/providerFactory', () => ({
  embeddingsDisponibles: (...a: unknown[]) => embeddingsDisponibles(...a),
  crearEmbeddingProvider: () => ({ nombre: 'ollama', modelo: 'bge-m3', dimension: 1024 }),
}));

jest.mock('../../src/rag/embeddingModelService', () => ({
  modeloActivo: (...a: unknown[]) => modeloActivo(...a),
  registrarSiNoExiste: (...a: unknown[]) => registrarSiNoExiste(...a),
  tablaVectores: () => 'embedding_1024',
}));

jest.mock('../../src/config/appDatabase', () => ({
  appSequelize: {
    query: (...a: unknown[]) => query(...a),
    transaction: (...a: unknown[]) => transaction(...a),
  },
}));

const getDatosDocumentoGenerado = jest.fn();
const getArchivoDoc = jest.fn();
const getArchivoAnexo = jest.fn();

jest.mock('../../src/services/documentoService', () => ({
  getDatosDocumentoGenerado: (...a: unknown[]) => getDatosDocumentoGenerado(...a),
  getArchivoDoc: (...a: unknown[]) => getArchivoDoc(...a),
  getArchivoAnexo: (...a: unknown[]) => getArchivoAnexo(...a),
}));

const resolverDocumento = jest.fn();
const resolverAnexo = jest.fn();

jest.mock('../../src/services/storageService', () => ({
  ...jest.requireActual('../../src/services/storageService'),
  resolverDocumento: (...a: unknown[]) => resolverDocumento(...a),
  resolverAnexo: (...a: unknown[]) => resolverAnexo(...a),
}));

const estadoCircuito = jest.fn();
const convertirAMarkdown = jest.fn();

// Se conserva la clase real `ConversionError`: el código de producción hace `instanceof
// ConversionError` para decidir si un fallo es reintentable, y una versión mockeada de la clase
// rompería esas comprobaciones en silencio.
jest.mock('../../src/rag/mdConvertService', () => ({
  ...jest.requireActual('../../src/rag/mdConvertService'),
  convertirAMarkdown: (...a: unknown[]) => convertirAMarkdown(...a),
  estadoCircuito: (...a: unknown[]) => estadoCircuito(...a),
}));

// Mineru se mockea por lo mismo que markitdown, no por simetría gratuita: sin esto,
// `conversionProviderService` (real, sin mockear en este archivo) llamaría a la implementación
// REAL de mineru como respaldo — y este equipo de desarrollo tiene un MinerU de verdad
// escuchando en el puerto por defecto. Estas pruebas son de flujo de control de la ingesta
// (bloqueos, selección de jobs), no de la orquestación del fallback (eso vive entero en
// `conversionProviderService.test.ts`) — por eso el fallback se deja DESACTIVADO por defecto
// (`RAG_CONVERTER_FALLBACK=ninguno` en el beforeEach) y solo se enciende en la prueba que
// específicamente lo ejercita.
const estadoCircuitoMinerU = jest.fn();
const convertirAMarkdownMinerU = jest.fn();

jest.mock('../../src/rag/mineruConvertService', () => ({
  convertirAMarkdownMinerU: (...a: unknown[]) => convertirAMarkdownMinerU(...a),
  estadoCircuitoMinerU: (...a: unknown[]) => estadoCircuitoMinerU(...a),
}));

const documentoPorId = jest.fn();

jest.mock('../../src/rag/estadoService', () => ({
  documentoPorId: (...a: unknown[]) => documentoPorId(...a),
}));

// Documentos largos (conversionLargaService): se mockean ambos como una unidad — lo que se
// prueba aquí es que `convertirDocumento` ENRUTA correctamente según `paginas` (real vs. bloques),
// no el troceo en sí (eso vive en conversionLargaService.test.ts, con un PDF real).
const contarPaginas = jest.fn();
const convertirPorBloques = jest.fn();

jest.mock('../../src/services/pdfPaginasService', () => ({
  contarPaginas: (...a: unknown[]) => contarPaginas(...a),
}));

jest.mock('../../src/rag/conversionLargaService', () => ({
  convertirPorBloques: (...a: unknown[]) => convertirPorBloques(...a),
}));

type Ingesta = typeof import('../../src/rag/ingestaService');
let ingesta: Ingesta;
// `jest.isolateModules` da a `ingestaService.ts` su propio registro de módulos, así que la clase
// `ConversionError` que ve por dentro NO es la misma que devolvería un `jest.requireActual` suelto
// en este archivo — hay que capturarla del MISMO registro aislado para que `instanceof` funcione.
let ConversionErrorIsolado: typeof import('../../src/rag/mdConvertService').ConversionError;

function proveedor(over: Partial<{ nombre: 'ollama'; modelo: string; dimension: number }> = {}) {
  return {
    nombre: 'ollama' as const,
    modelo: 'bge-m3',
    dimension: 1024,
    embeber: jest.fn(),
    comprobar: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
}

beforeAll(() => {
  jest.isolateModules(() => {
    ingesta = require('../../src/rag/ingestaService');
    ConversionErrorIsolado = require('../../src/rag/mdConvertService').ConversionError;
  });
});

beforeEach(() => {
  embeddingsDisponibles.mockReset().mockReturnValue({ disponible: true, motivo: null });
  modeloActivo.mockReset();
  registrarSiNoExiste.mockReset().mockResolvedValue(undefined);
  query.mockReset();
  transaction.mockReset().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb({}));
  getDatosDocumentoGenerado.mockReset();
  getArchivoDoc.mockReset();
  getArchivoAnexo.mockReset();
  resolverDocumento.mockReset();
  resolverAnexo.mockReset();
  estadoCircuito.mockReset().mockReturnValue({ abierto: false, segundosRestantes: 0 });
  convertirAMarkdown.mockReset();
  estadoCircuitoMinerU.mockReset().mockReturnValue({ abierto: false, segundosRestantes: 0 });
  convertirAMarkdownMinerU.mockReset();
  documentoPorId.mockReset();
  process.env.RAG_CONVERTER_FALLBACK = 'ninguno';
  contarPaginas.mockReset().mockResolvedValue(null); // por defecto: "no es un PDF" ⇒ camino normal
  convertirPorBloques.mockReset();
});

describe('iniciarJobEmbedding — barreras antes de gastar un solo token', () => {
  it('rechaza si el proveedor no está configurado, sin llamar a la BD', async () => {
    embeddingsDisponibles.mockReturnValue({
      disponible: false,
      motivo: 'OPENAI_API_KEY: Necesaria para usar OpenAI',
    });

    await expect(ingesta.iniciarJobEmbedding({}, 'admin', proveedor())).rejects.toThrow(
      /OPENAI_API_KEY/,
    );
    expect(modeloActivo).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('rechaza si no hay ningún modelo activo', async () => {
    modeloActivo.mockResolvedValue(null);

    await expect(ingesta.iniciarJobEmbedding({}, 'admin', proveedor())).rejects.toThrow(
      /ningún modelo de embeddings activo/,
    );
  });

  /**
   * La barrera que evita el fallo más caro: mezclar vectores de dos espacios semánticos en la
   * misma búsqueda. Si el modelo activo no es exactamente el configurado, se rechaza en vez de
   * intentarlo — no hay término medio posible aquí.
   */
  it('rechaza si el modelo activo no coincide con el proveedor configurado', async () => {
    modeloActivo.mockResolvedValue({
      id: 1,
      proveedor: 'ollama',
      modelo: 'otro-modelo-distinto',
      dimension: 1024,
      activo: true,
      backfillPct: 0,
    });

    await expect(ingesta.iniciarJobEmbedding({}, 'admin', proveedor())).rejects.toThrow(
      /no coincide con el proveedor configurado/,
    );
  });

  it('llama a provider.comprobar() antes de tocar la cola: si Ollama no responde, se sabe ya', async () => {
    modeloActivo.mockResolvedValue({
      id: 1,
      proveedor: 'ollama',
      modelo: 'bge-m3',
      dimension: 1024,
      activo: true,
      backfillPct: 0,
    });
    const p = proveedor();
    p.comprobar.mockRejectedValue(new Error('ollama no responde'));

    await expect(ingesta.iniciarJobEmbedding({}, 'admin', p)).rejects.toThrow('ollama no responde');
    expect(p.comprobar).toHaveBeenCalled();
    // No debió llegar a consultar chunks pendientes ni crear el job.
    expect(query).not.toHaveBeenCalled();
  });

  it('rechaza si no hay chunks pendientes con el filtro dado', async () => {
    modeloActivo.mockResolvedValue({
      id: 1,
      proveedor: 'ollama',
      modelo: 'bge-m3',
      dimension: 1024,
      activo: true,
      backfillPct: 0,
    });
    query.mockResolvedValue([]); // idsChunksPendientes: nada que embeber

    await expect(ingesta.iniciarJobEmbedding({}, 'admin', proveedor())).rejects.toThrow(
      /No hay chunks pendientes/,
    );
  });
});

// ── Fixtures compartidos por las pruebas de reparación manual ───────────────

interface FilaDocFixture {
  id: number; nu_ann: string; nu_emi: string; nu_ane: number; titulo: string | null;
  numero_sgd: string | null; de_dep_emi: string | null; fe_emi: string | null;
  asunto: string | null; co_tip_doc: string | null; intentos: number;
}

function filaDocumento(over: Partial<FilaDocFixture> = {}): FilaDocFixture {
  return {
    id: 501,
    nu_ann: '2026',
    nu_emi: '0000000501',
    nu_ane: 0,
    titulo: 'PROVEIDO N° 000123-2026-OGA',
    numero_sgd: '2026-0000123',
    de_dep_emi: 'OGA',
    fe_emi: '2026-01-01',
    asunto: 'Asunto de prueba',
    co_tip_doc: '001',
    intentos: 0,
    ...over,
  };
}

function datosGenerados(coTipDoc: string | null) {
  return {
    coTipDoc,
    tipoDocumento: 'PROVEIDO',
    numeroDocumento: '000123-2026-OGA',
    numeroExpediente: '2026-0000123',
    asunto:
      'Se remite el expediente para la atención correspondiente conforme a lo solicitado por la '
      + 'unidad orgánica competente, adjuntando la documentación sustentatoria requerida para el '
      + 'trámite administrativo en curso, a fin de continuar con el procedimiento regular.',
    fechaEmision: '01/01/2026',
    diasAtencion: 5,
    dependenciaEmisora: 'OFICINA GENERAL DE ADMINISTRACION',
    empleadoEmisor: 'PEREZ GOMEZ JUAN',
    siglaInstitucion: 'ONPE',
    destinos: [
      {
        nuDes: 1, dependencia: 'UNIDAD DE LOGISTICA', persona: 'GARCIA LOPEZ ANA',
        tramite: 'ATENDER', prioridad: 'NORMAL', indicaciones: 'Proceder según corresponda',
      },
    ],
    referencias: [],
  };
}

function documentoRagFixture(over: Record<string, unknown> = {}) {
  return {
    id: 501, nuAnn: '2026', nuEmi: '0000000501', nuAne: 0, titulo: 'X', tipoDoc: 'PROVEIDO',
    asunto: null, nuAnnExp: '2026', nuSecExp: '0000000001', numeroExpediente: null,
    estado: 'sin_texto', motivoError: null, intentos: 3, chars: 50, chunksGenerados: 0,
    metodo: 'markitdown', estadoItem: null, motivoErrorItem: null,
    ...over,
  };
}

/**
 * Respuestas de `appSequelize.query` para el ciclo completo de `convertirDocumento`, indexadas por
 * el texto de la sentencia — más robusto que encadenar `mockResolvedValueOnce` en orden, porque no
 * depende de contar exactamente cuántas consultas dispara cada rama.
 */
function mockQueryGenerico(
  fila: FilaDocFixture,
  opciones: { bloqueado?: boolean; jobEnCola?: number } = {},
) {
  query.mockImplementation((sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) return Promise.resolve([{ ok: !opciones.bloqueado }]);
    if (sql.includes('SELECT i.job_id')) {
      return Promise.resolve(opciones.jobEnCola ? [{ job_id: opciones.jobEnCola }] : []);
    }
    if (sql.includes('FROM rag.documento d') && sql.includes('LEFT JOIN rag.expediente e')) {
      return Promise.resolve([fila]);
    }
    if (sql.includes('SELECT chunks_generados, markdown FROM rag.contenido')) {
      return Promise.resolve([]); // sin contenido previo con ese sha256
    }
    return Promise.resolve([]);
  });
}

function llamadasMarcarEstado() {
  return query.mock.calls.filter(([sql]: [string]) => sql.includes('SET estado = $2, motivo_error = $3'));
}

describe('convertirDocumento — decide sobre el tipo VIVO del SGD, no la copia local de co_tip_doc', () => {
  it('tipo local desactualizado pero el SGD dice que SÍ es generable: se autocorrige y genera', async () => {
    const fila = filaDocumento({ co_tip_doc: '001' });
    mockQueryGenerico(fila);
    getArchivoDoc.mockRejectedValue(new Error('Documento no encontrado en el almacenamiento'));
    getDatosDocumentoGenerado.mockResolvedValue(datosGenerados('232'));

    await ingesta.convertirDocumento(fila.id);

    const autocorreccion = query.mock.calls.find(([sql]: [string]) => sql.includes('SET co_tip_doc'));
    expect(autocorreccion).toBeDefined();
    expect((autocorreccion![1] as { bind: unknown[] }).bind).toEqual([fila.id, '232']);

    const marcaConvertido = query.mock.calls.find(([sql]: [string]) => sql.includes("estado = 'convertido'"));
    expect(marcaConvertido).toBeDefined();

    const marcaNoSoportado = llamadasMarcarEstado().find(
      ([, opts]: [string, { bind: unknown[] }]) => opts.bind[1] === 'no_soportado',
    );
    expect(marcaNoSoportado).toBeUndefined();
  });

  it('tipo local dice generable pero el SGD ya NO lo es: no genera ni autocorrige, queda sin archivo', async () => {
    const fila = filaDocumento({ co_tip_doc: '232' });
    mockQueryGenerico(fila);
    getArchivoDoc.mockRejectedValue(new Error('Documento no encontrado en el almacenamiento'));
    getDatosDocumentoGenerado.mockResolvedValue(datosGenerados('001'));

    await ingesta.convertirDocumento(fila.id);

    const autocorreccion = query.mock.calls.find(([sql]: [string]) => sql.includes('SET co_tip_doc'));
    expect(autocorreccion).toBeUndefined();

    const marcaNoSoportado = llamadasMarcarEstado().find(
      ([, opts]: [string, { bind: unknown[] }]) => opts.bind[1] === 'no_soportado',
    );
    expect(marcaNoSoportado).toBeDefined();

    const marcaConvertido = query.mock.calls.find(([sql]: [string]) => sql.includes("estado = 'convertido'"));
    expect(marcaConvertido).toBeUndefined();
  });

  it('getDatosDocumentoGenerado sin fila (remito inexistente): no genera texto degenerado', async () => {
    const fila = filaDocumento({ co_tip_doc: '232' });
    mockQueryGenerico(fila);
    getArchivoDoc.mockRejectedValue(new Error('Documento no encontrado en el almacenamiento'));
    getDatosDocumentoGenerado.mockResolvedValue(null);

    await ingesta.convertirDocumento(fila.id);

    const marcaNoSoportado = llamadasMarcarEstado().find(
      ([, opts]: [string, { bind: unknown[] }]) => opts.bind[1] === 'no_soportado',
    );
    expect(marcaNoSoportado).toBeDefined();
  });
});

describe('documentosPendientes / documentosReparables — qué documentos entra cada barrido', () => {
  it('la cola automática ya no filtra por co_tip_doc (era la causa raíz del bug)', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('FROM rag.documento WHERE')) return Promise.resolve([{ id: 1 }]);
      if (sql.includes('INSERT INTO rag.ingest_job')) return Promise.resolve([{ id: 99 }]);
      return Promise.resolve([]);
    });

    await ingesta.iniciarJobConversion({}, 'admin');

    const [selectSql] = query.mock.calls.find(([sql]: [string]) => sql.includes('FROM rag.documento WHERE'))!;
    expect(selectSql).not.toContain('co_tip_doc');
    expect(selectSql).toContain("estado = 'no_soportado'");
  });

  /** Desde que hay un conversor de respaldo (`conversionProviderService`), un `error` deja de ser
   *  "repetir el mismo pipeline fallaría igual": el que lo rechazó pudo no ser el único disponible.
   *  Antes esta prueba exigía justo lo contrario — ver el JSDoc de `documentosReparables`. */
  it('la reparación masiva selecciona no_soportado, sin_texto Y error', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('FROM rag.documento WHERE')) return Promise.resolve([{ id: 1 }]);
      if (sql.includes('INSERT INTO rag.ingest_job')) return Promise.resolve([{ id: 100 }]);
      return Promise.resolve([]);
    });

    await ingesta.iniciarJobReparacion({}, 'admin');

    const [selectSql] = query.mock.calls.find(([sql]: [string]) => sql.includes('FROM rag.documento WHERE'))!;
    expect(selectSql).toContain("estado IN ('no_soportado', 'sin_texto', 'error')");

    const insertJob = query.mock.calls.find(([sql]: [string]) => sql.includes('INSERT INTO rag.ingest_job'))!;
    expect(insertJob[0]).toContain("VALUES ('reparacion'");
  });

  it('la reparación masiva devuelve 404 cuando no hay nada recuperable', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('FROM rag.documento WHERE')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    await expect(ingesta.iniciarJobReparacion({}, 'admin')).rejects.toThrow(/No hay documentos recuperables/);
  });

  it('documentoIds acota la conversión a esos ids exactos, combinado con AND', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('FROM rag.documento WHERE')) return Promise.resolve([{ id: 42 }]);
      if (sql.includes('INSERT INTO rag.ingest_job')) return Promise.resolve([{ id: 101 }]);
      return Promise.resolve([]);
    });

    await ingesta.iniciarJobConversion({ documentoIds: [42, 43] }, 'admin');

    const llamada = query.mock.calls.find(([sql]: [string]) => sql.includes('FROM rag.documento WHERE'))!;
    const [selectSql, opciones] = llamada as [string, { bind: unknown[] }];
    expect(selectSql).toContain('id = ANY($1::bigint[])');
    expect(opciones.bind[0]).toEqual([42, 43]);
  });

  it('documentoIds acota la reparación a esos ids exactos', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('FROM rag.documento WHERE')) return Promise.resolve([{ id: 7 }]);
      if (sql.includes('INSERT INTO rag.ingest_job')) return Promise.resolve([{ id: 102 }]);
      return Promise.resolve([]);
    });

    await ingesta.iniciarJobReparacion({ documentoIds: [7] }, 'admin');

    const llamada = query.mock.calls.find(([sql]: [string]) => sql.includes('FROM rag.documento WHERE'))!;
    const [selectSql, opciones] = llamada as [string, { bind: unknown[] }];
    expect(selectSql).toContain('id = ANY($1::bigint[])');
    expect(opciones.bind[0]).toEqual([7]);
  });

  it('nuAnnExp/nuSecExp y documentoIds juntos producen ambas condiciones', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('FROM rag.documento WHERE')) return Promise.resolve([{ id: 9 }]);
      if (sql.includes('INSERT INTO rag.ingest_job')) return Promise.resolve([{ id: 103 }]);
      return Promise.resolve([]);
    });

    await ingesta.iniciarJobConversion(
      { nuAnnExp: '2026', nuSecExp: '0000000058', documentoIds: [9] },
      'admin',
    );

    const llamada = query.mock.calls.find(([sql]: [string]) => sql.includes('FROM rag.documento WHERE'))!;
    const [selectSql, opciones] = llamada as [string, { bind: unknown[] }];
    expect(selectSql).toContain('nu_ann_exp = $1 AND nu_sec_exp = $2');
    expect(selectSql).toContain('id = ANY($3::bigint[])');
    expect(opciones.bind).toEqual(['2026', '0000000058', [9], 500]);
  });
});

describe('repararDocumento — reintento síncrono de un documento', () => {
  it('404 si el documento ya no existe, sin intentar bloquear nada', async () => {
    documentoPorId.mockResolvedValue(null);

    await expect(ingesta.repararDocumento(999)).rejects.toThrow(/ya no existe/);
    expect(query).not.toHaveBeenCalled();
  });

  it('409 si el bloqueo asesor ya está tomado por otra reparación en curso', async () => {
    documentoPorId.mockResolvedValue(documentoRagFixture());
    const fila = filaDocumento();
    mockQueryGenerico(fila, { bloqueado: true });

    await expect(ingesta.repararDocumento(fila.id)).rejects.toThrow(/procesando ahora mismo/);
    // Sin bloqueo adquirido no hay nada que liberar.
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('pg_advisory_unlock'))).toBe(false);
  });

  it('409 si el documento está en la cola de un job en curso, nombrando el job', async () => {
    documentoPorId.mockResolvedValue(documentoRagFixture());
    const fila = filaDocumento();
    mockQueryGenerico(fila, { jobEnCola: 77 });

    await expect(ingesta.repararDocumento(fila.id)).rejects.toThrow(/trabajo #77/);
    expect(getArchivoDoc).not.toHaveBeenCalled();
    // El bloqueo SÍ se adquirió aquí, así que debe liberarse en el finally.
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('pg_advisory_unlock'))).toBe(true);
  });

  it('409 si el circuito de markitdown está abierto y no hay respaldo, sin intentar convertir', async () => {
    documentoPorId.mockResolvedValue(documentoRagFixture());
    const fila = filaDocumento();
    mockQueryGenerico(fila);
    estadoCircuito.mockReturnValue({ abierto: true, segundosRestantes: 42 });

    await expect(ingesta.repararDocumento(fila.id)).rejects.toThrow(/42 s/);
    expect(getArchivoDoc).not.toHaveBeenCalled();
  });

  /** Con un respaldo configurado y sano, que el circuito del ACTIVO esté abierto ya no basta para
   *  rechazar: la conversión saldría igual por el otro conversor. Solo bloquea cuando NINGUNA vía
   *  está disponible — ver `conversionBloqueada()`. */
  it('con respaldo sano, el circuito abierto del activo NO bloquea: la conversión sigue', async () => {
    process.env.RAG_CONVERTER_FALLBACK = 'mineru';
    const fila = filaDocumento({ co_tip_doc: '232' });
    mockQueryGenerico(fila);
    getArchivoDoc.mockResolvedValue({});
    resolverDocumento.mockReturnValue({ buffer: Buffer.from('contenido'), filename: 'x.pdf' });
    estadoCircuito.mockReturnValue({ abierto: true, segundosRestantes: 42 });
    // El circuito abierto es lo que hace que markitdown falle si de todos modos se intenta —
    // `convertirAMarkdown` va mockeado, así que esa consecuencia hay que simularla aquí.
    convertirAMarkdown.mockRejectedValue(new ConversionErrorIsolado('circuito abierto', true));
    estadoCircuitoMinerU.mockReturnValue({ abierto: false, segundosRestantes: 0 });
    convertirAMarkdownMinerU.mockResolvedValue({ markdown: 'z'.repeat(300), ms: 400 });
    documentoPorId
      .mockResolvedValueOnce(documentoRagFixture({ id: fila.id, estado: 'error' }))
      .mockResolvedValueOnce(documentoRagFixture({ id: fila.id, estado: 'convertido', metodo: 'mineru' }));

    const resultado = await ingesta.repararDocumento(fila.id);

    // El guard NO rechazó de entrada (por eso llegó a intentar markitdown pese al circuito
    // abierto); el rescate real vino del respaldo.
    expect(convertirAMarkdown).toHaveBeenCalledTimes(1);
    expect(convertirAMarkdownMinerU).toHaveBeenCalledTimes(1);
    expect(resultado.documento.estado).toBe('convertido');
  });

  it('éxito: devuelve la fila refrescada, ya convertida', async () => {
    const fila = filaDocumento({ co_tip_doc: '001' });
    mockQueryGenerico(fila);
    getArchivoDoc.mockRejectedValue(new Error('Documento no encontrado en el almacenamiento'));
    getDatosDocumentoGenerado.mockResolvedValue(datosGenerados('232'));
    documentoPorId
      .mockResolvedValueOnce(documentoRagFixture({ id: fila.id, estado: 'no_soportado' }))
      .mockResolvedValueOnce(documentoRagFixture({ id: fila.id, estado: 'convertido', metodo: 'generado' }));

    const resultado = await ingesta.repararDocumento(fila.id);

    expect(resultado.documento.estado).toBe('convertido');
    expect(resultado.mensaje).toBeUndefined();
    expect(resultado.enCurso).toBeUndefined();
  });

  it('fallo transitorio de markitdown: no lanza, devuelve la fila (vuelta a pendiente) con mensaje', async () => {
    const fila = filaDocumento({ co_tip_doc: '232' });
    mockQueryGenerico(fila);
    getArchivoDoc.mockResolvedValue({});
    resolverDocumento.mockReturnValue({ buffer: Buffer.from('contenido'), filename: 'x.pdf' });

    convertirAMarkdown.mockRejectedValue(new ConversionErrorIsolado('markitdown no responde', true));
    documentoPorId
      .mockResolvedValueOnce(documentoRagFixture({ id: fila.id, estado: 'error' }))
      .mockResolvedValueOnce(documentoRagFixture({ id: fila.id, estado: 'pendiente' }));

    const resultado = await ingesta.repararDocumento(fila.id);

    expect(resultado.mensaje).toMatch(/reintentará solo/);
    expect(resultado.documento.estado).toBe('pendiente');
  });

  it('libera el bloqueo asesor incluso cuando la conversión termina en error', async () => {
    const fila = filaDocumento({ co_tip_doc: '232' });
    mockQueryGenerico(fila);
    getArchivoDoc.mockResolvedValue({});
    resolverDocumento.mockReturnValue({ buffer: Buffer.from('contenido'), filename: 'x.pdf' });

    convertirAMarkdown.mockRejectedValue(new ConversionErrorIsolado('markitdown no responde', true));
    documentoPorId.mockResolvedValue(documentoRagFixture({ id: fila.id, estado: 'pendiente' }));

    await ingesta.repararDocumento(fila.id);

    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('pg_advisory_unlock'))).toBe(true);
  });
});

describe('enlazarSiYaExiste — no atasca un reintento en el mismo resultado vacío', () => {
  const fila = filaDocumento() as unknown as Parameters<typeof ingesta.enlazarSiYaExiste>[0];

  it('devuelve false si el contenido existente nunca produjo chunks y el markdown es corto/vacío', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT chunks_generados, markdown FROM rag.contenido')) {
        return Promise.resolve([{ chunks_generados: 0, markdown: 'x' }]); // 1 char: sinTexto
      }
      return Promise.resolve([]);
    });

    expect(await ingesta.enlazarSiYaExiste(fila, 'sha-de-prueba')).toBe(false);
  });

  it('devuelve false si chunks_generados=0 y markdown es null', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT chunks_generados, markdown FROM rag.contenido')) {
        return Promise.resolve([{ chunks_generados: 0, markdown: null }]);
      }
      return Promise.resolve([]);
    });

    expect(await ingesta.enlazarSiYaExiste(fila, 'sha-de-prueba')).toBe(false);
  });

  it('reconstruye desde caché (true) si el markdown existente es sustancial — recuperación tras GC', async () => {
    const markdownLargo = 'Contenido real del documento. '.repeat(20); // > 200 chars
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT chunks_generados, markdown FROM rag.contenido')) {
        return Promise.resolve([{ chunks_generados: 0, markdown: markdownLargo }]);
      }
      return Promise.resolve([]);
    });

    expect(await ingesta.enlazarSiYaExiste(fila, 'sha-de-prueba')).toBe(true);
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes("estado = 'convertido'"))).toBe(true);
  });

  it('devuelve true de inmediato si ya hay chunks generados (D3: nunca vuelve a pasar por markitdown)', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT chunks_generados, markdown FROM rag.contenido')) {
        return Promise.resolve([{ chunks_generados: 5, markdown: 'lo que sea' }]);
      }
      return Promise.resolve([]);
    });

    expect(await ingesta.enlazarSiYaExiste(fila, 'sha-de-prueba')).toBe(true);
  });
});

describe('convertirDocumento — un reintento SÍ vuelve a intentar la conversión real', () => {
  it('llama a markitdown de nuevo aunque ya exista una fila vacía en rag.contenido para ese sha256', async () => {
    const fila = filaDocumento();
    query.mockImplementation((sql: string) => {
      if (sql.includes('FROM rag.documento d') && sql.includes('LEFT JOIN rag.expediente e')) {
        return Promise.resolve([fila]);
      }
      if (sql.includes('SELECT chunks_generados, markdown FROM rag.contenido')) {
        return Promise.resolve([{ chunks_generados: 0, markdown: '' }]); // intento anterior vacío
      }
      return Promise.resolve([]);
    });
    getArchivoDoc.mockResolvedValue({});
    resolverDocumento.mockReturnValue({ buffer: Buffer.from('contenido'), filename: 'escaneo.pdf' });
    convertirAMarkdown.mockResolvedValue({ markdown: 'z'.repeat(300), ms: 400 });

    await ingesta.convertirDocumento(fila.id);

    expect(convertirAMarkdown).toHaveBeenCalled();
  });
});

describe('convertirDocumento — troceo de documentos largos (enrutado, no el troceo en sí)', () => {
  it('bajo el umbral de páginas, usa el camino normal y nunca llama a convertirPorBloques', async () => {
    const fila = filaDocumento({ co_tip_doc: '232' });
    mockQueryGenerico(fila);
    getArchivoDoc.mockResolvedValue({});
    resolverDocumento.mockReturnValue({ buffer: Buffer.from('contenido'), filename: 'x.pdf' });
    contarPaginas.mockResolvedValue(5); // muy por debajo del umbral por defecto (25)
    convertirAMarkdown.mockResolvedValue({ markdown: 'z'.repeat(300), ms: 100 });

    await ingesta.convertirDocumento(fila.id);

    expect(convertirAMarkdown).toHaveBeenCalled();
    expect(convertirPorBloques).not.toHaveBeenCalled();
  });

  it('sobre el umbral, trocea con convertirPorBloques (nunca llama al conversor directo) y persiste las páginas', async () => {
    const fila = filaDocumento({ co_tip_doc: '232' });
    mockQueryGenerico(fila);
    getArchivoDoc.mockResolvedValue({});
    resolverDocumento.mockReturnValue({ buffer: Buffer.from('contenido'), filename: 'x.pdf' });
    contarPaginas.mockResolvedValue(120); // muy por encima del umbral por defecto (25)
    convertirPorBloques.mockResolvedValue({ markdown: 'z'.repeat(300), ms: 5000, metodo: 'markitdown-bloques' });

    await ingesta.convertirDocumento(fila.id);

    expect(convertirPorBloques).toHaveBeenCalledWith(expect.any(Buffer), 'x.pdf', undefined, undefined);
    expect(convertirAMarkdown).not.toHaveBeenCalled();

    const guardaPaginas = query.mock.calls.find(([sql]: [string]) => sql.includes('SET paginas = $2'));
    expect(guardaPaginas).toBeDefined();
    expect((guardaPaginas![1] as { bind: unknown[] }).bind).toEqual([fila.id, 120]);
  });

  it('reenvía onLatido a convertirPorBloques, para renovar el lease entre bloques', async () => {
    const fila = filaDocumento({ co_tip_doc: '232' });
    mockQueryGenerico(fila);
    getArchivoDoc.mockResolvedValue({});
    resolverDocumento.mockReturnValue({ buffer: Buffer.from('contenido'), filename: 'x.pdf' });
    contarPaginas.mockResolvedValue(120);
    convertirPorBloques.mockResolvedValue({ markdown: 'z'.repeat(300), ms: 5000, metodo: 'markitdown-bloques' });
    const onLatido = jest.fn().mockResolvedValue(undefined);

    await ingesta.convertirDocumento(fila.id, undefined, onLatido);

    expect(convertirPorBloques).toHaveBeenCalledWith(expect.any(Buffer), 'x.pdf', undefined, onLatido);
  });

  it('un troceo con bloques parciales deja el documento "convertido", con la advertencia como motivo', async () => {
    const fila = filaDocumento({ co_tip_doc: '232' });
    mockQueryGenerico(fila);
    getArchivoDoc.mockResolvedValue({});
    resolverDocumento.mockReturnValue({ buffer: Buffer.from('contenido'), filename: 'x.pdf' });
    contarPaginas.mockResolvedValue(120);
    convertirPorBloques.mockResolvedValue({
      markdown: 'z'.repeat(300),
      ms: 5000,
      metodo: 'markitdown-bloques',
      advertencia: '1 de 8 bloques no se pudieron convertir (páginas: 46-60)',
    });

    await ingesta.convertirDocumento(fila.id);

    const marcaConvertido = query.mock.calls.find(([sql]: [string]) => sql.includes("estado = 'convertido'"));
    expect(marcaConvertido).toBeDefined();
    expect((marcaConvertido![1] as { bind: unknown[] }).bind).toContain(
      '1 de 8 bloques no se pudieron convertir (páginas: 46-60)',
    );
  });
});

describe('convertirDocumento — tope de reintentos ante un fallo reintentable', () => {
  it('por debajo del tope, un fallo reintentable vuelve a pendiente con el motivo guardado', async () => {
    const fila = filaDocumento({ co_tip_doc: '232', intentos: 0 });
    mockQueryGenerico(fila);
    getArchivoDoc.mockResolvedValue({});
    resolverDocumento.mockReturnValue({ buffer: Buffer.from('contenido'), filename: 'x.pdf' });
    convertirAMarkdown.mockRejectedValue(new ConversionErrorIsolado('markitdown no responde', true));

    await expect(ingesta.convertirDocumento(fila.id)).rejects.toThrow('markitdown no responde');

    const pendiente = query.mock.calls.find(([sql]: [string]) => sql.includes("SET estado = 'pendiente'"));
    expect(pendiente).toBeDefined();
    expect((pendiente![1] as { bind: unknown[] }).bind).toEqual([fila.id, 'markitdown no responde']);
  });

  /** `intentos` en la fila viene de ANTES de esta pasada; `marcarEstado('en_proceso')` ya sumó 1 al
   *  entrar a `convertirDocumento` — con `intentos: 4` en la fila, este es el 5º intento real. */
  it('al agotar MAX_INTENTOS_CONVERSION (5), el documento pasa a error terminal, no a pendiente', async () => {
    const fila = filaDocumento({ co_tip_doc: '232', intentos: 4 });
    mockQueryGenerico(fila);
    getArchivoDoc.mockResolvedValue({});
    resolverDocumento.mockReturnValue({ buffer: Buffer.from('contenido'), filename: 'x.pdf' });
    convertirAMarkdown.mockRejectedValue(new ConversionErrorIsolado('markitdown no responde', true));

    await expect(ingesta.convertirDocumento(fila.id)).rejects.toThrow('markitdown no responde');

    const pendiente = query.mock.calls.find(([sql]: [string]) => sql.includes("SET estado = 'pendiente'"));
    expect(pendiente).toBeUndefined();

    const marcaError = llamadasMarcarEstado().find(
      ([, opts]: [string, { bind: unknown[] }]) => opts.bind[1] === 'error',
    );
    expect(marcaError).toBeDefined();
    expect((marcaError![1] as { bind: unknown[] }).bind[2]).toMatch(/máximo de 5 intentos alcanzado/);
  });
});

describe('ejecutarJobConversion — renueva el lease del ítem entre bloques de un documento troceado', () => {
  async function flush(vueltas = 15) {
    for (let i = 0; i < vueltas; i++) await new Promise((r) => setImmediate(r));
  }

  it('cada bloque completado renueva lease_hasta, no solo el reclamo inicial del ítem', async () => {
    const JOB_ID = 60;
    const fila = filaDocumento({ id: 601, co_tip_doc: '232' });
    let itemClaimado = false;
    const renovaciones: unknown[] = [];

    query.mockImplementation((sql: string, opts?: { bind?: unknown[] }) => {
      if (sql.includes('FROM rag.documento WHERE')) return Promise.resolve([{ id: fila.id }]);
      if (sql.includes('INSERT INTO rag.ingest_job')) return Promise.resolve([{ id: JOB_ID }]);
      if (sql.includes('INSERT INTO rag.ingest_item')) return Promise.resolve([]);
      if (sql.includes('SELECT estado FROM rag.ingest_job WHERE id')) return Promise.resolve([{ estado: 'en_curso' }]);
      if (sql.includes('SELECT id, documento_id FROM rag.ingest_item')) {
        if (itemClaimado) return Promise.resolve([]);
        itemClaimado = true;
        return Promise.resolve([{ id: 1, documento_id: fila.id }]);
      }
      if (sql.includes('FROM rag.documento d') && sql.includes('LEFT JOIN rag.expediente e')) {
        return Promise.resolve([fila]);
      }
      // Distinta del UPDATE de reclamo (que también fija estado='en_proceso' además del lease): solo
      // esta es la renovación PURA que se dispara desde `onLatido`, una vez por bloque.
      if (sql.includes("SET lease_hasta = now() + interval '10 minutes' WHERE id = $1")) {
        renovaciones.push(opts?.bind);
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
    transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb({}));
    documentoPorId.mockResolvedValue(documentoRagFixture({ id: fila.id, titulo: 'DOCUMENTO LARGO' }));
    getArchivoDoc.mockResolvedValue({});
    resolverDocumento.mockReturnValue({ buffer: Buffer.from('contenido'), filename: 'x.pdf' });
    contarPaginas.mockResolvedValue(120);
    // Simula un troceo de 3 bloques: cada uno dispara un latido antes de que la conversión resuelva.
    convertirPorBloques.mockImplementation(
      async (_b: Buffer, _f: string, _onFase: unknown, onLatido?: () => Promise<void>) => {
        if (onLatido) {
          await onLatido();
          await onLatido();
          await onLatido();
        }
        return { markdown: 'z'.repeat(300), ms: 5000, metodo: 'markitdown-bloques' };
      },
    );

    await ingesta.iniciarJobConversion({}, 'admin');
    // Más vueltas que el resto del archivo: el troceo por bloques mete varios `await` extra
    // (contarPaginas, la persistencia de `paginas`, y un latido por bloque) antes de que el job
    // pueda terminar de procesar el único ítem.
    await flush(40);

    expect(renovaciones).toHaveLength(3);
    expect(renovaciones[0]).toEqual([1]); // item.id = 1, fijado en el mock de reclamo
  });
});

describe('pausarJob / reanudarJob / cancelarJob — transiciones válidas e inválidas', () => {
  it('pausarJob: 409 si el job no está en_curso, sin tocar nada más', async () => {
    query.mockResolvedValue([]); // UPDATE ... RETURNING id: ninguna fila afectada

    await expect(ingesta.pausarJob(5)).rejects.toThrow(/no está en curso/);
  });

  it('pausarJob: éxito cuando el UPDATE devuelve la fila', async () => {
    query.mockResolvedValue([{ id: 5 }]);

    await expect(ingesta.pausarJob(5)).resolves.toBeUndefined();
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("SET estado = 'pausado'");
  });

  it('reanudarJob: 409 si el job no está pausado', async () => {
    query.mockResolvedValue([]);

    await expect(ingesta.reanudarJob(5)).rejects.toThrow(/no está pausado/);
  });

  it('reanudarJob: éxito relanza el loop de conversión (fire-and-forget)', async () => {
    // Primera llamada: el UPDATE que pausado->en_curso. Las siguientes (el loop relanzado en
    // background) pueden devolver lo que sea — solo importa que no cuelgue el test.
    query.mockImplementation((sql: string) => {
      if (sql.includes("SET estado = 'en_curso'")) return Promise.resolve([{ id: 5 }]);
      if (sql.includes('SELECT estado FROM rag.ingest_job WHERE id')) {
        return Promise.resolve([{ estado: 'cancelado' }]); // corta el loop en la próxima vuelta
      }
      return Promise.resolve([]);
    });

    await expect(ingesta.reanudarJob(5)).resolves.toBeUndefined();
  });

  it('cancelarJob: 409 si el job ya terminó (no está en_curso ni pausado)', async () => {
    query.mockResolvedValue([]);

    await expect(ingesta.cancelarJob(5)).rejects.toThrow(/ya terminó/);
  });

  it('cancelarJob: éxito marca "omitido" los ítems que seguían pendientes', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes("SET estado = 'cancelado'")) return Promise.resolve([{ id: 5 }]);
      return Promise.resolve([]);
    });

    await ingesta.cancelarJob(5);

    const omitido = query.mock.calls.find(([sql]: [string]) => sql.includes("SET estado = 'omitido'"));
    expect(omitido).toBeDefined();
    expect((omitido![1] as { bind: unknown[] }).bind).toEqual([5]);
  });
});

describe('ejecutarJobConversion — respeta una pausa/cancelación que llega entre ítems', () => {
  async function flush(vueltas = 15) {
    for (let i = 0; i < vueltas; i++) await new Promise((r) => setImmediate(r));
  }

  it('si el job pasa a "pausado" tras el ítem en curso, no reclama otro ni marca completado', async () => {
    const JOB_ID = 42;
    const fila = filaDocumento({ id: 501, co_tip_doc: '232' });
    let estadoActual = 'en_curso';
    let itemsReclamados = 0;

    query.mockImplementation((sql: string) => {
      if (sql.includes('FROM rag.documento WHERE')) return Promise.resolve([{ id: fila.id }]); // documentosPendientes
      if (sql.includes('INSERT INTO rag.ingest_job')) return Promise.resolve([{ id: JOB_ID }]);
      if (sql.includes('INSERT INTO rag.ingest_item')) return Promise.resolve([]);
      if (sql.includes('SELECT estado FROM rag.ingest_job WHERE id')) {
        return Promise.resolve([{ estado: estadoActual }]);
      }
      if (sql.includes('SELECT id, documento_id FROM rag.ingest_item')) {
        itemsReclamados++;
        estadoActual = 'pausado'; // se "pausa" justo después de reclamar el único ítem
        return Promise.resolve([{ id: 1, documento_id: fila.id }]);
      }
      if (sql.includes('FROM rag.documento d') && sql.includes('LEFT JOIN rag.expediente e')) {
        return Promise.resolve([fila]);
      }
      return Promise.resolve([]);
    });
    transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb({}));
    documentoPorId.mockResolvedValue(documentoRagFixture({ id: fila.id, titulo: 'X' }));
    // Camino más corto para que convertirDocumento resuelva sin lanzar: sin archivo Y sin datos
    // generables → se marca 'no_soportado' internamente, pero la función no lanza.
    getArchivoDoc.mockRejectedValue(new Error('sin archivo'));
    getDatosDocumentoGenerado.mockResolvedValue(null);

    const { jobId } = await ingesta.iniciarJobConversion({}, 'admin');
    expect(jobId).toBe(JOB_ID);
    await flush();

    expect(query.mock.calls.some(([sql]: [string]) => sql.includes("estado = 'completado'"))).toBe(false);
    expect(itemsReclamados).toBe(1);
    expect(ingesta.progresoJob(JOB_ID)).toBeNull();
  });

  it('progresoJob refleja el documento en curso mientras la conversión sigue pendiente', async () => {
    const JOB_ID = 43;
    const fila = filaDocumento({ id: 502 });
    let resolverArchivo!: (v: unknown) => void;
    const archivoPendiente = new Promise((r) => { resolverArchivo = r; });
    let itemClaimado = false; // el mock no simula el filtro real "estado='pendiente'" tras reclamarlo

    query.mockImplementation((sql: string) => {
      if (sql.includes('FROM rag.documento WHERE')) return Promise.resolve([{ id: fila.id }]);
      if (sql.includes('INSERT INTO rag.ingest_job')) return Promise.resolve([{ id: JOB_ID }]);
      if (sql.includes('INSERT INTO rag.ingest_item')) return Promise.resolve([]);
      if (sql.includes('SELECT estado FROM rag.ingest_job WHERE id')) return Promise.resolve([{ estado: 'en_curso' }]);
      if (sql.includes('SELECT id, documento_id FROM rag.ingest_item')) {
        if (itemClaimado) return Promise.resolve([]);
        itemClaimado = true;
        return Promise.resolve([{ id: 1, documento_id: fila.id }]);
      }
      if (sql.includes('FROM rag.documento d') && sql.includes('LEFT JOIN rag.expediente e')) {
        return Promise.resolve([fila]);
      }
      return Promise.resolve([]);
    });
    transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb({}));
    documentoPorId.mockResolvedValue(documentoRagFixture({ id: fila.id, titulo: 'INFORME EN CURSO' }));
    getArchivoDoc.mockReturnValue(archivoPendiente); // convertirDocumento queda colgado aquí

    await ingesta.iniciarJobConversion({}, 'admin');
    await flush();

    const proceso = ingesta.progresoJob(JOB_ID);
    expect(proceso?.documentoId).toBe(fila.id);
    expect(proceso?.titulo).toBe('INFORME EN CURSO');
    // `obtenerBytesDocumento` (donde `getArchivoDoc` está colgado) es lo primero que hace
    // `convertirDocumento` tras marcar 'descargando' — si la fase inicial fuera otra, significaría
    // que `ejecutarJobConversion` dejó de inicializarla antes de invocar la conversión real.
    expect(proceso?.fase).toBe('descargando');

    resolverArchivo({}); // libera convertirDocumento para no dejar el test colgado
    await flush();
  });

  it('progresoJob encuentra el job aunque el id llegue como string, como lo devuelve pg para bigint', async () => {
    // `rag.ingest_job.id` es bigint: sin `setTypeParser` para el OID 20 (y este proyecto no lo
    // registra, a propósito, para no arriesgar precisión con ids que superen
    // Number.MAX_SAFE_INTEGER), `pg` devuelve el `RETURNING id` de un INSERT crudo como STRING, no
    // como number — verificado contra la base real, no es una suposición. El controlador HTTP, en
    // cambio, hace `Number(req.params.jobId)` antes de llamar a `estadoJob`. Sin normalizar la
    // clave dentro de este módulo, `progresoEnVivo.set("47", …)` y `progresoEnVivo.get(47)` nunca
    // coinciden y `procesoActual` sale `null` siempre, por más que el loop esté progresando de
    // verdad — así estuvo desde el `progresoEnVivo` original, antes de que existieran las fases.
    const JOB_ID = 47;
    const fila = filaDocumento({ id: 504 });
    let resolverArchivo!: (v: unknown) => void;
    const archivoPendiente = new Promise((r) => { resolverArchivo = r; });
    let itemClaimado = false;

    query.mockImplementation((sql: string) => {
      if (sql.includes('FROM rag.documento WHERE')) return Promise.resolve([{ id: fila.id }]);
      // El propio mock reproduce el bigint-como-string: la fila del INSERT trae el id en texto.
      if (sql.includes('INSERT INTO rag.ingest_job')) return Promise.resolve([{ id: String(JOB_ID) }]);
      if (sql.includes('INSERT INTO rag.ingest_item')) return Promise.resolve([]);
      if (sql.includes('SELECT estado FROM rag.ingest_job WHERE id')) return Promise.resolve([{ estado: 'en_curso' }]);
      if (sql.includes('SELECT id, documento_id FROM rag.ingest_item')) {
        if (itemClaimado) return Promise.resolve([]);
        itemClaimado = true;
        return Promise.resolve([{ id: 1, documento_id: fila.id }]);
      }
      if (sql.includes('FROM rag.documento d') && sql.includes('LEFT JOIN rag.expediente e')) {
        return Promise.resolve([fila]);
      }
      return Promise.resolve([]);
    });
    transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb({}));
    documentoPorId.mockResolvedValue(documentoRagFixture({ id: fila.id, titulo: 'CON ID STRING' }));
    getArchivoDoc.mockReturnValue(archivoPendiente);

    await ingesta.iniciarJobConversion({}, 'admin');
    await flush();

    // Se consulta con el NUMBER que usaría `getJob` (`Number(req.params.jobId)`), no con el string
    // que trae el mock del INSERT — es justo el cruce de tipos que rompía el Map.
    const proceso = ingesta.progresoJob(JOB_ID);
    expect(proceso?.documentoId).toBe(fila.id);
    expect(proceso?.fase).toBe('descargando');

    resolverArchivo({});
    await flush();
  });

  it('anotarFase ignora un aviso cuyo documentoId no es el que el job tiene en curso ahora mismo', async () => {
    const JOB_ID = 46;
    const fila = filaDocumento({ id: 503 });
    let resolverArchivo!: (v: unknown) => void;
    const archivoPendiente = new Promise((r) => { resolverArchivo = r; });
    let itemClaimado = false; // como en el test anterior: sin esto el mock reclama el mismo ítem para siempre

    query.mockImplementation((sql: string) => {
      if (sql.includes('FROM rag.documento WHERE')) return Promise.resolve([{ id: fila.id }]);
      if (sql.includes('INSERT INTO rag.ingest_job')) return Promise.resolve([{ id: JOB_ID }]);
      if (sql.includes('INSERT INTO rag.ingest_item')) return Promise.resolve([]);
      if (sql.includes('SELECT estado FROM rag.ingest_job WHERE id')) return Promise.resolve([{ estado: 'en_curso' }]);
      if (sql.includes('SELECT id, documento_id FROM rag.ingest_item')) {
        if (itemClaimado) return Promise.resolve([]);
        itemClaimado = true;
        return Promise.resolve([{ id: 1, documento_id: fila.id }]);
      }
      if (sql.includes('FROM rag.documento d') && sql.includes('LEFT JOIN rag.expediente e')) {
        return Promise.resolve([fila]);
      }
      return Promise.resolve([]);
    });
    transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb({}));
    documentoPorId.mockResolvedValue(documentoRagFixture({ id: fila.id, titulo: 'EN CURSO' }));
    getArchivoDoc.mockReturnValue(archivoPendiente); // convertirDocumento queda colgado en 'descargando'

    await ingesta.iniciarJobConversion({}, 'admin');
    await flush();

    // Simula el aviso tardío de una conversión abandonada por el límite duro de mdConvertService
    // (incidente de 2026-08-23): sigue viva en segundo plano después de que el loop ya haya
    // pasado a otro documento. Sin el filtro por documentoId, este aviso pisaría la fase del
    // documento que SÍ está en curso ahora y la barra retrocedería sin explicación.
    ingesta.anotarFase(JOB_ID, fila.id + 999, { fase: 'convirtiendo', proveedor: 'markitdown', limiteMs: 1000 });
    expect(ingesta.progresoJob(JOB_ID)?.fase).toBe('descargando');

    // El mismo aviso, con el documentoId correcto, sí se aplica.
    ingesta.anotarFase(JOB_ID, fila.id, { fase: 'convirtiendo', proveedor: 'markitdown', limiteMs: 1000 });
    expect(ingesta.progresoJob(JOB_ID)?.fase).toBe('convirtiendo');

    resolverArchivo({});
    await flush();
  });
});

describe('frontera de módulos — la ruta gratuita nunca puede alcanzar la de pago', () => {
  it('ingestaService.ts no importa visionService.ts, ni directa ni indirectamente por texto', () => {
    // Ni `iniciarJobConversion` ni `iniciarJobReparacion` podrían llamar nunca a la IA de pago si
    // el propio archivo no tiene forma de referenciar ese módulo — más fuerte que confiar en la
    // disciplina de code review para mantenerlo así con el tiempo.
    const fs = require('fs');
    const path = require('path');
    const fuente: string = fs.readFileSync(
      path.resolve(__dirname, '../../src/rag/ingestaService.ts'),
      'utf8',
    );
    const referenciaAVision = /from\s+['"].*visionService['"]|require\(['"].*visionService['"]\)/;
    expect(referenciaAVision.test(fuente)).toBe(false);
  });
});
