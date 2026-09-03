/**
 * Guardas de `transcribirDocumento` — la ruta de pago del sistema. Cada una existe para que un
 * clic no pueda gastar un token por accidente: sin clave, sobre un documento generable, con un
 * archivo de tipo o tamaño no admitido, o por encima del techo diario. La prueba más importante es
 * la de la colisión de sha256 (al final): sin el espacio de nombres propio, una transcripción
 * buena podría tirarse a la basura en silencio.
 */

import crypto from 'crypto';

const query = jest.fn();
jest.mock('../../src/config/appDatabase', () => ({
  appSequelize: { query: (...a: unknown[]) => query(...a) },
}));

const visionDisponible = jest.fn();
const crearVisionProvider = jest.fn();
jest.mock('../../src/ai/providerFactory', () => ({
  visionDisponible: (...a: unknown[]) => visionDisponible(...a),
  crearVisionProvider: (...a: unknown[]) => crearVisionProvider(...a),
}));

const getDatosDocumentoGenerado = jest.fn();
jest.mock('../../src/services/documentoService', () => ({
  getDatosDocumentoGenerado: (...a: unknown[]) => getDatosDocumentoGenerado(...a),
}));

const filaDeDocumento = jest.fn();
const enlazarSiYaExiste = jest.fn();
const guardarMarkdown = jest.fn();
const obtenerBytesDocumento = jest.fn();
jest.mock('../../src/rag/ingestaService', () => ({
  ...jest.requireActual('../../src/rag/ingestaService'),
  filaDeDocumento: (...a: unknown[]) => filaDeDocumento(...a),
  enlazarSiYaExiste: (...a: unknown[]) => enlazarSiYaExiste(...a),
  guardarMarkdown: (...a: unknown[]) => guardarMarkdown(...a),
  obtenerBytesDocumento: (...a: unknown[]) => obtenerBytesDocumento(...a),
}));

const documentoPorId = jest.fn();
jest.mock('../../src/rag/estadoService', () => ({
  documentoPorId: (...a: unknown[]) => documentoPorId(...a),
}));

import { transcribirDocumento } from '../../src/rag/visionService';
import { ArchivoError } from '../../src/services/storageService';
import { ErrorIA } from '../../src/ai/types';

function filaDocumento(over: Record<string, unknown> = {}) {
  return {
    id: 501, nu_ann: '2026', nu_emi: '0000000501', nu_ane: 0,
    titulo: 'CARTA N° 0031', numero_sgd: '2026-0000123', de_dep_emi: 'OGA',
    fe_emi: '2026-01-01', asunto: 'Asunto', co_tip_doc: '003',
    estado: 'sin_texto', contenido_sha256: 'abc123',
    ...over,
  };
}

function documentoRagFixture(over: Record<string, unknown> = {}) {
  return {
    id: 501, nuAnn: '2026', nuEmi: '0000000501', nuAne: 0, titulo: 'X', tipoDoc: 'CARTA',
    asunto: null, nuAnnExp: '2026', nuSecExp: '0000000001', numeroExpediente: null,
    estado: 'convertido', motivoError: null, intentos: 3, chars: 500, chunksGenerados: 1,
    metodo: 'vision', estadoItem: null, motivoErrorItem: null,
    ...over,
  };
}

function providerFalso(over: Record<string, unknown> = {}) {
  return {
    nombre: 'openai' as const,
    modelo: 'gpt-4o',
    transcribir: jest.fn().mockResolvedValue({
      texto: 'texto transcrito real',
      uso: { tokensIn: 1000, tokensOut: 200, estimado: false },
    }),
    ...over,
  };
}

beforeEach(() => {
  query.mockReset().mockResolvedValue([{ total: '0' }]); // tokensVisionHoy: 0 por defecto
  visionDisponible.mockReset().mockReturnValue({ disponible: true, motivo: null });
  crearVisionProvider.mockReset();
  getDatosDocumentoGenerado.mockReset().mockResolvedValue(null);
  filaDeDocumento.mockReset().mockResolvedValue(filaDocumento());
  enlazarSiYaExiste.mockReset().mockResolvedValue(false);
  guardarMarkdown.mockReset().mockResolvedValue(undefined);
  obtenerBytesDocumento.mockReset().mockResolvedValue({
    buffer: Buffer.from('%PDF-1.4 contenido de prueba'),
    filename: 'documento.pdf',
    origen: 'disco',
  });
  documentoPorId.mockReset().mockResolvedValue(documentoRagFixture());
});

describe('transcribirDocumento — barreras antes de gastar un token', () => {
  it('404 si el documento ya no existe', async () => {
    filaDeDocumento.mockResolvedValue(undefined);

    await expect(transcribirDocumento(999)).rejects.toThrow(/ya no existe/);
    expect(visionDisponible).not.toHaveBeenCalled();
  });

  it('409 sin OPENAI_API_KEY, y el proveedor NUNCA se construye', async () => {
    visionDisponible.mockReturnValue({ disponible: false, motivo: 'OPENAI_API_KEY: falta' });

    await expect(transcribirDocumento(501)).rejects.toThrow(/OPENAI_API_KEY/);
    expect(crearVisionProvider).not.toHaveBeenCalled();
    expect(obtenerBytesDocumento).not.toHaveBeenCalled();
  });

  it('409 al superar el techo diario de tokens, sin construir el proveedor', async () => {
    query.mockResolvedValue([{ total: String(10_000_000) }]);

    await expect(transcribirDocumento(501)).rejects.toThrow(/límite diario/);
    expect(crearVisionProvider).not.toHaveBeenCalled();
  });

  it.each(['convertido', 'ok', 'pendiente', 'no_soportado'])(
    '409 cuando el estado es "%s" — solo sin_texto o error valen',
    async (estado) => {
      filaDeDocumento.mockResolvedValue(filaDocumento({ estado }));

      await expect(transcribirDocumento(501)).rejects.toThrow(/último recurso/);
      expect(crearVisionProvider).not.toHaveBeenCalled();
    },
  );

  it('409 cuando el tipo VIVO del SGD es generable — remite a "Reintentar", sin gastar nada', async () => {
    getDatosDocumentoGenerado.mockResolvedValue({ coTipDoc: '232' });

    await expect(transcribirDocumento(501)).rejects.toThrow(/Reintentar/);
    expect(crearVisionProvider).not.toHaveBeenCalled();
    expect(obtenerBytesDocumento).not.toHaveBeenCalled();
  });

  it('409 cuando no hay archivo digital que extraer', async () => {
    obtenerBytesDocumento.mockRejectedValue(new ArchivoError('no encontrado', 404));

    await expect(transcribirDocumento(501)).rejects.toThrow(/no tiene archivo digital/);
    expect(crearVisionProvider).not.toHaveBeenCalled();
  });

  it('409 con un tipo de archivo no admitido (ni PDF ni imagen)', async () => {
    obtenerBytesDocumento.mockResolvedValue({
      buffer: Buffer.from('PK contenido zip'), filename: 'archivo.zip', origen: 'disco',
    });

    await expect(transcribirDocumento(501)).rejects.toThrow(/no admitido/);
    expect(crearVisionProvider).not.toHaveBeenCalled();
  });

  it('409 cuando el archivo supera el tamaño máximo (20 MB por defecto)', async () => {
    // `RAG_VISION_MAX_BYTES` se lee una sola vez al cargar el módulo, no en cada llamada — igual
    // que en producción, donde se fija por variable de entorno antes de arrancar. Se prueba contra
    // el límite real por defecto en vez de intentar cambiarlo a mitad del test.
    obtenerBytesDocumento.mockResolvedValue({
      buffer: Buffer.alloc(21 * 1024 * 1024), filename: 'grande.pdf', origen: 'disco',
    });

    await expect(transcribirDocumento(501)).rejects.toThrow(/pesa/);
    expect(crearVisionProvider).not.toHaveBeenCalled();
  });
});

describe('transcribirDocumento — idempotencia y la trampa del sha256', () => {
  it('si ya se transcribió con este modelo antes, no llama al proveedor ni gasta tokens', async () => {
    const provider = providerFalso();
    crearVisionProvider.mockReturnValue(provider);
    enlazarSiYaExiste.mockResolvedValue(true);

    const resultado = await transcribirDocumento(501);

    expect(provider.transcribir).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('INSERT INTO rag.uso_token'))).toBe(false);
    expect(resultado.estado).toBe('convertido');
  });

  it('la clave de contenido NUNCA es el sha256 crudo del archivo — evita pisar la fila de markitdown', async () => {
    crearVisionProvider.mockReturnValue(providerFalso());
    const bytes = Buffer.from('%PDF-1.4 contenido de prueba');
    obtenerBytesDocumento.mockResolvedValue({ buffer: bytes, filename: 'documento.pdf', origen: 'disco' });
    const shaCrudo = crypto.createHash('sha256').update(bytes).digest('hex');

    await transcribirDocumento(501);

    expect(enlazarSiYaExiste).toHaveBeenCalledTimes(1);
    const [, shaUsado] = enlazarSiYaExiste.mock.calls[0];
    expect(shaUsado).not.toBe(shaCrudo);

    expect(guardarMarkdown).toHaveBeenCalledTimes(1);
    const [, shaGuardado, , origen] = guardarMarkdown.mock.calls[0];
    expect(shaGuardado).toBe(shaUsado);
    expect(origen.metodo).toBe('vision');
  });

  it('guarda el sha256 anterior antes de repuntar contenido_sha256', async () => {
    crearVisionProvider.mockReturnValue(providerFalso());
    filaDeDocumento.mockResolvedValue(filaDocumento({ contenido_sha256: 'el-anterior' }));

    await transcribirDocumento(501);

    const heal = query.mock.calls.find(([sql]: [string]) => sql.includes('SET sha256_anterior'));
    expect(heal).toBeDefined();
    expect((heal![1] as { bind: unknown[] }).bind).toEqual([501, 'el-anterior']);
  });
});

describe('transcribirDocumento — registro de uso', () => {
  it('registra el uso real con operacion=vision y exito=true tras una transcripción exitosa', async () => {
    const provider = providerFalso();
    crearVisionProvider.mockReturnValue(provider);

    await transcribirDocumento(501);

    const insercion = query.mock.calls.find(([sql]: [string]) => sql.includes('INSERT INTO rag.uso_token'));
    expect(insercion).toBeDefined();
    const [, opciones] = insercion!;
    expect((opciones as { bind: unknown[] }).bind).toEqual(['openai', 'gpt-4o', 1000, 200, false, true]);
  });

  it('registra el intento fallido con exito=false cuando el proveedor rechaza la llamada', async () => {
    const provider = providerFalso({
      transcribir: jest.fn().mockRejectedValue(new ErrorIA('openai: no responde', 'unavailable', 'openai')),
    });
    crearVisionProvider.mockReturnValue(provider);

    await expect(transcribirDocumento(501)).rejects.toThrow(/no responde/);

    const insercion = query.mock.calls.find(([sql]: [string]) => sql.includes('INSERT INTO rag.uso_token'));
    expect(insercion).toBeDefined();
    const [, opciones] = insercion!;
    expect((opciones as { bind: unknown[] }).bind).toEqual(['openai', 'gpt-4o', 0, 0, true, false]);
    expect(guardarMarkdown).not.toHaveBeenCalled();
  });
});
