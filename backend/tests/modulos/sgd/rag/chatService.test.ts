/**
 * Orquestación de `chatService.ts`, aislada con mocks — igual que `ingestaService.test.ts`: lo
 * que vale la pena aislar aquí es la lógica de control (disponibilidad, propiedad de la sesión,
 * orden citas-antes-que-modelo, limpieza de marcadores inventados, deshacer en caso de fallo),
 * no reimplementar en un mock el SQL de `retrievalService.ts`, que se verificó contra la BD real.
 */

const chatDisponible = jest.fn();
const responder = jest.fn();
const programarJuicio = jest.fn();
// El juez corre en segundo plano y se prueba aparte (juezService.test.ts): aquí, solo que se programe.
jest.mock('../../../../src/compartido/rag/juezService', () => ({
  programarJuicio: (...a: unknown[]) => programarJuicio(...a),
}));
const buscarHibrido = jest.fn();
const elegirDocumentoParaCita = jest.fn();
const estadoExpediente = jest.fn();
const query = jest.fn();
const planificar = jest.fn();
const leerBooleano = jest.fn();
const ejecutarListado = jest.fn();
const ejecutarUltimoDocumento = jest.fn();
const ejecutarParticipantes = jest.fn();
const agruparPorObra = jest.fn();
/** Meta del último listado de la sesión (conjunto activo); null = la sesión no tiene ninguno. */
let metaConjunto: unknown = null;
const ordenLlamadas: string[] = [];

jest.mock('../../../../src/compartido/ai/providerFactory', () => ({
  chatDisponible: (...a: unknown[]) => chatDisponible(...a),
  crearChatProvider: () => ({ nombre: 'ollama', modelo: 'llama3', responder: (...a: unknown[]) => responder(...a) }),
  // Rerank por LLM (el valor por defecto): usa el mismo `responder` mockeado.
  metodoRerankConfigurado: () => 'llm',
  crearRerankProvider: () => null,
  crearChatProviderRapido: () => null,
}));

jest.mock('../../../../src/modulos/sgd/rag/retrievalService', () => ({
  buscarHibrido: (...a: unknown[]) => buscarHibrido(...a),
  elegirDocumentoParaCita: (...a: unknown[]) => elegirDocumentoParaCita(...a),
  estadoExpediente: (...a: unknown[]) => estadoExpediente(...a),
  recortarPorPresupuesto: (chunks: unknown[]) => chunks, // sin recorte: se prueba aparte, es pura
  LIMITE_RESULTADO: 20,
  TOPE_POR_DOCUMENTO: 3,
}));

// El planificador se prueba aparte (planificadorService.test.ts); aquí solo importa qué hace el
// chat con cada plan. `planDeRespaldo` es el real: es pura.
jest.mock('../../../../src/compartido/rag/planificadorService', () => ({
  ...jest.requireActual('../../../../src/compartido/rag/planificadorService'),
  planificar: (...a: unknown[]) => planificar(...a),
}));

jest.mock('../../../../src/compartido/rag/configService', () => ({
  leerBooleano: (...a: unknown[]) => leerBooleano(...a),
  leerConfig: () => Promise.resolve(null), // mensajes fijos y sinónimos: siempre el valor por defecto
  leerNumero: (_clave: string, porDefecto: number) => Promise.resolve(porDefecto),
}));

// El listado (búsqueda de expedientes + SGD en vivo) se prueba en sus propios archivos.
jest.mock('../../../../src/modulos/sgd/rag/listadoChatService', () => ({
  ...jest.requireActual('../../../../src/modulos/sgd/rag/listadoChatService'),
  ejecutarListado: (...a: unknown[]) => ejecutarListado(...a),
}));

jest.mock('../../../../src/modulos/sgd/rag/respuestasEstructuradasService', () => ({
  ...jest.requireActual('../../../../src/modulos/sgd/rag/respuestasEstructuradasService'),
  ejecutarUltimoDocumento: (...a: unknown[]) => ejecutarUltimoDocumento(...a),
  ejecutarParticipantes: (...a: unknown[]) => ejecutarParticipantes(...a),
  agruparPorObra: (...a: unknown[]) => agruparPorObra(...a),
}));

jest.mock('../../../../src/compartido/config/appDatabase', () => ({
  appSequelize: { query: (...a: unknown[]) => query(...a) },
}));

import type { Traza } from '../../../../src/compartido/observabilidad/traza';

type ChatSvc = typeof import('../../../../src/modulos/sgd/rag/chatService');
let chat: ChatSvc;
/** La MISMA instancia del módulo que ve el chat (jest.isolateModules carga copias aparte). */
let registrarPublicador: typeof import('../../../../src/compartido/observabilidad/traza').registrarPublicador;

beforeAll(() => {
  jest.isolateModules(() => {
    chat = require('../../../../src/modulos/sgd/rag/chatService');
    ({ registrarPublicador } = require('../../../../src/compartido/observabilidad/traza'));
  });
});

/** Enruta cada `query` por el texto del SQL, no por posición: más robusto a reordenar el código. */
function instalarQueryPorDefecto() {
  query.mockReset();
  ordenLlamadas.length = 0;

  query.mockImplementation((sql: string, opts?: unknown) => {
    if (sql.includes('SELECT id, usuario_id, modo')) {
      return Promise.resolve([{ id: 42, usuario_id: 'u1', modo: 'general', nu_ann_exp: null, nu_sec_exp: null }]);
    }
    if (sql.includes('INSERT INTO rag.chat_sesion')) {
      return Promise.resolve([{ id: 42, usuario_id: 'u1', modo: 'general', nu_ann_exp: null, nu_sec_exp: null }]);
    }
    if (sql.includes("WHERE sesion_id = $1 AND tipo = 'tabla'")) {
      return Promise.resolve(metaConjunto ? [{ meta: metaConjunto }] : []);
    }
    if (sql.includes("rol, texto FROM rag.chat_mensaje")) {
      return Promise.resolve([]); // sin historial previo
    }
    if (sql.includes("'assistant', $2, $3, $4::jsonb")) {
      ordenLlamadas.push(`guardar-${(opts as { bind: unknown[] }).bind[2]}`);
      return Promise.resolve([{ id: 88 }]);
    }
    if (sql.includes("'assistant', $2, 'fijo'")) {
      ordenLlamadas.push('guardar-fijo');
      return Promise.resolve([{ id: 77 }]);
    }
    if (sql.includes("VALUES ($1, 'assistant'")) {
      ordenLlamadas.push('crear-mensaje-pendiente');
      return Promise.resolve([{ id: 99 }]);
    }
    if (sql.startsWith('INSERT INTO rag.cita')) {
      ordenLlamadas.push('insert-cita');
      return Promise.resolve(undefined);
    }
    if (sql.startsWith('DELETE FROM rag.chat_mensaje')) {
      ordenLlamadas.push('borrar-mensaje-pendiente');
      return Promise.resolve(undefined);
    }
    if (sql.includes("SET estado = 'fallido'")) {
      ordenLlamadas.push('marcar-fallido');
      return Promise.resolve(undefined);
    }
    return Promise.resolve(undefined);
  });
}

beforeEach(() => {
  instalarQueryPorDefecto();
  chatDisponible.mockReturnValue({ disponible: true, motivo: null });
  buscarHibrido.mockResolvedValue({ chunks: [], candidatosVec: 0, candidatosFts: 0, escaneoExacto: true });
  elegirDocumentoParaCita.mockResolvedValue(null);
  estadoExpediente.mockResolvedValue([]);
  responder.mockReset().mockResolvedValue({ texto: 'respuesta', uso: { tokensIn: 10, tokensOut: 5, estimado: false } });
  // Todo encendido salvo HyDE, que arranca apagado (migración 026): sumaría una llamada al modelo.
  leerBooleano.mockReset().mockImplementation((clave: string) => Promise.resolve(clave !== 'chat.hyde.activo'));
  ejecutarListado.mockReset();
  ejecutarUltimoDocumento.mockReset();
  ejecutarParticipantes.mockReset();
  agruparPorObra.mockReset();
  metaConjunto = null;
  planificar.mockReset().mockImplementation((_prov: unknown, mensaje: string) => Promise.resolve({
    plan: planDeRespaldoReal(mensaje), uso: null, respaldo: false, ms: 1,
  }));
});

const { planDeRespaldo: planDeRespaldoReal } = jest.requireActual(
  '../../../../src/compartido/rag/planificadorService',
) as typeof import('../../../../src/compartido/rag/planificadorService');

const UN_CHUNK = {
  chunks: [{ chunkId: 1, texto: 'texto A', rutaTitulos: null, ord: 0, sha256: 'sha-a', score: 1 }],
  candidatosVec: 0, candidatosFts: 1, escaneoExacto: true,
};

function peticionBase(over: Partial<Parameters<ChatSvc['responderChat']>[0]> = {}) {
  return {
    usuarioId: 'u1',
    sinRestriccionDependencia: true,
    coDependencia: null,
    modo: 'general' as const,
    mensaje: '¿en qué estado está el trámite?',
    ...over,
  };
}

describe('responderChat', () => {
  it('rechaza sin tocar la BD si el chat no está disponible', async () => {
    chatDisponible.mockReturnValue({ disponible: false, motivo: 'ANTHROPIC_API_KEY: falta' });

    await expect(chat.responderChat(peticionBase())).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(query).not.toHaveBeenCalled();
  });

  it('rechaza un mensaje vacío', async () => {
    await expect(chat.responderChat(peticionBase({ mensaje: '   ' }))).rejects.toThrow(/mensaje/);
  });

  it('pasa coDependencia=null cuando el usuario no tiene restricción (admin/jefe)', async () => {
    await chat.responderChat(peticionBase({ sinRestriccionDependencia: true, coDependencia: '00104' }));
    expect(buscarHibrido.mock.calls[0][1]).toEqual({ coDependencia: null });
  });

  it('filtra por la propia dependencia cuando el usuario SÍ tiene restricción — el filtro más importante del diseño', async () => {
    await chat.responderChat(peticionBase({ sinRestriccionDependencia: false, coDependencia: '00104' }));
    expect(buscarHibrido.mock.calls[0][1]).toEqual({ coDependencia: '00104' });
  });

  it('rechaza si la sesión indicada pertenece a otro usuario', async () => {
    query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, usuario_id, modo')) {
        return Promise.resolve([{ id: 42, usuario_id: 'OTRO-USUARIO', modo: 'general', nu_ann_exp: null, nu_sec_exp: null }]);
      }
      return Promise.resolve(undefined);
    });

    await expect(chat.responderChat(peticionBase({ sesionId: 42 }))).rejects.toMatchObject({ status: 403 });
  });

  it('persiste las citas ANTES de llamar al proveedor de chat', async () => {
    buscarHibrido.mockResolvedValue({
      chunks: [{ chunkId: 1, texto: 'texto A', rutaTitulos: null, ord: 0, sha256: 'sha-a', score: 1 }],
      candidatosVec: 0, candidatosFts: 1, escaneoExacto: true,
    });
    elegirDocumentoParaCita.mockResolvedValue({ id: 501, nuAnn: '2026', nuEmi: '0000000123', nuAne: 0 });
    responder.mockImplementation(() => {
      ordenLlamadas.push('llamar-proveedor');
      return Promise.resolve({ texto: 'ok [D1]', uso: { tokensIn: 1, tokensOut: 1, estimado: false } });
    });

    await chat.responderChat(peticionBase());

    expect(ordenLlamadas).toEqual(['crear-mensaje-pendiente', 'insert-cita', 'llamar-proveedor']);
  });

  it('programa el juicio del turno con la pregunta, la respuesta y los fragmentos que vio el modelo', async () => {
    programarJuicio.mockReset();
    buscarHibrido.mockResolvedValue(UN_CHUNK);
    elegirDocumentoParaCita.mockResolvedValue({ id: 501, nuAnn: '2026', nuEmi: '0000000123', nuAne: 0 });
    responder.mockResolvedValue({ texto: 'la respuesta [D1]', uso: { tokensIn: 1, tokensOut: 1, estimado: false } });

    const r = await chat.responderChat(peticionBase({ mensaje: '¿cuál es el monto?' }));

    expect(programarJuicio).toHaveBeenCalledTimes(1);
    expect(programarJuicio.mock.calls[0][0]).toMatchObject({
      modulo: 'sgd', mensajeId: r.mensajeId, sesionId: r.sesionId, pregunta: '¿cuál es el monto?',
      respuesta: 'la respuesta [D1]', fragmentos: [{ numero: 1, texto: 'texto A' }],
    });
    expect(programarJuicio.mock.calls[0][0].trazaId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('limpia marcadores [Dn] inventados y cuenta la métrica de alucinación, conservando los reales', async () => {
    buscarHibrido.mockResolvedValue({
      chunks: [{ chunkId: 1, texto: 'texto real', rutaTitulos: null, ord: 0, sha256: 'sha-a', score: 1 }],
      candidatosVec: 0, candidatosFts: 1, escaneoExacto: true,
    });
    elegirDocumentoParaCita.mockResolvedValue({ id: 501, nuAnn: '2026', nuEmi: '0000000123', nuAne: 0 });
    responder.mockResolvedValue({
      texto: 'Según [D1], el trámite avanza. También según [D99], algo inventado.',
      uso: { tokensIn: 1, tokensOut: 1, estimado: false },
    });

    const resultado = await chat.responderChat(peticionBase());

    expect(resultado.texto).toContain('[D1]');
    expect(resultado.texto).not.toContain('[D99]');
    expect(resultado.marcadoresAlucinados).toBe(1);
    expect(resultado.citas.find((c) => c.numero === 1)?.usada).toBe(true);
  });

  it('si el proveedor de chat falla, el turno queda FALLIDO con sus citas (no se borra) y el error es reintentable', async () => {
    buscarHibrido.mockResolvedValue(UN_CHUNK);
    elegirDocumentoParaCita.mockResolvedValue({ id: 501, nuAnn: '2026', nuEmi: '0000000123', nuAne: 0 });
    responder.mockRejectedValue(new Error('el proveedor no respondió'));

    const error = await chat.responderChat(peticionBase()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(chat.ChatError);
    expect(error).toMatchObject({
      status: 502,
      datos: { mensajeFallidoId: 99, reintentable: true, detalle: 'el proveedor no respondió' },
    });
    expect(ordenLlamadas).toEqual(['crear-mensaje-pendiente', 'insert-cita', 'marcar-fallido']);
    const fallido = query.mock.calls.find(([sql]) => String(sql).includes("SET estado = 'fallido'"))!;
    expect(JSON.parse(fallido[1].bind[1])).toMatchObject({
      fallo: { error: 'el proveedor no respondió' },
      retrieval: { candidatosVec: 0, candidatosFts: 1, fusionados: 1, escaneoExacto: true },
    });
  });

  it('la respuesta recibe la pregunta UNA sola vez (antes llegaba duplicada vía historial)', async () => {
    buscarHibrido.mockResolvedValue(UN_CHUNK);
    elegirDocumentoParaCita.mockResolvedValue({ id: 501, nuAnn: '2026', nuEmi: '0000000123', nuAne: 0 });
    const original = query.getMockImplementation()!;
    // El historial se lee ANTES de guardar la pregunta: si se leyera después, traería la pregunta.
    let preguntaGuardada = false;
    query.mockImplementation((sql: string, opts: unknown) => {
      if (sql.includes("VALUES ($1, 'user', $2)")) preguntaGuardada = true;
      if (sql.includes('rol, texto FROM rag.chat_mensaje')) {
        return Promise.resolve(preguntaGuardada ? [{ rol: 'user', texto: '¿en qué estado está el trámite?' }] : []);
      }
      return original(sql, opts);
    });

    await chat.responderChat(peticionBase());

    const mensajes = responder.mock.calls.at(-1)![0] as { rol: string; contenido: string }[];
    expect(mensajes.filter((m) => m.contenido === '¿en qué estado está el trámite?')).toHaveLength(1);
  });

  it('el historial excluye turnos fallidos', async () => {
    buscarHibrido.mockResolvedValue(UN_CHUNK);
    elegirDocumentoParaCita.mockResolvedValue({ id: 501, nuAnn: '2026', nuEmi: '0000000123', nuAne: 0 });

    await chat.responderChat(peticionBase());

    const historial = query.mock.calls.find(([sql]) => String(sql).includes('rol, texto FROM rag.chat_mensaje'))!;
    expect(String(historial[0])).toContain("estado = 'ok'");
  });
});

describe('reintentarRespuesta', () => {
  const usuario = { usuarioId: 'u1', sinRestriccionDependencia: false, coDependencia: '00104' };
  const fila = (over: Record<string, unknown> = {}) => ({
    id: 99, sesion_id: 42, estado: 'fallido', traza_id: 'a'.repeat(32), usuario_id: 'u1',
    modo: 'general', nu_ann_exp: null, nu_sec_exp: null,
    meta: { retrieval: { candidatosVec: 40, candidatosFts: 50, fusionados: 1, escaneoExacto: false } },
    ...over,
  });

  function instalarReintento(over: Record<string, unknown> = {}, citas: unknown[] = [{
    numero: 1, chunk_id: 1, documento_id: 501, nu_ann: '2026', nu_emi: '0000000123', nu_ane: 0,
    texto: 'texto guardado', ruta_titulos: null,
  }]) {
    const original = query.getMockImplementation()!;
    query.mockImplementation((sql: string, opts: unknown) => {
      if (sql.includes('FROM rag.chat_mensaje m') && sql.includes('JOIN rag.chat_sesion s')) return Promise.resolve([fila(over)]);
      if (sql.includes("rol = 'user' AND id < $2")) return Promise.resolve([{ id: 98, texto: 'pregunta original' }]);
      if (sql.includes('FROM rag.cita ci')) return Promise.resolve(citas);
      return original(sql, opts);
    });
  }

  it('responde con las citas guardadas, sin volver a planificar ni a buscar', async () => {
    instalarReintento();
    responder.mockResolvedValue({ texto: 'ahora sí [D1]', uso: { tokensIn: 5, tokensOut: 3, estimado: false } });

    const r = await chat.reintentarRespuesta(99, usuario);

    expect(r).toMatchObject({ sesionId: 42, mensajeId: 99, tipo: 'texto', texto: 'ahora sí [D1]', candidatosVec: 40 });
    expect(r.citas[0]).toMatchObject({ numero: 1, documentoId: 501, usada: true });
    expect(planificar).not.toHaveBeenCalled();
    expect(buscarHibrido).not.toHaveBeenCalled();
    const mensajes = responder.mock.calls[0][0] as { rol: string; contenido: string }[];
    expect(mensajes.at(-1)).toEqual({ rol: 'user', contenido: 'pregunta original' });
    expect(mensajes[0].contenido).toContain('texto guardado');
    // Las citas se re-filtran con los permisos ACTUALES del usuario.
    const citas = query.mock.calls.find(([sql]) => String(sql).includes('FROM rag.cita ci'))!;
    expect(citas[1].bind).toEqual([99, '00104']);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("estado = 'ok' WHERE id = $1"))).toBe(true);
  });

  it('rechaza un mensaje ajeno, inexistente o que no está fallido', async () => {
    instalarReintento({ usuario_id: 'OTRO' });
    await expect(chat.reintentarRespuesta(99, usuario)).rejects.toMatchObject({ status: 403 });

    instalarReintento({ estado: 'ok' });
    await expect(chat.reintentarRespuesta(99, usuario)).rejects.toMatchObject({ status: 409 });

    query.mockImplementation(() => Promise.resolve([]));
    await expect(chat.reintentarRespuesta(99, usuario)).rejects.toMatchObject({ status: 404 });
    expect(responder).not.toHaveBeenCalled();
  });

  it('si ya no queda ninguna cita visible, pide rehacer la pregunta en vez de responder sin contexto', async () => {
    instalarReintento({}, []);
    await expect(chat.reintentarRespuesta(99, usuario)).rejects.toMatchObject({ status: 409 });
    expect(responder).not.toHaveBeenCalled();
  });

  it('si vuelve a fallar, sigue fallido y reintentable', async () => {
    instalarReintento();
    responder.mockRejectedValue(new Error('otra vez caído'));

    await expect(chat.reintentarRespuesta(99, usuario)).rejects.toMatchObject({
      status: 502, datos: { mensajeFallidoId: 99, reintentable: true },
    });
    expect(ordenLlamadas).toContain('marcar-fallido');
  });
});

describe('responderChat — traza', () => {
  afterEach(() => registrarPublicador(null));

  it('publica una traza con usuario, sesión, mensaje y el paso de respuesta', async () => {
    const publicadas: Traza[] = [];
    registrarPublicador(async (t) => { publicadas.push(t); });
    buscarHibrido.mockResolvedValue(UN_CHUNK);
    elegirDocumentoParaCita.mockResolvedValue({ id: 501, nuAnn: '2026', nuEmi: '0000000123', nuAne: 0 });

    await chat.responderChat(peticionBase());
    await new Promise((r) => setImmediate(r));

    expect(publicadas).toHaveLength(1);
    const t = publicadas[0];
    expect(t).toMatchObject({ modulo: 'sgd', usuarioId: 'u1', sesionId: 42, mensajeId: 99, estado: 'ok' });
    expect(t.pasos.map((p) => p.nombre)).toContain('respuesta');
    // El mensaje y el log del retrieval quedan enlazados a la traza.
    const pendiente = query.mock.calls.find(([sql]) => String(sql).includes("VALUES ($1, 'assistant', '', $2)"))!;
    expect(pendiente[1].bind[1]).toBe(t.id);
  });

  it('un turno que falla también se publica, con estado de error', async () => {
    const publicadas: Traza[] = [];
    registrarPublicador(async (t) => { publicadas.push(t); });
    buscarHibrido.mockResolvedValue(UN_CHUNK);
    elegirDocumentoParaCita.mockResolvedValue({ id: 501, nuAnn: '2026', nuEmi: '0000000123', nuAne: 0 });
    responder.mockRejectedValue(new Error('caído'));

    await chat.responderChat(peticionBase()).catch(() => undefined);
    await new Promise((r) => setImmediate(r));

    expect(publicadas[0]).toMatchObject({ estado: 'error' });
    expect(publicadas[0].pasos.find((p) => p.nombre === 'respuesta')).toMatchObject({ nivel: 'ERROR', error: 'caído' });
  });
});

describe('responderChat — cierre con mensajes fijos', () => {
  it('un saludo se contesta con el mensaje de ayuda sin planificador, búsqueda ni modelo', async () => {
    const r = await chat.responderChat(peticionBase({ mensaje: '¡Hola!' }));

    expect(r.tipo).toBe('fijo');
    expect(r.texto).toMatch(/base de conocimiento/);
    expect(r.citas).toEqual([]);
    expect(planificar).not.toHaveBeenCalled();
    expect(buscarHibrido).not.toHaveBeenCalled();
    expect(responder).not.toHaveBeenCalled();
    expect(ordenLlamadas).toEqual(['guardar-fijo']);
  });

  it('fuera de alcance según el planificador → mensaje fijo, sin búsqueda ni respuesta del modelo', async () => {
    planificar.mockResolvedValue({
      plan: { ...planDeRespaldoReal('capital de Francia'), intencion: 'fuera_de_alcance' },
      uso: { tokensIn: 300, tokensOut: 40, estimado: false }, respaldo: false, ms: 5,
    });

    const r = await chat.responderChat(peticionBase({ mensaje: '¿Cuál es la capital de Francia?' }));

    expect(r.tipo).toBe('fijo');
    expect(r.texto).toMatch(/no es sobre la información/);
    expect(buscarHibrido).not.toHaveBeenCalled();
    expect(responder).not.toHaveBeenCalled(); // el mock de planificar no usa el proveedor
  });

  it('sin fragmentos ni línea de tiempo → "no encontré", sin llamar al modelo', async () => {
    const r = await chat.responderChat(peticionBase({ mensaje: 'monto del contrato de la obra Junín' }));

    expect(r.tipo).toBe('fijo');
    expect(r.texto).toMatch(/No encontré/);
    expect(responder).not.toHaveBeenCalled();
    expect(ordenLlamadas).toEqual(['guardar-fijo']);
  });

  it('en modo expediente, la línea de tiempo basta para responder aunque no haya fragmentos', async () => {
    estadoExpediente.mockResolvedValue([{ fecha: '01/01/2026', tipoDocumento: 'OFICIO', numeroDocumento: '1',
      asunto: 'x', dependenciaEmisora: 'A', dependenciaDestino: 'B', estado: 'RECIBIDO' }]);

    const r = await chat.responderChat(peticionBase({
      modo: 'expediente', expediente: { nuAnnExp: '2026', nuSecExp: '0000000001' },
    }));

    expect(r.tipo).toBe('texto');
    expect(responder).toHaveBeenCalledTimes(1);
  });

  it('con el planificador apagado no se llama y la pregunta va a la búsqueda de contenido', async () => {
    leerBooleano.mockResolvedValue(false);
    buscarHibrido.mockResolvedValue(UN_CHUNK);
    elegirDocumentoParaCita.mockResolvedValue({ id: 501, nuAnn: '2026', nuEmi: '0000000123', nuAne: 0 });

    const r = await chat.responderChat(peticionBase());

    expect(planificar).not.toHaveBeenCalled();
    expect(r.tipo).toBe('texto');
  });
});

describe('responderChat — listar / contar', () => {
  const planListar = (intencion: 'listar' | 'contar') => ({
    plan: { ...planDeRespaldoReal('expedientes de Junín'), intencion }, uso: null, respaldo: false, ms: 1,
  });
  const tabla = { filas: [], pagina: 1, porPagina: 10, total: 3, nivel1: 1, nivel2: 2, hayMas: false };

  it('responde con tabla, sin búsqueda de contenido ni modelo de respuesta', async () => {
    planificar.mockResolvedValue(planListar('listar'));
    ejecutarListado.mockResolvedValue({ texto: 'Encontré 3 expedientes…', tabla, meta: { version: 1, busqueda: { total: 3 } } });

    const r = await chat.responderChat(peticionBase({ mensaje: 'dame los expedientes de Junín' }));

    expect(r.tipo).toBe('tabla');
    expect(r.tabla).toEqual(tabla);
    expect(ejecutarListado).toHaveBeenCalledWith('listar', expect.anything(), { coDependencia: null }, {});
    expect(buscarHibrido).not.toHaveBeenCalled();
    expect(responder).not.toHaveBeenCalled();
    expect(ordenLlamadas).toEqual(['guardar-tabla']);
  });

  it('pasa el filtro de dependencia del usuario restringido a la búsqueda de expedientes', async () => {
    planificar.mockResolvedValue(planListar('contar'));
    ejecutarListado.mockResolvedValue({ texto: 'Hay 3…', tabla, meta: { version: 1, busqueda: { total: 3 } } });

    await chat.responderChat(peticionBase({ sinRestriccionDependencia: false, coDependencia: '00104' }));
    expect(ejecutarListado).toHaveBeenCalledWith('contar', expect.anything(), { coDependencia: '00104' }, {});
  });

  it('sin expedientes → mensaje fijo de "no encontré"', async () => {
    planificar.mockResolvedValue(planListar('listar'));
    ejecutarListado.mockResolvedValue(null);

    const r = await chat.responderChat(peticionBase());
    expect(r.tipo).toBe('fijo');
    expect(r.texto).toMatch(/No encontré/);
  });

  it('en modo expediente, "listar" no usa la tabla: sigue a la búsqueda de contenido', async () => {
    planificar.mockResolvedValue(planListar('listar'));

    await chat.responderChat(peticionBase({ modo: 'expediente', expediente: { nuAnnExp: '2026', nuSecExp: '0000000001' } }));
    expect(ejecutarListado).not.toHaveBeenCalled();
    expect(buscarHibrido).toHaveBeenCalled();
  });
});

describe('responderChat — contexto de la conversación', () => {
  const meta = {
    version: 1,
    expedientes: [
      { a: '2026', s: '0000000001', n: 1, dm: 1, dc: 0, r: false, t: 1, bm: 1, bc: 0 },
      { a: '2026', s: '0000000002', n: 2, dm: 0, dc: 3, r: false, t: 1, bm: 0, bc: 1 },
    ],
  };
  const conjunto = [{ nuAnnExp: '2026', nuSecExp: '0000000001' }, { nuAnnExp: '2026', nuSecExp: '0000000002' }];
  const plan = (over: Record<string, unknown>) => ({
    plan: { ...planDeRespaldoReal('x'), ...over }, uso: null, respaldo: false, ms: 1,
  });

  it('busca con la consulta reescrita, no con el texto literal', async () => {
    planificar.mockResolvedValue(plan({ consulta: 'último documento de controversia de la obra Huancavelica' }));

    await chat.responderChat(peticionBase({ mensaje: '¿y el último?' }));
    expect(buscarHibrido.mock.calls[0][0]).toBe('último documento de controversia de la obra Huancavelica');
  });

  it('"de esos" filtra el listado dentro del conjunto anterior', async () => {
    metaConjunto = meta;
    planificar.mockResolvedValue(plan({ intencion: 'listar', continuaAnterior: true }));
    ejecutarListado.mockResolvedValue(null);

    await chat.responderChat(peticionBase({ mensaje: 'de esos, ¿cuáles tienen penalidades?' }));
    expect(ejecutarListado).toHaveBeenCalledWith('listar', expect.anything(), { coDependencia: null }, { dentroDe: conjunto });
  });

  it('una pregunta de contenido que continúa acota la búsqueda al conjunto', async () => {
    metaConjunto = meta;
    planificar.mockResolvedValue(plan({ consulta: 'monto de penalidades', continuaAnterior: true }));

    await chat.responderChat(peticionBase({ mensaje: '¿y cuánto suman las penalidades ahí?' }));
    expect(buscarHibrido.mock.calls[0].slice(0, 4)).toEqual(['monto de penalidades', { coDependencia: null }, undefined, conjunto]);
  });

  it('un tema nuevo ignora el listado anterior', async () => {
    metaConjunto = meta;
    planificar.mockResolvedValue(plan({ intencion: 'listar', continuaAnterior: false }));
    ejecutarListado.mockResolvedValue(null);

    await chat.responderChat(peticionBase({ mensaje: 'expedientes de Ayacucho' }));
    expect(ejecutarListado).toHaveBeenCalledWith('listar', expect.anything(), { coDependencia: null }, {});
  });

  it('con el plan de respaldo no se confía en la reescritura ni en el conjunto', async () => {
    metaConjunto = meta;
    planificar.mockResolvedValue({ ...plan({ consulta: 'otra cosa', continuaAnterior: true }), respaldo: true });

    await chat.responderChat(peticionBase({ mensaje: 'texto original' }));
    // Sin plan confiable no hay subconsultas ni HyDE; el vocabulario sí (no depende del modelo).
    expect(buscarHibrido.mock.calls[0]).toEqual([
      'texto original', { coDependencia: null }, undefined, undefined, undefined,
      { consultaVectorial: 'texto original', textoHyde: null },
    ]);
  });

  it('la rama FTS recibe los términos del plan, no la consulta reescrita entera', async () => {
    planificar.mockResolvedValue(plan({
      consulta: 'qué dicen sobre la resolución del contrato de la obra de Junín',
      terminos: { obligatorios: ['resolución', 'contrato', 'Junín'], opcionales: [] },
    }));

    await chat.responderChat(peticionBase({ mensaje: '¿qué dicen sobre la resolución del contrato?' }));
    expect(buscarHibrido.mock.calls[0][4]).toEqual(['resolución', 'contrato', 'Junín']);
  });

  it('pregunta compuesta: busca la consulta completa y cada subconsulta, y fusiona lo encontrado', async () => {
    planificar.mockResolvedValue(plan({
      consulta: 'plazo y penalidades de la obra de Junín',
      subconsultas: ['plazo de ejecución de la obra de Junín', 'penalidades aplicadas en la obra de Junín'],
    }));
    const chunkDe = (id: number) => ({ chunkId: id, texto: `t${id}`, rutaTitulos: null, ord: 0, sha256: `s${id}`, score: 1 });
    buscarHibrido.mockImplementation((q: string) => Promise.resolve({
      chunks: q.startsWith('plazo de') ? [chunkDe(2)] : q.startsWith('penalidades') ? [chunkDe(3)] : [chunkDe(1)],
      candidatosVec: 1, candidatosFts: 1, escaneoExacto: false,
    }));
    elegirDocumentoParaCita.mockResolvedValue({ id: 501, nuAnn: '2026', nuEmi: '0000000123', nuAne: 0 });

    const r = await chat.responderChat(peticionBase({ mensaje: '¿plazo y penalidades de Junín?' }));

    expect(buscarHibrido.mock.calls.map((c) => c[0])).toEqual([
      'plazo y penalidades de la obra de Junín', 'plazo de ejecución de la obra de Junín', 'penalidades aplicadas en la obra de Junín',
    ]);
    // Cada subconsulta busca en la FTS con sus propias palabras, no con los términos de toda la pregunta.
    expect(buscarHibrido.mock.calls[1][4]).toEqual(['plazo', 'ejecucion', 'junin']);
    expect(r.citas.map((c) => c.chunkId).sort()).toEqual([1, 2, 3]);
  });

  it('con chat.descomposicion.activa apagado se ignoran las subconsultas', async () => {
    leerBooleano.mockImplementation((clave: string) => Promise.resolve(clave === 'chat.planificador.activo'));
    planificar.mockResolvedValue(plan({ consulta: 'q', subconsultas: ['a', 'b'] }));

    await chat.responderChat(peticionBase());

    expect(buscarHibrido).toHaveBeenCalledTimes(1);
  });

  it('con chat.hyde.activo, el párrafo hipotético va a la búsqueda y sus tokens a uso_token', async () => {
    leerBooleano.mockResolvedValue(true);
    planificar.mockResolvedValue(plan({ consulta: 'penalidad por atraso en la obra de Junín' }));
    const parrafo = 'Se aplica la penalidad por mora de S/ 15 000,00 equivalente a diez días calendario de atraso en la obra.';
    responder.mockImplementation((mensajes: { rol: string; contenido: string }[]) => Promise.resolve({
      texto: mensajes[0].contenido.startsWith('Escribes UN párrafo') ? parrafo : 'respuesta',
      uso: { tokensIn: 10, tokensOut: 5, estimado: false },
    }));

    await chat.responderChat(peticionBase());

    expect(buscarHibrido.mock.calls[0][5]).toEqual({ consultaVectorial: 'penalidad por atraso en la obra de Junín', textoHyde: parrafo });
    const usos = query.mock.calls.filter(([sql]) => String(sql).includes('rag.uso_token'));
    expect(usos.some(([, o]) => (o as { bind: unknown[] }).bind.includes('chat_hyde'))).toBe(true);
  });

  it('recorta las respuestas largas del asistente al reenviarlas como historial', async () => {
    buscarHibrido.mockResolvedValue(UN_CHUNK);
    elegirDocumentoParaCita.mockResolvedValue({ id: 501, nuAnn: '2026', nuEmi: '0000000123', nuAne: 0 });
    const largo = 'x'.repeat(2000);
    const original = query.getMockImplementation()!;
    query.mockImplementation((sql: string, opts: unknown) => (sql.includes('rol, texto FROM rag.chat_mensaje')
      ? Promise.resolve([{ rol: 'assistant', texto: largo }, { rol: 'user', texto: 'pregunta previa' }])
      : original(sql, opts)));

    await chat.responderChat(peticionBase());

    const mensajes = responder.mock.calls.at(-1)![0] as { rol: string; contenido: string }[];
    const previo = mensajes.find((m) => m.rol === 'assistant')!;
    expect(previo.contenido.length).toBeLessThanOrEqual(701);
    expect(mensajes.find((m) => m.contenido === 'pregunta previa')).toBeDefined();
  });
});

describe('responderChat — último documento, participantes y agrupar', () => {
  const plan = (intencion: string, over: Record<string, unknown> = {}) => ({
    plan: { ...planDeRespaldoReal('x'), intencion, ...over }, uso: null, respaldo: false, ms: 1,
  });
  const expediente = { nuAnnExp: '2026', nuSecExp: '0000000001' };

  it('último documento → tarjeta sin modelo de respuesta', async () => {
    planificar.mockResolvedValue(plan('ultimo_documento'));
    const documento = { nuAnn: '2026', nuEmi: '1', titulo: 'OFICIO N° 1', indicaciones: [] };
    ejecutarUltimoDocumento.mockResolvedValue({ texto: 'El documento más reciente…', documento, meta: { kind: 'documento' } });

    const r = await chat.responderChat(peticionBase({ mensaje: 'dame el último documento de controversia' }));

    expect(r.tipo).toBe('documento');
    expect(r.documento).toEqual(documento);
    expect(responder).not.toHaveBeenCalled();
    expect(ordenLlamadas).toEqual(['guardar-documento']);
  });

  it('en modo expediente, último documento y participantes operan sobre ese expediente', async () => {
    planificar.mockResolvedValue(plan('participantes'));
    ejecutarParticipantes.mockResolvedValue({ texto: 'Participaron…', participantes: { totalExpedientes: 1 }, meta: {} });

    const r = await chat.responderChat(peticionBase({ modo: 'expediente', expediente }));

    expect(r.tipo).toBe('participantes');
    expect(ejecutarParticipantes).toHaveBeenCalledWith(expect.anything(), { coDependencia: null }, { expediente, conjunto: null });
  });

  it('participantes que continúan usan el conjunto activo', async () => {
    metaConjunto = { version: 1, expedientes: [{ a: '2026', s: '0000000009', n: 1, dm: 0, dc: 0, r: false, t: 0, bm: 0, bc: 0 }] };
    planificar.mockResolvedValue(plan('participantes', { continuaAnterior: true }));
    ejecutarParticipantes.mockResolvedValue(null);

    const r = await chat.responderChat(peticionBase({ mensaje: '¿quiénes participaron en esos?' }));

    expect(ejecutarParticipantes).toHaveBeenCalledWith(expect.anything(), { coDependencia: null }, {
      expediente: undefined, conjunto: [{ nuAnnExp: '2026', nuSecExp: '0000000009' }],
    });
    expect(r.tipo).toBe('fijo'); // sin datos → "no encontré"
  });

  it('agrupar: grupos por contrato sin modelo, respondido como tabla', async () => {
    planificar.mockResolvedValue(plan('agrupar', { consulta: '¿qué obras tienen controversias?' }));
    const tabla = { filas: [], pagina: 1, porPagina: 10, total: 2, nivel1: 1, nivel2: 1, hayMas: false };
    ejecutarListado.mockResolvedValue({ texto: 'Encontré 2 expedientes…', tabla, meta: { version: 1, busqueda: { total: 2 }, expedientes: [] } });
    agruparPorObra.mockResolvedValue({
      texto: '- Laboratorios de Camélidos (contrato 341-2025-MCEBS): 2026-0000001 (en trámite)',
      grupos: [], agrupados: 1, soloDirectos: true,
    });

    const r = await chat.responderChat(peticionBase({ mensaje: '¿qué obras tienen controversias?' }));

    expect(r.tipo).toBe('tabla');
    expect(r.texto).toContain('Encontré 2 expedientes…');
    expect(r.texto).toContain('Agrupé por obra los 1 que coinciden directamente');
    expect(r.texto).toContain('- Laboratorios de Camélidos (contrato 341-2025-MCEBS): 2026-0000001 (en trámite)');
    expect(responder).not.toHaveBeenCalled();
    expect(buscarHibrido).not.toHaveBeenCalled();
  });
});

describe('limpiarMarcadores', () => {
  it('conserva un marcador válido y elimina uno inventado, contando cada uno', () => {
    const r = chat.limpiarMarcadores('texto [D1] y [D7] inventado', [{ numero: 1 }]);
    expect(r.texto).toBe('texto [D1] y  inventado');
    expect(r.numerosUsados).toEqual([1]);
    expect(r.marcadoresInvalidos).toEqual([7]);
  });

  it('sin ningún marcador en el texto, no hay usados ni inválidos', () => {
    const r = chat.limpiarMarcadores('respuesta sin citas', [{ numero: 1 }, { numero: 2 }]);
    expect(r.texto).toBe('respuesta sin citas');
    expect(r.numerosUsados).toEqual([]);
    expect(r.marcadoresInvalidos).toEqual([]);
  });
});

describe('extractoDeChunk', () => {
  it('quita los encabezados markdown y colapsa los saltos en una sola línea', () => {
    const chunk = '# DIRECCIÓN EJECUTIVA\n\nPROVEIDO 000225-2026\n\n## EXPEDIENTE : DE0000';
    expect(chat.extractoDeChunk(chunk)).toBe(
      'DIRECCIÓN EJECUTIVA PROVEIDO 000225-2026 EXPEDIENTE : DE0000',
    );
  });

  it('corta con elipsis al pasar del límite y no la añade si cabe entero', () => {
    expect(chat.extractoDeChunk('a'.repeat(50), 20)).toBe(`${'a'.repeat(20)}…`);
    expect(chat.extractoDeChunk('cabe entero', 20)).toBe('cabe entero');
  });

  it('un "#" que no abre encabezado se conserva — es parte del texto del documento', () => {
    expect(chat.extractoDeChunk('Oficio N# 12 del área')).toBe('Oficio N# 12 del área');
  });
});
