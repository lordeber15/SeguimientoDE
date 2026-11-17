import { postJson } from '../http';
import { ErrorIA, type NombreProveedor, type RerankProvider } from '../types';

/**
 * Adaptadores de cross-encoder (docs/PLAN-RAG-AVANZADO.md, Fase 3, decisión D3).
 *
 * - `TeiRerank` (por defecto, "local"): Text Embeddings Inference de Hugging Face sirviendo un
 *   reranker multilingüe (servicio `reranker` de docker-compose). Nada sale del servidor.
 * - `CohereRerank`: API de Cohere. Envía el texto de los fragmentos a un tercero — solo con
 *   autorización expresa (ver D3 y §5 Riesgos del plan).
 *
 * Sin reintentos por defecto (`RERANK_REINTENTOS`, 0) y con timeout corto (`RERANK_TIMEOUT_MS`):
 * si el reranker no está, el chat sigue con el orden de RRF en vez de hacer esperar al usuario.
 */

const TIMEOUT_MS = () => Number(process.env.RERANK_TIMEOUT_MS ?? 8000);
const REINTENTOS = () => Number(process.env.RERANK_REINTENTOS ?? 0);

/** Reordena `resultados` (índice → puntaje) al orden original de los textos. */
function alinear(resultados: { index: number; puntaje: number }[], total: number, proveedor: NombreProveedor): number[] {
  const puntajes = new Array<number>(total).fill(Number.NaN);
  for (const r of resultados) {
    if (Number.isInteger(r.index) && r.index >= 0 && r.index < total && Number.isFinite(r.puntaje)) {
      puntajes[r.index] = r.puntaje;
    }
  }
  if (puntajes.some((p) => Number.isNaN(p))) {
    throw new ErrorIA(`${proveedor}: el rerank no devolvió un puntaje por cada texto`, 'desconocido', proveedor);
  }
  return puntajes;
}

export class TeiRerank implements RerankProvider {
  readonly nombre = 'tei' as const;
  readonly modelo: string;
  private readonly base: string;

  constructor(
    base = process.env.RERANK_URL ?? 'http://localhost:8082',
    // TEI sirve UN modelo, el de su `--model-id`; este nombre solo etiqueta trazas y evaluaciones.
    modelo = process.env.RERANK_MODEL ?? 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1',
  ) {
    this.base = base.replace(/\/$/, '');
    this.modelo = modelo;
  }

  async puntuar(consulta: string, textos: string[]): Promise<number[]> {
    if (textos.length === 0) return [];
    // raw_scores=false → sigmoide del logit, en [0, 1]. truncate → un fragmento más largo que la
    // ventana del modelo se corta en vez de devolver 413.
    const respuesta = await postJson<{ index: number; score: number }[]>({
      url: `${this.base}/rerank`,
      cuerpo: { query: consulta, texts: textos, raw_scores: false, truncate: true },
      cabeceras: {},
      proveedor: 'tei',
      timeoutMs: TIMEOUT_MS(),
      reintentos: REINTENTOS(),
    });
    if (!Array.isArray(respuesta)) throw new ErrorIA('tei: respuesta de rerank inesperada', 'desconocido', 'tei');
    return alinear(respuesta.map((r) => ({ index: r.index, puntaje: r.score })), textos.length, 'tei');
  }

  async comprobar(): Promise<void> {
    await this.puntuar('comprobación', ['comprobación']);
  }
}

export class CohereRerank implements RerankProvider {
  readonly nombre = 'cohere' as const;
  readonly modelo: string;

  constructor(modelo = process.env.RERANK_MODEL || 'rerank-v3.5') {
    this.modelo = modelo;
  }

  async puntuar(consulta: string, textos: string[]): Promise<number[]> {
    if (textos.length === 0) return [];
    const clave = (process.env.COHERE_API_KEY ?? '').trim();
    if (!clave) throw new ErrorIA('cohere: falta COHERE_API_KEY', 'auth', 'cohere');

    const respuesta = await postJson<{ results?: { index: number; relevance_score: number }[] }>({
      url: `${(process.env.COHERE_URL ?? 'https://api.cohere.com').replace(/\/$/, '')}/v2/rerank`,
      // Un fragmento ronda los 700 tokens (RAG_CHUNK_TOKENS); 1024 deja margen sin pagar 4096.
      cuerpo: { model: this.modelo, query: consulta, documents: textos, max_tokens_per_doc: 1024 },
      cabeceras: { Authorization: `Bearer ${clave}` },
      proveedor: 'cohere',
      timeoutMs: TIMEOUT_MS(),
      reintentos: REINTENTOS(),
    });
    if (!Array.isArray(respuesta.results)) {
      throw new ErrorIA('cohere: respuesta de rerank inesperada', 'desconocido', 'cohere');
    }
    return alinear(
      respuesta.results.map((r) => ({ index: r.index, puntaje: r.relevance_score })),
      textos.length,
      'cohere',
    );
  }

  async comprobar(): Promise<void> {
    await this.puntuar('comprobación', ['comprobación']);
  }
}
