/**
 * El reproceso corre en segundo plano: lo que importa fijar es que los rechazos lleguen de forma
 * SÍNCRONA (antes de responder 202), que un resultado sin texto no pise el markdown anterior y que
 * cada reproceso escriba un contenido NUEVO aunque se repita el mismo modelo.
 */

jest.mock('../../../src/compartido/ai/providerFactory', () => {
  const real = jest.requireActual('../../../src/compartido/ai/providerFactory');
  return { ...real, crearVisionProvider: jest.fn(), visionDisponible: jest.fn() };
});
jest.mock('../../../src/compartido/ai/providers/ollamaVision', () => ({
  ...jest.requireActual('../../../src/compartido/ai/providers/ollamaVision'),
  modelosOllamaInstalados: jest.fn().mockResolvedValue(['qwen2.5vl:latest', 'bge-m3:latest']),
  modelosOllamaVision: jest.fn().mockResolvedValue(['qwen2.5vl:latest']),
}));

import { crearVisionProvider, visionDisponible } from '../../../src/compartido/ai/providerFactory';
import {
  estadoReproceso,
  iniciarReproceso,
  type AdaptadorReproceso,
  type DocumentoReprocesable,
} from '../../../src/compartido/rag/reprocesoService';

const crearMock = crearVisionProvider as jest.Mock;
const disponibleMock = visionDisponible as jest.Mock;

class ErrorPrueba extends Error {
  constructor(mensaje: string, readonly status: number) {
    super(mensaje);
  }
}

const PDF = Buffer.from('%PDF-1.4 algo');

function adaptador(doc: DocumentoReprocesable | undefined, opciones: { enCola?: boolean } = {}) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('ingest_item')) return opciones.enCola ? [{ job_id: 7 }] : [];
    if (sql.includes('sum(tokens_in')) return [{ total: '0' }];
    return [];
  });
  const guardar = jest.fn().mockResolvedValue(undefined);
  const a: AdaptadorReproceso<DocumentoReprocesable> = {
    modulo: 'sgd',
    sequelize: { query } as never,
    leer: jest.fn().mockResolvedValue(doc),
    archivo: jest.fn().mockResolvedValue({ buffer: PDF, filename: 'doc.pdf', mime: null }),
    guardar,
    error: (mensaje, status) => new ErrorPrueba(mensaje, status),
  };
  return { a, guardar, query };
}

function provider(texto: string) {
  return {
    nombre: 'ollama',
    modelo: 'qwen2.5vl',
    transcribir: jest.fn().mockResolvedValue({ texto, uso: { tokensIn: 1, tokensOut: 1, estimado: false } }),
  };
}

/** Deja correr la tarea en segundo plano hasta que su estado deje de ser `en_curso`. */
async function esperarFin(id: number) {
  for (let i = 0; i < 50 && estadoReproceso('sgd', id)?.estado === 'en_curso'; i++) {
    await new Promise((r) => setImmediate(r));
  }
  return estadoReproceso('sgd', id);
}

const TEXTO = 'Contenido transcrito con suficiente texto para no ser considerado vacío. '.repeat(5);

beforeEach(() => {
  disponibleMock.mockReturnValue({ disponible: true, motivo: null });
});

describe('iniciarReproceso', () => {
  it('rechaza un proveedor desconocido sin leer el documento', async () => {
    const { a } = adaptador({ id: 1, estado: 'ok', contenido_sha256: 'x' });
    await expect(iniciarReproceso(a, 1, { proveedor: 'gemini' })).rejects.toMatchObject({ status: 400 });
    expect(a.leer).not.toHaveBeenCalled();
  });

  it('rechaza un modelo de Ollama que no está instalado, nombrando los disponibles', async () => {
    const { a } = adaptador({ id: 6, estado: 'ok', contenido_sha256: 'x' });
    await expect(iniciarReproceso(a, 6, { proveedor: 'ollama', modelo: 'qwen2.5vl:7b' }))
      .rejects.toThrow(/qwen2\.5vl:latest/);
    expect(a.leer).not.toHaveBeenCalled();
  });

  it('rechaza un documento que está en la cola de un job', async () => {
    const { a } = adaptador({ id: 2, estado: 'ok', contenido_sha256: 'x' }, { enCola: true });
    await expect(iniciarReproceso(a, 2, { proveedor: 'ollama' })).rejects.toThrow(/#7/);
  });

  it('guarda el markdown nuevo con el método del proveedor y marca sha256_anterior', async () => {
    const { a, guardar, query } = adaptador({ id: 3, estado: 'ok', contenido_sha256: 'viejo' });
    crearMock.mockReturnValue(provider(TEXTO));

    const inicial = await iniciarReproceso(a, 3, { proveedor: 'ollama', modelo: 'qwen2.5vl' });
    expect(inicial.estado).toBe('en_curso');

    const final = await esperarFin(3);
    expect(final?.estado).toBe('ok');
    expect(guardar).toHaveBeenCalledTimes(1);
    expect(guardar.mock.calls[0][3].metodo).toBe('vision:ollama/qwen2.5vl');
    expect(guardar.mock.calls[0][1]).not.toBe('viejo');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('sha256_anterior'))).toBe(true);
  });

  it('no pisa el markdown anterior si el modelo no extrae texto', async () => {
    const { a, guardar } = adaptador({ id: 4, estado: 'ok', contenido_sha256: 'viejo' });
    crearMock.mockReturnValue(provider('   '));

    await iniciarReproceso(a, 4, { proveedor: 'ollama' });
    const final = await esperarFin(4);

    expect(final?.estado).toBe('error');
    expect(guardar).not.toHaveBeenCalled();
  });

  it('dos reprocesos con el mismo modelo escriben contenidos distintos', async () => {
    const { a, guardar } = adaptador({ id: 5, estado: 'ok', contenido_sha256: 'viejo' });
    crearMock.mockReturnValue(provider(TEXTO));

    await iniciarReproceso(a, 5, { proveedor: 'ollama' });
    await esperarFin(5);
    await new Promise((r) => setTimeout(r, 5)); // la hora de inicio entra en el hash
    await iniciarReproceso(a, 5, { proveedor: 'ollama' });
    await esperarFin(5);

    expect(guardar).toHaveBeenCalledTimes(2);
    expect(guardar.mock.calls[0][1]).not.toBe(guardar.mock.calls[1][1]);
  });
});
