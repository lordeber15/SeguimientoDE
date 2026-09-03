import type { ChatProvider, ResultadoChat } from '../ai/types';
import type { ChunkRecuperado } from './retrievalService';

/**
 * Rerank semántico vía el mismo `ChatProvider` del chat (Fase 6 — decisión del usuario: reusar la
 * infraestructura ya construida en vez de un modelo de rerank aparte). Se le pide al modelo que
 * reordene los candidatos ya fusionados por RRF antes de recortarlos al presupuesto de tokens:
 * RRF combina dos señales léxicas/vectoriales baratas, esto añade una lectura semántica real de
 * la pregunta completa — a cambio de una llamada extra (coste y latencia) por pregunta.
 *
 * Degrada con seguridad: si el proveedor falla, tarda, o la respuesta no se puede interpretar
 * como una lista de números, se conserva el orden de RRF tal cual. Un rerank roto nunca debe
 * tumbar el chat — el mismo principio que ya rige la rama vectorial del retrieval (Fase 5).
 */

export interface ResultadoRerank {
  chunks: ChunkRecuperado[];
  uso: ResultadoChat['uso'] | null;
}

export async function rerankear(
  provider: ChatProvider,
  consulta: string,
  chunks: ChunkRecuperado[],
): Promise<ResultadoRerank> {
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
    if (!orden) return { chunks, uso: respuesta.uso }; // no se pudo interpretar: se conserva RRF

    const porIndice = new Map(chunks.map((c, i) => [i + 1, c]));
    const mencionados = new Set(orden);
    const reordenados = orden
      .map((n) => porIndice.get(n))
      .filter((c): c is ChunkRecuperado => c !== undefined);
    // Cualquier chunk que el modelo no haya mencionado se añade al final, en su orden de RRF —
    // nunca se descarta un candidato solo porque el rerank lo omitió.
    const faltantes = chunks.filter((_, i) => !mencionados.has(i + 1));

    return { chunks: [...reordenados, ...faltantes], uso: respuesta.uso };
  } catch {
    return { chunks, uso: null };
  }
}

function construirPrompt(consulta: string, chunks: ChunkRecuperado[]): string {
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
