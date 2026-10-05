/**
 * Orquestación del chat STD por intención (docs/PLAN-CHAT-CONSULTAS.md, Fase 7), aislada con
 * mocks igual que `chatService.test.ts` del SGD: lo que se prueba es qué camino toma cada turno
 * (mensaje fijo, tabla, tarjeta, contenido) y con qué conjunto; el SQL de la búsqueda de documentos
 * se verificó contra la BD real.
 */

const chatDisponible = jest.fn();
const responder = jest.fn();
const buscarHibridoStd = jest.fn();
const elegirDocumentoParaCitaStd = jest.fn();
const lineaTiempoStd = jest.fn();
const query = jest.fn();
const planificar = jest.fn();
const leerBooleano = jest.fn();
const ejecutarListadoStd = jest.fn();
const ejecutarUltimoDocumentoStd = jest.fn();
const ejecutarParticipantesStd = jest.fn();
const agruparPorObraStd = jest.fn();
let metaConjunto: unknown = null;
const guardados: string[] = [];

jest.mock('../../../../src/compartido/ai/providerFactory', () => ({
  chatDisponible: (...a: unknown[]) => chatDisponible(...a),
  crearChatProvider: () => ({ nombre: 'openai', modelo: 'gpt-4o-mini', responder: (...a: unknown[]) => responder(...a) }),
}));

jest.mock('../../../../src/modulos/std/rag/retrievalStdService', () => ({
  buscarHibridoStd: (...a: unknown[]) => buscarHibridoStd(...a),
  elegirDocumentoParaCitaStd: (...a: unknown[]) => elegirDocumentoParaCitaStd(...a),
  lineaTiempoStd: (...a: unknown[]) => lineaTiempoStd(...a),
  recortarPorPresupuestoStd: (chunks: unknown[]) => chunks,
}));

jest.mock('../../../../src/compartido/rag/planificadorService', () => ({
  ...jest.requireActual('../../../../src/compartido/rag/planificadorService'),
  planificar: (...a: unknown[]) => planificar(...a),
}));

jest.mock('../../../../src/compartido/rag/configService', () => ({
  leerBooleano: (...a: unknown[]) => leerBooleano(...a),
  leerConfig: () => Promise.resolve(null),
  leerNumero: (_clave: string, porDefecto: number) => Promise.resolve(porDefecto),
}));

jest.mock('../../../../src/modulos/std/rag/listadoChatStdService', () => ({
  ...jest.requireActual('../../../../src/modulos/std/rag/listadoChatStdService'),
  ejecutarListadoStd: (...a: unknown[]) => ejecutarListadoStd(...a),
}));

jest.mock('../../../../src/modulos/std/rag/respuestasEstructuradasStdService', () => ({
  ejecutarUltimoDocumentoStd: (...a: unknown[]) => ejecutarUltimoDocumentoStd(...a),
  ejecutarParticipantesStd: (...a: unknown[]) => ejecutarParticipantesStd(...a),
  agruparPorObraStd: (...a: unknown[]) => agruparPorObraStd(...a),
}));

jest.mock('../../../../src/modulos/std/config/stdRagDatabase', () => ({
  stdRagSequelize: { query: (...a: unknown[]) => query(...a) },
}));

jest.mock('../../../../src/compartido/config/appDatabase', () => ({ appSequelize: { query: jest.fn() } }));

type ChatStd = typeof import('../../../../src/modulos/std/rag/chatStdService');
let chat: ChatStd;

beforeAll(() => {
  jest.isolateModules(() => {
    chat = require('../../../../src/modulos/std/rag/chatStdService');
  });
});

const { planDeRespaldo } = jest.requireActual(
  '../../../../src/compartido/rag/planificadorService',
) as typeof import('../../../../src/compartido/rag/planificadorService');

const conPlan = (over: Partial<ReturnType<typeof planDeRespaldo>>) => ({
  plan: { ...planDeRespaldo('x'), ...over }, uso: null, respaldo: false, ms: 1,
});

beforeEach(() => {
  guardados.length = 0;
  metaConjunto = null;
  query.mockReset().mockImplementation((sql: string, opts?: { bind?: unknown[] }) => {
    if (sql.includes('INSERT INTO rag.chat_sesion')) return Promise.resolve([{ id: 7, usuario_id: 'u1', modo: 'general', id_documento: null }]);
    if (sql.includes("WHERE sesion_id = $1 AND tipo = 'tabla'")) return Promise.resolve(metaConjunto ? [{ meta: metaConjunto }] : []);
    if (sql.includes('rol, texto FROM rag.chat_mensaje')) return Promise.resolve([]);
    if (sql.includes("'assistant', $2, $3, $4::jsonb")) { guardados.push(`guardar-${opts?.bind?.[2]}`); return Promise.resolve([{ id: 88 }]); }
    if (sql.includes("'assistant', $2, 'fijo'")) { guardados.push('guardar-fijo'); return Promise.resolve([{ id: 77 }]); }
    if (sql.includes("VALUES ($1, 'assistant', '')")) { guardados.push('pendiente'); return Promise.resolve([{ id: 99 }]); }
    return Promise.resolve(undefined);
  });
  chatDisponible.mockReturnValue({ disponible: true, motivo: null });
  responder.mockReset().mockResolvedValue({ texto: 'respuesta [D1]', uso: { tokensIn: 10, tokensOut: 5, estimado: false } });
  buscarHibridoStd.mockReset().mockResolvedValue({ chunks: [], candidatosVec: 0, candidatosFts: 0, escaneoExacto: true });
  elegirDocumentoParaCitaStd.mockReset().mockResolvedValue(null);
  lineaTiempoStd.mockReset().mockResolvedValue({ movimientos: [], referencias: [] });
  leerBooleano.mockReset().mockResolvedValue(true);
  planificar.mockReset().mockImplementation((_p: unknown, mensaje: string) => Promise.resolve({
    plan: planDeRespaldo(mensaje), uso: null, respaldo: false, ms: 1,
  }));
  ejecutarListadoStd.mockReset();
  ejecutarUltimoDocumentoStd.mockReset();
  ejecutarParticipantesStd.mockReset();
  agruparPorObraStd.mockReset();
});

const peticion = (over: Partial<Parameters<ChatStd['responderChatStd']>[0]> = {}) => ({
  usuarioId: 'u1', modo: 'general' as const, mensaje: '¿qué dice el informe?', ...over,
});

describe('responderChatStd — cierre', () => {
  it('un saludo → mensaje fijo, sin planificador ni búsqueda', async () => {
    const r = await chat.responderChatStd(peticion({ mensaje: 'hola' }));
    expect(r.tipo).toBe('fijo');
    expect(planificar).not.toHaveBeenCalled();
    expect(buscarHibridoStd).not.toHaveBeenCalled();
    expect(guardados).toEqual(['guardar-fijo']);
  });

  it('fuera de alcance → mensaje fijo, sin búsqueda ni modelo de respuesta', async () => {
    planificar.mockResolvedValue(conPlan({ intencion: 'fuera_de_alcance' }));
    const r = await chat.responderChatStd(peticion({ mensaje: '¿capital de Francia?' }));
    expect(r.tipo).toBe('fijo');
    expect(buscarHibridoStd).not.toHaveBeenCalled();
    expect(responder).not.toHaveBeenCalled();
  });

  it('contenido sin fragmentos ni línea de tiempo → "no encontré", sin llamar al modelo', async () => {
    const r = await chat.responderChatStd(peticion());
    expect(r.tipo).toBe('fijo');
    expect(responder).not.toHaveBeenCalled();
  });
});

describe('responderChatStd — respuestas estructuradas', () => {
  const tabla = { filas: [], pagina: 1, porPagina: 10, total: 2, nivel1: 2, nivel2: 0, hayMas: false };

  it('listar → tabla de documentos, sin contenido ni modelo', async () => {
    planificar.mockResolvedValue(conPlan({ intencion: 'listar' }));
    ejecutarListadoStd.mockResolvedValue({ texto: 'Encontré 2 documentos…', tabla, meta: { busqueda: { total: 2 } } });

    const r = await chat.responderChatStd(peticion({ mensaje: 'documentos del contrato 227-2022-MCEBS' }));

    expect(r.tipo).toBe('tabla');
    expect(r.tabla).toEqual(tabla);
    expect(ejecutarListadoStd).toHaveBeenCalledWith('listar', expect.anything(), {});
    expect(buscarHibridoStd).not.toHaveBeenCalled();
    expect(responder).not.toHaveBeenCalled();
    expect(guardados).toEqual(['guardar-tabla']);
  });

  it('una pregunta que continúa usa como conjunto los N° STD del último listado', async () => {
    metaConjunto = {
      version: 1, sistema: 'std', plan: planDeRespaldo('x'), busqueda: { total: 2, nivel1: 2, nivel2: 0 },
      documentos: [{ a: '61279', s: '', n: 1 }, { a: '60917', s: '', n: 1 }],
    };
    planificar.mockResolvedValue(conPlan({ intencion: 'ultimo_documento', continuaAnterior: true }));
    ejecutarUltimoDocumentoStd.mockResolvedValue({ texto: 'El más reciente…', documento: { titulo: 'CARTA' }, meta: {} });

    const r = await chat.responderChatStd(peticion({ mensaje: '¿y el último?' }));

    expect(r.tipo).toBe('documento');
    expect(ejecutarUltimoDocumentoStd).toHaveBeenCalledWith(expect.anything(), { idDocumento: undefined, conjunto: [61279, 60917] });
  });

  it('participantes en el modo por documento operan sobre ese N° STD', async () => {
    planificar.mockResolvedValue(conPlan({ intencion: 'participantes' }));
    ejecutarParticipantesStd.mockResolvedValue({ texto: 'Participantes…', participantes: { totalExpedientes: 1 }, meta: {} });

    const r = await chat.responderChatStd(peticion({ modo: 'documento', idDocumento: 48683, mensaje: '¿quiénes participaron?' }));

    expect(r.tipo).toBe('participantes');
    expect(ejecutarParticipantesStd).toHaveBeenCalledWith(expect.anything(), { idDocumento: 48683, conjunto: null });
    // El planificador recibe el modo "por documento" como su modo "expediente".
    expect(planificar.mock.calls[0][2]).toMatchObject({ modo: 'expediente' });
  });

  it('agrupar → texto con los grupos + la tabla', async () => {
    planificar.mockResolvedValue(conPlan({ intencion: 'agrupar' }));
    ejecutarListadoStd.mockResolvedValue({ texto: 'Encontré 2 documentos.', tabla, meta: { busqueda: { total: 2 } } });
    agruparPorObraStd.mockResolvedValue({ texto: '- Obra X (contrato 1-2020-X): STD 1 (archivado)', grupos: [], agrupados: 2, soloDirectos: true });

    const r = await chat.responderChatStd(peticion({ mensaje: '¿qué obras tienen penalidades?' }));

    expect(r.tipo).toBe('tabla');
    expect(r.texto).toContain('Agrupé por contrato los 2');
    expect(r.texto).toContain('- Obra X');
  });
});

describe('responderChatStd — contenido', () => {
  it('busca con la consulta reescrita y los términos del plan, y cita lo que encuentra', async () => {
    planificar.mockResolvedValue(conPlan({
      intencion: 'contenido', consulta: 'ampliación de plazo del contrato 227-2022-MCEBS',
      terminos: { obligatorios: ['ampliación de plazo'], opcionales: [] },
    }));
    buscarHibridoStd.mockResolvedValue({
      chunks: [{ chunkId: 1, texto: 'Evento compensable 25…', rutaTitulos: null, ord: 0, sha256: 'a', score: 1 }],
      candidatosVec: 0, candidatosFts: 1, escaneoExacto: true,
    });
    elegirDocumentoParaCitaStd.mockResolvedValue({ id: 5, idAdjunto: 10, idDocumento: 61279, nroStd: '61279', origen: 'principal' });

    const r = await chat.responderChatStd(peticion({ mensaje: '¿qué dicen de la ampliación de plazo?' }));

    expect(r.tipo).toBe('texto');
    expect(buscarHibridoStd).toHaveBeenCalledWith(
      'ampliación de plazo del contrato 227-2022-MCEBS', undefined, undefined, ['ampliación de plazo'],
    );
    expect(r.citas).toHaveLength(1);
    expect(guardados).toEqual(['pendiente']);
  });
});
