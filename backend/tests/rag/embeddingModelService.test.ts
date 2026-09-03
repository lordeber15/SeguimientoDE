import { tablaVectores } from '../../src/rag/embeddingModelService';

describe('tablaVectores', () => {
  it('elige la tabla según la dimensión, en los límites exactos', () => {
    expect(tablaVectores(1024)).toBe('embedding_1024');
    expect(tablaVectores(512)).toBe('embedding_1024');
    expect(tablaVectores(1025)).toBe('embedding_1536');
    expect(tablaVectores(1536)).toBe('embedding_1536');
    expect(tablaVectores(1537)).toBe('embedding_h3072');
    expect(tablaVectores(3072)).toBe('embedding_h3072');
  });

  it('los tres modelos reales del plan caen donde se espera', () => {
    expect(tablaVectores(1024)).toBe('embedding_1024'); // Ollama bge-m3
    expect(tablaVectores(1536)).toBe('embedding_1536'); // OpenAI text-embedding-3-small
    expect(tablaVectores(3072)).toBe('embedding_h3072'); // OpenAI text-embedding-3-large (halfvec)
  });
});
