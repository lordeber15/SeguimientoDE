/**
 * Caché de embeddings de consulta (`embeberConsulta`): la misma consulta con el mismo modelo no vuelve
 * a llamar al proveedor; otro módulo, otro modelo o un fallo sí.
 */

const embeber = jest.fn();
const proveedor = { nombre: 'ollama', modelo: 'bge-m3', dimension: 3, embeber };
jest.mock('../../../src/compartido/ai/providerFactory', () => ({
  crearEmbeddingProvider: () => proveedor,
}));
jest.mock('../../../src/compartido/observabilidad/alertas', () => ({ alertar: jest.fn() }));
jest.mock('../../../src/compartido/config/appDatabase', () => ({ appSequelize: {} }));

import { embeberConsulta, vaciarCacheEmbeddings } from '../../../src/compartido/rag/ramaVectorial';

const modelo = { id: 7, dimension: 3 };

beforeEach(() => {
  vaciarCacheEmbeddings();
  embeber.mockReset();
  embeber.mockResolvedValue({ vectores: [[0.1, 0.2, 0.3]] });
});

describe('embeberConsulta con caché', () => {
  it('la segunda vez la misma consulta sale de la caché', async () => {
    const a = await embeberConsulta(modelo, 'penalidad Junín', 'sgd');
    const b = await embeberConsulta(modelo, 'penalidad Junín', 'sgd');
    expect(a.consulta?.vecLiteral).toBe('[0.1,0.2,0.3]');
    expect(b).toEqual(a);
    expect(embeber).toHaveBeenCalledTimes(1);
  });

  it('otro texto, otro módulo u otro modelo vuelven a embeber', async () => {
    await embeberConsulta(modelo, 'q', 'sgd');
    await embeberConsulta(modelo, 'q2', 'sgd');
    await embeberConsulta(modelo, 'q', 'std');
    await embeberConsulta({ id: 8, dimension: 3 }, 'q', 'sgd');
    expect(embeber).toHaveBeenCalledTimes(4);
  });

  it('un fallo no se guarda: el siguiente intento vuelve a llamar al proveedor', async () => {
    embeber.mockRejectedValue(new Error('caído'));
    const r = await embeberConsulta(modelo, 'q', 'sgd');
    expect(r.consulta).toBeNull();
    embeber.mockReset();
    embeber.mockResolvedValue({ vectores: [[1, 2, 3]] });
    expect((await embeberConsulta(modelo, 'q', 'sgd')).consulta?.vecLiteral).toBe('[1,2,3]');
  });
});
