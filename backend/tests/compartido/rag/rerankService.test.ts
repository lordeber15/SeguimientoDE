const alertar = jest.fn();
jest.mock('../../../src/compartido/observabilidad/alertas', () => ({
  alertar: (...a: unknown[]) => alertar(...a),
}));

import { configRerank, rerankear } from '../../../src/compartido/rag/rerankService';
import type { ChatProvider, RerankProvider } from '../../../src/compartido/ai/types';
import type { ChunkRecuperado } from '../../../src/modulos/sgd/rag/retrievalService';

function chunk(chunkId: number, texto = `texto ${chunkId}`, rutaTitulos: string | null = null): ChunkRecuperado {
  return { chunkId, texto, rutaTitulos, ord: 0, sha256: `sha-${chunkId}`, score: 1 };
}

function proveedor(responder: ChatProvider['responder']): ChatProvider {
  return { nombre: 'ollama', modelo: 'llama3', responder, comprobar: jest.fn() };
}

function reranker(puntuar: RerankProvider['puntuar']): RerankProvider {
  return { nombre: 'tei', modelo: 'bge-reranker-v2-m3', puntuar, comprobar: jest.fn() };
}

const ENV = ['RAG_RERANK_PROVIDER', 'RAG_RERANK_TOP_K', 'RAG_RERANK_UMBRAL'];
beforeEach(() => {
  alertar.mockReset();
  ENV.forEach((v) => delete process.env[v]);
});
afterAll(() => ENV.forEach((v) => delete process.env[v]));

describe('configRerank', () => {
  it('por defecto: rerank por LLM (compatible con instalaciones sin reranker), top-K 5, sin umbral', () => {
    expect(configRerank()).toEqual({ metodo: 'llm', topK: 5, umbral: 0 });
  });

  it('lee el entorno, acota el umbral a [0, 1] y descarta un método desconocido', () => {
    process.env.RAG_RERANK_PROVIDER = 'local';
    process.env.RAG_RERANK_TOP_K = '3';
    process.env.RAG_RERANK_UMBRAL = '1.7';
    expect(configRerank()).toEqual({ metodo: 'local', topK: 3, umbral: 1 });

    process.env.RAG_RERANK_PROVIDER = 'colbert';
    process.env.RAG_RERANK_TOP_K = 'x';
    expect(configRerank()).toMatchObject({ metodo: 'llm', topK: 5 });
  });
});

describe('rerankear — por LLM', () => {
  const llm = { metodo: 'llm' as const };

  it('no llama al proveedor con 0 o 1 chunk: no hay nada que reordenar', async () => {
    const responder = jest.fn();
    const r0 = await rerankear(proveedor(responder), 'consulta', [], llm);
    const r1 = await rerankear(proveedor(responder), 'consulta', [chunk(1)], llm);

    expect(responder).not.toHaveBeenCalled();
    expect(r0.chunks).toEqual([]);
    expect(r1.chunks).toEqual([chunk(1)]);
  });

  it('reordena según la lista de números que devuelve el modelo', async () => {
    const responder = jest.fn().mockResolvedValue({
      texto: '3, 1, 2',
      uso: { tokensIn: 10, tokensOut: 2, estimado: false },
    });
    const chunks = [chunk(1), chunk(2), chunk(3)];

    const r = await rerankear(proveedor(responder), 'consulta', chunks, llm);

    expect(r.chunks.map((c) => c.chunkId)).toEqual([3, 1, 2]);
    expect(r.uso).toEqual({ tokensIn: 10, tokensOut: 2, estimado: false });
    expect(r.metodo).toBe('llm');
  });

  it('los chunks que el modelo no menciona se conservan al final, en su orden original', async () => {
    const responder = jest.fn().mockResolvedValue({
      texto: 'El más relevante es el 2.',
      uso: { tokensIn: 1, tokensOut: 1, estimado: false },
    });
    const chunks = [chunk(1), chunk(2), chunk(3)];

    const r = await rerankear(proveedor(responder), 'consulta', chunks, llm);

    expect(r.chunks.map((c) => c.chunkId)).toEqual([2, 1, 3]);
  });

  it('si la respuesta no trae ningún número válido, conserva el orden de RRF tal cual', async () => {
    const responder = jest.fn().mockResolvedValue({
      texto: 'No hay fragmentos relevantes.',
      uso: { tokensIn: 1, tokensOut: 1, estimado: false },
    });
    const chunks = [chunk(1), chunk(2)];

    const r = await rerankear(proveedor(responder), 'consulta', chunks, llm);

    expect(r.chunks).toEqual(chunks);
    expect(r.respaldo).toBe(true);
  });

  it('si el proveedor falla, conserva el orden de RRF en vez de tumbar el chat', async () => {
    const responder = jest.fn().mockRejectedValue(new Error('el proveedor no respondió'));
    const chunks = [chunk(1), chunk(2)];

    const r = await rerankear(proveedor(responder), 'consulta', chunks, llm);

    expect(r.chunks).toEqual(chunks);
    expect(r.uso).toBeNull();
  });

  it('ignora números fuera de rango o repetidos en la respuesta del modelo', async () => {
    const responder = jest.fn().mockResolvedValue({
      texto: '2, 2, 99, 1',
      uso: { tokensIn: 1, tokensOut: 1, estimado: false },
    });
    const chunks = [chunk(1), chunk(2)];

    const r = await rerankear(proveedor(responder), 'consulta', chunks, llm);

    expect(r.chunks.map((c) => c.chunkId)).toEqual([2, 1]);
  });

  it('corta al top-K después de reordenar', async () => {
    const responder = jest.fn().mockResolvedValue({ texto: '3, 2, 1', uso: { tokensIn: 1, tokensOut: 1, estimado: false } });

    const r = await rerankear(proveedor(responder), 'consulta', [chunk(1), chunk(2), chunk(3)], { ...llm, topK: 2 });

    expect(r.chunks.map((c) => c.chunkId)).toEqual([3, 2]);
  });
});

describe('rerankear — cross-encoder', () => {
  const local = { metodo: 'local' as const, topK: 5, umbral: 0 };

  it('ordena por puntaje, lee el texto COMPLETO con su ruta de títulos y no usa el modelo de chat', async () => {
    const responder = jest.fn();
    const puntuar = jest.fn().mockResolvedValue([0.1, 0.9, 0.5]);
    const largo = 'x'.repeat(2000);
    const chunks = [chunk(1, largo, 'Cláusulas > Penalidades'), chunk(2), chunk(3)];

    const r = await rerankear(proveedor(responder), 'penalidades', chunks, { ...local, reranker: reranker(puntuar) });

    expect(r.chunks.map((c) => c.chunkId)).toEqual([2, 3, 1]);
    expect(r.puntajes).toEqual([0.9, 0.5, 0.1]);
    expect(r.puntajeMax).toBe(0.9);
    expect(r.uso).toBeNull();
    expect(responder).not.toHaveBeenCalled();
    expect(puntuar).toHaveBeenCalledWith('penalidades', [`Cláusulas > Penalidades\n\n${largo}`, 'texto 2', 'texto 3']);
  });

  it('recorta fragmentos gigantes antes de enviarlos (TEI los rechaza con 413)', async () => {
    const puntuar = jest.fn().mockResolvedValue([0.5]);

    await rerankear(proveedor(jest.fn()), 'q', [chunk(1, 'y'.repeat(700_000))], { ...local, reranker: reranker(puntuar) });

    expect(puntuar.mock.calls[0][1][0]).toHaveLength(4000);
  });

  it('a igual puntaje conserva el orden de RRF', async () => {
    const puntuar = jest.fn().mockResolvedValue([0.5, 0.5, 0.7]);

    const r = await rerankear(proveedor(jest.fn()), 'q', [chunk(1), chunk(2), chunk(3)], { ...local, reranker: reranker(puntuar) });

    expect(r.chunks.map((c) => c.chunkId)).toEqual([3, 1, 2]);
  });

  it('corta al top-K y descarta lo que no llega al umbral', async () => {
    const puntuar = jest.fn().mockResolvedValue([0.8, 0.05, 0.6, 0.7, 0.02]);
    const chunks = [1, 2, 3, 4, 5].map((n) => chunk(n));

    const r = await rerankear(proveedor(jest.fn()), 'q', chunks, { metodo: 'local', topK: 2, umbral: 0.1, reranker: reranker(puntuar) });

    expect(r.chunks.map((c) => c.chunkId)).toEqual([1, 4]);
    expect(r.bajoUmbral).toBe(2);
  });

  it('si ningún candidato llega al umbral no deja contexto, pero informa el mejor puntaje', async () => {
    const puntuar = jest.fn().mockResolvedValue([0.03, 0.01]);

    const r = await rerankear(proveedor(jest.fn()), 'q', [chunk(1), chunk(2)], { ...local, umbral: 0.2, reranker: reranker(puntuar) });

    expect(r.chunks).toEqual([]);
    expect(r.puntajeMax).toBe(0.03);
    expect(r.bajoUmbral).toBe(2);
  });

  it('puntúa aunque haya un solo candidato: el umbral también aplica ahí', async () => {
    const puntuar = jest.fn().mockResolvedValue([0.01]);

    const r = await rerankear(proveedor(jest.fn()), 'q', [chunk(1)], { ...local, umbral: 0.2, reranker: reranker(puntuar) });

    expect(puntuar).toHaveBeenCalled();
    expect(r.chunks).toEqual([]);
  });

  it('si el reranker falla: orden de RRF hasta top-K, SIN umbral, y alerta', async () => {
    const puntuar = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED reranker:80'));
    const chunks = [1, 2, 3].map((n) => chunk(n));

    const r = await rerankear(proveedor(jest.fn()), 'q', chunks, { metodo: 'local', topK: 2, umbral: 0.9, reranker: reranker(puntuar) });

    expect(r.chunks.map((c) => c.chunkId)).toEqual([1, 2]);
    expect(r.respaldo).toBe(true);
    expect(alertar).toHaveBeenCalledWith('rerank_degradado', expect.stringContaining('ECONNREFUSED'), expect.any(Object), 'local');
  });

  it('si devuelve una cantidad de puntajes distinta, usa el orden de RRF', async () => {
    const puntuar = jest.fn().mockResolvedValue([0.9]);

    const r = await rerankear(proveedor(jest.fn()), 'q', [chunk(1), chunk(2)], { ...local, reranker: reranker(puntuar) });

    expect(r.chunks.map((c) => c.chunkId)).toEqual([1, 2]);
    expect(r.respaldo).toBe(true);
  });

  it('sin adaptador para el método (reranker null): orden de RRF y alerta', async () => {
    const r = await rerankear(proveedor(jest.fn()), 'q', [chunk(1), chunk(2)], { ...local, reranker: null });

    expect(r.respaldo).toBe(true);
    expect(alertar).toHaveBeenCalledTimes(1);
  });
});

describe('rerankear — ninguno', () => {
  it('conserva el orden de RRF hasta el top-K sin llamar a nada', async () => {
    const responder = jest.fn();

    const r = await rerankear(proveedor(responder), 'q', [chunk(1), chunk(2), chunk(3)], { metodo: 'ninguno', topK: 2 });

    expect(r.chunks.map((c) => c.chunkId)).toEqual([1, 2]);
    expect(responder).not.toHaveBeenCalled();
  });
});
