import { rerankear } from '../../src/rag/rerankService';
import type { ChatProvider } from '../../src/ai/types';
import type { ChunkRecuperado } from '../../src/rag/retrievalService';

function chunk(chunkId: number, texto = `texto ${chunkId}`): ChunkRecuperado {
  return { chunkId, texto, rutaTitulos: null, ord: 0, sha256: `sha-${chunkId}`, score: 1 };
}

function proveedor(responder: ChatProvider['responder']): ChatProvider {
  return { nombre: 'ollama', modelo: 'llama3', responder, comprobar: jest.fn() };
}

describe('rerankear', () => {
  it('no llama al proveedor con 0 o 1 chunk: no hay nada que reordenar', async () => {
    const responder = jest.fn();
    const r0 = await rerankear(proveedor(responder), 'consulta', []);
    const r1 = await rerankear(proveedor(responder), 'consulta', [chunk(1)]);

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

    const r = await rerankear(proveedor(responder), 'consulta', chunks);

    expect(r.chunks.map((c) => c.chunkId)).toEqual([3, 1, 2]);
    expect(r.uso).toEqual({ tokensIn: 10, tokensOut: 2, estimado: false });
  });

  it('los chunks que el modelo no menciona se conservan al final, en su orden original', async () => {
    const responder = jest.fn().mockResolvedValue({
      texto: 'El más relevante es el 2.',
      uso: { tokensIn: 1, tokensOut: 1, estimado: false },
    });
    const chunks = [chunk(1), chunk(2), chunk(3)];

    const r = await rerankear(proveedor(responder), 'consulta', chunks);

    expect(r.chunks.map((c) => c.chunkId)).toEqual([2, 1, 3]);
  });

  it('si la respuesta no trae ningún número válido, conserva el orden de RRF tal cual', async () => {
    const responder = jest.fn().mockResolvedValue({
      texto: 'No hay fragmentos relevantes.',
      uso: { tokensIn: 1, tokensOut: 1, estimado: false },
    });
    const chunks = [chunk(1), chunk(2)];

    const r = await rerankear(proveedor(responder), 'consulta', chunks);

    expect(r.chunks).toEqual(chunks);
  });

  it('si el proveedor falla, conserva el orden de RRF en vez de tumbar el chat', async () => {
    const responder = jest.fn().mockRejectedValue(new Error('el proveedor no respondió'));
    const chunks = [chunk(1), chunk(2)];

    const r = await rerankear(proveedor(responder), 'consulta', chunks);

    expect(r.chunks).toEqual(chunks);
    expect(r.uso).toBeNull();
  });

  it('ignora números fuera de rango o repetidos en la respuesta del modelo', async () => {
    const responder = jest.fn().mockResolvedValue({
      texto: '2, 2, 99, 1',
      uso: { tokensIn: 1, tokensOut: 1, estimado: false },
    });
    const chunks = [chunk(1), chunk(2)];

    const r = await rerankear(proveedor(responder), 'consulta', chunks);

    expect(r.chunks.map((c) => c.chunkId)).toEqual([2, 1]);
  });
});
