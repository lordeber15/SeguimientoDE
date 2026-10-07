/**
 * Adaptadores de cross-encoder (docs/PLAN-RAG-AVANZADO.md, Fase 3): el formato que envían a TEI y a
 * Cohere, y que devuelven un puntaje por texto EN EL ORDEN DE ENTRADA aunque el servicio los entregue
 * ordenados por relevancia.
 */

const alertar = jest.fn();
jest.mock('../../../../src/compartido/observabilidad/alertas', () => ({ alertar: (...a: unknown[]) => alertar(...a) }));

import { CohereRerank, TeiRerank } from '../../../../src/compartido/ai/providers/rerank';
import { ErrorIA } from '../../../../src/compartido/ai/types';

let fetchOriginal: typeof fetch;
const fetchMock = jest.fn();

const ok = (cuerpo: unknown) => ({
  ok: true, status: 200, headers: { get: () => null }, json: async () => cuerpo, text: async () => JSON.stringify(cuerpo),
});

beforeEach(() => {
  fetchOriginal = global.fetch;
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  alertar.mockReset();
});

afterEach(() => {
  global.fetch = fetchOriginal;
  delete process.env.COHERE_API_KEY;
});

const cuerpoEnviado = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

describe('TeiRerank', () => {
  it('envía query/texts con puntajes normalizados y truncado, y realinea al orden de entrada', async () => {
    fetchMock.mockResolvedValue(ok([{ index: 2, score: 0.9 }, { index: 0, score: 0.4 }, { index: 1, score: 0.1 }]));

    const puntajes = await new TeiRerank('http://reranker:80/', 'bge').puntuar('consulta', ['a', 'b', 'c']);

    expect(puntajes).toEqual([0.4, 0.1, 0.9]);
    expect(fetchMock.mock.calls[0][0]).toBe('http://reranker:80/rerank');
    expect(cuerpoEnviado()).toEqual({ query: 'consulta', texts: ['a', 'b', 'c'], raw_scores: false, truncate: true });
  });

  it('sin textos no llama al servicio', async () => {
    expect(await new TeiRerank('http://x').puntuar('q', [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falla si falta el puntaje de algún texto (no inventa un orden)', async () => {
    fetchMock.mockResolvedValue(ok([{ index: 0, score: 0.4 }]));

    await expect(new TeiRerank('http://x').puntuar('q', ['a', 'b'])).rejects.toBeInstanceOf(ErrorIA);
  });

  it('no reintenta por defecto: si el reranker está caído, el chat sigue con RRF sin esperar', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(new TeiRerank('http://x').puntuar('q', ['a'])).rejects.toBeInstanceOf(ErrorIA);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('CohereRerank', () => {
  it('sin COHERE_API_KEY falla como error de configuración, sin llamar a la API', async () => {
    await expect(new CohereRerank().puntuar('q', ['a'])).rejects.toMatchObject({ tipo: 'auth' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('usa /v2/rerank con el modelo vigente y realinea relevance_score al orden de entrada', async () => {
    process.env.COHERE_API_KEY = 'clave';
    fetchMock.mockResolvedValue(ok({ results: [{ index: 1, relevance_score: 0.8 }, { index: 0, relevance_score: 0.2 }] }));

    const puntajes = await new CohereRerank().puntuar('consulta', ['a', 'b']);

    expect(puntajes).toEqual([0.2, 0.8]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.cohere.com/v2/rerank');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer clave');
    expect(cuerpoEnviado()).toMatchObject({ model: 'rerank-v3.5', query: 'consulta', documents: ['a', 'b'] });
  });
});
