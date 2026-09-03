/**
 * Orquestación de `chatService.ts`, aislada con mocks — igual que `ingestaService.test.ts`: lo
 * que vale la pena aislar aquí es la lógica de control (disponibilidad, propiedad de la sesión,
 * orden citas-antes-que-modelo, limpieza de marcadores inventados, deshacer en caso de fallo),
 * no reimplementar en un mock el SQL de `retrievalService.ts`, que se verificó contra la BD real.
 */

const chatDisponible = jest.fn();
const responder = jest.fn();
const buscarHibrido = jest.fn();
const elegirDocumentoParaCita = jest.fn();
const estadoExpediente = jest.fn();
const query = jest.fn();
const ordenLlamadas: string[] = [];

jest.mock('../../src/ai/providerFactory', () => ({
  chatDisponible: (...a: unknown[]) => chatDisponible(...a),
  crearChatProvider: () => ({ nombre: 'ollama', modelo: 'llama3', responder: (...a: unknown[]) => responder(...a) }),
}));

jest.mock('../../src/rag/retrievalService', () => ({
  buscarHibrido: (...a: unknown[]) => buscarHibrido(...a),
  elegirDocumentoParaCita: (...a: unknown[]) => elegirDocumentoParaCita(...a),
  estadoExpediente: (...a: unknown[]) => estadoExpediente(...a),
  recortarPorPresupuesto: (chunks: unknown[]) => chunks, // sin recorte: se prueba aparte, es pura
}));

jest.mock('../../src/config/appDatabase', () => ({
  appSequelize: { query: (...a: unknown[]) => query(...a) },
}));

type ChatSvc = typeof import('../../src/rag/chatService');
let chat: ChatSvc;

beforeAll(() => {
  jest.isolateModules(() => {
    chat = require('../../src/rag/chatService');
  });
});

/** Enruta cada `query` por el texto del SQL, no por posición: más robusto a reordenar el código. */
function instalarQueryPorDefecto() {
  query.mockReset();
  ordenLlamadas.length = 0;

  query.mockImplementation((sql: string) => {
    if (sql.includes('SELECT id, usuario_id, modo')) {
      return Promise.resolve([{ id: 42, usuario_id: 'u1', modo: 'general', nu_ann_exp: null, nu_sec_exp: null }]);
    }
    if (sql.includes('INSERT INTO rag.chat_sesion')) {
      return Promise.resolve([{ id: 42, usuario_id: 'u1', modo: 'general', nu_ann_exp: null, nu_sec_exp: null }]);
    }
    if (sql.includes("rol, texto FROM rag.chat_mensaje")) {
      return Promise.resolve([]); // sin historial previo
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
});

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
    expect(buscarHibrido).toHaveBeenCalledWith(expect.any(String), { coDependencia: null });
  });

  it('filtra por la propia dependencia cuando el usuario SÍ tiene restricción — el filtro más importante del diseño', async () => {
    await chat.responderChat(peticionBase({ sinRestriccionDependencia: false, coDependencia: '00104' }));
    expect(buscarHibrido).toHaveBeenCalledWith(expect.any(String), { coDependencia: '00104' });
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

  it('si el proveedor de chat falla, borra el mensaje pendiente en vez de dejarlo huérfano', async () => {
    responder.mockRejectedValue(new Error('el proveedor no respondió'));

    await expect(chat.responderChat(peticionBase())).rejects.toThrow('el proveedor no respondió');
    expect(ordenLlamadas).toEqual(['crear-mensaje-pendiente', 'borrar-mensaje-pendiente']);
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
