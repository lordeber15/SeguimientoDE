import type { ChatProvider, RerankProvider, ResultadoChat } from '../ai/types';
import { crearRerankProvider, metodoRerankConfigurado, type MetodoRerank } from '../ai/providerFactory';
import { alertar } from '../observabilidad/alertas';
import { mensajeDe, paso } from '../observabilidad/traza';

/**
 * Rerank de los candidatos fusionados por RRF, antes de armar el contexto
 * (docs/PLAN-RAG-AVANZADO.md, Fase 3):
 *
 *   RRF (top-N = 20) → reordenar → descartar bajo el umbral → top-K → presupuesto de tokens (quien llama)
 *
 * Métodos (`RAG_RERANK_PROVIDER`, ver `metodoRerankConfigurado`):
 * - `local` / `cohere`: cross-encoder que lee la consulta y el TEXTO COMPLETO de cada fragmento
 *   juntos y devuelve un puntaje por fragmento. Es el único que permite un umbral: si ningún
 *   candidato llega a `RAG_RERANK_UMBRAL`, no queda contexto y el chat contesta "sin resultados" en
 *   vez de responder con fragmentos débiles.
 * - `llm`: el modelo de chat ordena una lista con los primeros 300 caracteres de cada fragmento (el
 *   rerank anterior a la Fase 3). Sin puntaje, así que sin umbral.
 * - `ninguno`: orden de RRF.
 *
 * Degrada con seguridad: si el reranker falla, tarda o responde algo inservible, se conserva el
 * orden de RRF (`respaldo: true`, sin umbral) y, si era el cross-encoder, se alerta — un rerank roto
 * nunca debe tumbar el chat.
 */

/** Lo mínimo que el rerank necesita de un fragmento: sirve igual al SGD y al STD. */
export interface CandidatoRerank {
  chunkId: number;
  texto: string;
  rutaTitulos: string | null;
}

export interface ConfigRerank {
  metodo: MetodoRerank;
  /** Fragmentos que pasan al contexto (después, el presupuesto de tokens puede dejar menos). */
  topK: number;
  /** Puntaje mínimo del cross-encoder, en [0, 1]. 0 = sin umbral. Se ignora en `llm`/`ninguno`. */
  umbral: number;
}

export interface ResultadoRerank<T extends CandidatoRerank = CandidatoRerank> {
  chunks: T[];
  /** Tokens del rerank por LLM (`chat_rerank`). `null` con cross-encoder o sin rerank. */
  uso: ResultadoChat['uso'] | null;
  metodo: MetodoRerank;
  /** Se conservó el orden de RRF porque el rerank falló o no se pudo interpretar. */
  respaldo?: true;
  /** Puntaje del cross-encoder de cada chunk devuelto (mismo orden). Solo `local`/`cohere`. */
  puntajes?: number[];
  /** Mejor puntaje entre TODOS los candidatos, aunque ninguno pasara el umbral: sirve para calibrarlo. */
  puntajeMax?: number;
  /** Candidatos descartados por el umbral (no por el top-K). */
  bajoUmbral: number;
}

function numeroEnv(nombre: string, porDefecto: number): number {
  const v = Number(process.env[nombre]);
  return process.env[nombre]?.trim() && Number.isFinite(v) ? v : porDefecto;
}

export function configRerank(): ConfigRerank {
  return {
    metodo: metodoRerankConfigurado(),
    topK: Math.max(1, Math.floor(numeroEnv('RAG_RERANK_TOP_K', 5))),
    umbral: Math.min(1, Math.max(0, numeroEnv('RAG_RERANK_UMBRAL', 0))),
  };
}

export async function rerankear<T extends CandidatoRerank>(
  provider: ChatProvider,
  consulta: string,
  chunks: T[],
  opciones: Partial<ConfigRerank> & { reranker?: RerankProvider | null } = {},
): Promise<ResultadoRerank<T>> {
  const config = { ...configRerank(), ...opciones };
  if (chunks.length === 0) return { chunks, uso: null, metodo: config.metodo, bajoUmbral: 0 };

  return paso(
    'rerank',
    { consulta, metodo: config.metodo, topK: config.topK, umbral: config.umbral, candidatos: chunks.map((c) => c.chunkId) },
    async () => {
      if (config.metodo === 'ninguno') {
        return { chunks: chunks.slice(0, config.topK), uso: null, metodo: config.metodo, bajoUmbral: 0 };
      }
      if (config.metodo === 'llm') {
        const r = await rerankearConLlm(provider, consulta, chunks);
        return { ...r, chunks: r.chunks.slice(0, config.topK), metodo: config.metodo, bajoUmbral: 0 };
      }
      const reranker = opciones.reranker !== undefined ? opciones.reranker : crearRerankProvider(config.metodo);
      return rerankearConCrossEncoder(reranker, consulta, chunks, config);
    },
    {
      resumir: (r) => ({
        salida: {
          orden: r.chunks.map((c) => c.chunkId),
          puntajes: r.puntajes?.map((p) => Math.round(p * 1000) / 1000),
          puntajeMax: r.puntajeMax,
          bajoUmbral: r.bajoUmbral,
          respaldo: r.respaldo,
        },
        nivel: r.respaldo ? 'WARNING' : 'DEFAULT',
      }),
    },
  );
}

/**
 * Texto que lee el cross-encoder: la ruta de títulos da el contexto que el fragmento solo no tiene.
 * Recortado a `RERANK_MAX_CARACTERES` (4000 ≈ 1000 tokens, más de lo que lee un reranker de 512): hay
 * fragmentos de tablas mal troceadas de cientos de miles de caracteres, que TEI rechaza con 413 y que el
 * modelo truncaría de todos modos.
 */
function textoParaRerank(c: CandidatoRerank): string {
  const texto = c.rutaTitulos ? `${c.rutaTitulos}\n\n${c.texto}` : c.texto;
  return texto.slice(0, Math.max(200, numeroEnv('RERANK_MAX_CARACTERES', 4000)));
}

async function rerankearConCrossEncoder<T extends CandidatoRerank>(
  reranker: RerankProvider | null,
  consulta: string,
  chunks: T[],
  config: ConfigRerank,
): Promise<ResultadoRerank<T>> {
  const respaldo = (motivo: string): ResultadoRerank<T> => {
    alertar('rerank_degradado', `Rerank ${config.metodo} no disponible: se usa el orden de RRF. ${motivo}`,
      { metodo: config.metodo, motivo }, config.metodo);
    return { chunks: chunks.slice(0, config.topK), uso: null, metodo: config.metodo, respaldo: true, bajoUmbral: 0 };
  };
  if (!reranker) return respaldo('sin adaptador para el método');

  let puntajes: number[];
  try {
    puntajes = await reranker.puntuar(consulta, chunks.map(textoParaRerank));
  } catch (error) {
    return respaldo(mensajeDe(error));
  }
  if (puntajes.length !== chunks.length) return respaldo('cantidad de puntajes distinta a la de candidatos');

  // Orden estable: a igual puntaje gana el mejor rango de RRF (el orden de entrada).
  const ordenados = chunks
    .map((chunk, i) => ({ chunk, puntaje: puntajes[i], i }))
    .sort((a, b) => b.puntaje - a.puntaje || a.i - b.i);
  const sobreUmbral = ordenados.filter((o) => o.puntaje >= config.umbral);
  const elegidos = sobreUmbral.slice(0, config.topK);

  return {
    chunks: elegidos.map((o) => o.chunk),
    uso: null,
    metodo: config.metodo,
    puntajes: elegidos.map((o) => o.puntaje),
    puntajeMax: ordenados[0].puntaje,
    bajoUmbral: ordenados.length - sobreUmbral.length,
  };
}

async function rerankearConLlm<T extends CandidatoRerank>(
  provider: ChatProvider,
  consulta: string,
  chunks: T[],
): Promise<{ chunks: T[]; uso: ResultadoChat['uso'] | null; respaldo?: true }> {
  if (chunks.length <= 1) return { chunks, uso: null };
  try {
    const respuesta = await provider.responder(
      [
        {
          rol: 'system',
          contenido:
            'Ordenas fragmentos de documentos por relevancia frente a una consulta. Responde '
            + 'ÚNICAMENTE con los números de los fragmentos separados por comas, de más a menos '
            + 'relevante — nada de texto adicional, nada de explicación.',
        },
        { rol: 'user', contenido: construirPrompt(consulta, chunks) },
      ],
      { maxTokens: 200 },
    );

    const orden = parsearOrden(respuesta.texto, chunks.length);
    if (!orden) return { chunks, uso: respuesta.uso, respaldo: true }; // no se pudo interpretar: se conserva RRF

    const porIndice = new Map(chunks.map((c, i) => [i + 1, c]));
    const mencionados = new Set(orden);
    const reordenados = orden
      .map((n) => porIndice.get(n))
      .filter((c): c is T => c !== undefined);
    // Cualquier chunk que el modelo no haya mencionado se añade al final, en su orden de RRF —
    // nunca se descarta un candidato solo porque el rerank lo omitió.
    const faltantes = chunks.filter((_, i) => !mencionados.has(i + 1));

    return { chunks: [...reordenados, ...faltantes], uso: respuesta.uso };
  } catch {
    return { chunks, uso: null, respaldo: true };
  }
}

function construirPrompt(consulta: string, chunks: CandidatoRerank[]): string {
  const lista = chunks
    .map((c, i) => `${i + 1}. ${c.texto.slice(0, 300).replace(/\s+/g, ' ').trim()}`)
    .join('\n');
  return `Consulta: "${consulta}"\n\nFragmentos:\n${lista}`;
}

/** Enteros válidos (1..total) del texto de respuesta, sin duplicados, en el orden en que aparecen. */
function parsearOrden(texto: string, total: number): number[] | null {
  const vistos = new Set<number>();
  const numeros: number[] = [];
  for (const m of texto.match(/\d+/g) ?? []) {
    const n = Number(m);
    if (n >= 1 && n <= total && !vistos.has(n)) {
      vistos.add(n);
      numeros.push(n);
    }
  }
  return numeros.length > 0 ? numeros : null;
}
