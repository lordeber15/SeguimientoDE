import type { Sequelize, Transaction } from 'sequelize';
import { crearEmbeddingProvider } from '../ai/providerFactory';
import { alertar } from '../observabilidad/alertas';
import { conReintentos, evento, mensajeDe } from '../observabilidad/traza';
import { tablaVectores } from './embeddingModelService';

/** Embedding de la consulta del chat: 1 reintento — si el proveedor está caído, mejor caer a FTS ya. */
const REINTENTOS_EMBEDDING_CONSULTA = 1;

/**
 * Caché en memoria de embeddings de consulta (LRU con TTL). Un mismo turno embebe la consulta en cada
 * subconsulta y en cada reintento sin filtros, y los usuarios repiten preguntas ("reintentar", la misma
 * pregunta en otro modo). La clave incluye módulo, modelo activo y proveedor: un cambio de modelo nunca
 * reutiliza un vector de otro espacio. Solo se guardan éxitos.
 */
const CACHE_MAX = 500;
const CACHE_TTL_MS = 60 * 60 * 1000;
const cacheEmbeddings = new Map<string, { vecLiteral: string; expira: number }>();

function leerCache(clave: string): string | null {
  const entrada = cacheEmbeddings.get(clave);
  if (!entrada) return null;
  cacheEmbeddings.delete(clave);
  if (entrada.expira < Date.now()) return null;
  cacheEmbeddings.set(clave, entrada); // al final = usado más recientemente
  return entrada.vecLiteral;
}

function guardarCache(clave: string, vecLiteral: string): void {
  cacheEmbeddings.delete(clave);
  cacheEmbeddings.set(clave, { vecLiteral, expira: Date.now() + CACHE_TTL_MS });
  while (cacheEmbeddings.size > CACHE_MAX) {
    const masViejo = cacheEmbeddings.keys().next().value;
    if (masViejo === undefined) break;
    cacheEmbeddings.delete(masViejo);
  }
}

/** Solo para pruebas. */
export function vaciarCacheEmbeddings(): void {
  cacheEmbeddings.clear();
}

export interface ConsultaEmbebida {
  vecLiteral: string;
  modeloId: number;
  tabla: string;
}

/**
 * Embebe la consulta con el modelo activo. `consulta = null` → la rama vectorial se omite y el
 * retrieval es FTS puro (D8: el chat funciona aunque peor). Sin modelo activo eso es configuración y
 * no se reporta; con modelo activo pero sin poder embeber (proveedor caído, dimensión cambiada en el
 * `.env`) es una DEGRADACIÓN: se devuelve el motivo, queda como evento en la traza y se alerta —
 * antes era invisible (el 2026-10-06 la rama vectorial devolvió 0 en todo con Ollama apagado).
 */
export async function embeberConsulta(
  modelo: { id: number; dimension: number } | null,
  consultaTexto: string,
  modulo: 'sgd' | 'std',
): Promise<{ consulta: ConsultaEmbebida | null; degradacion: string | null }> {
  if (!modelo) return { consulta: null, degradacion: null };

  let degradacion: string;
  try {
    const provider = crearEmbeddingProvider();
    if (provider.dimension === modelo.dimension) {
      const clave = `${modulo}|${modelo.id}|${provider.nombre}|${provider.modelo}|${consultaTexto}`;
      let vecLiteral = leerCache(clave);
      if (!vecLiteral) {
        const { vectores } = await conReintentos(REINTENTOS_EMBEDDING_CONSULTA, () => provider.embeber([consultaTexto]));
        vecLiteral = `[${vectores[0].join(',')}]`;
        guardarCache(clave, vecLiteral);
      }
      return {
        consulta: { vecLiteral, modeloId: modelo.id, tabla: tablaVectores(modelo.dimension) },
        degradacion: null,
      };
    }
    // Dimensión distinta = el `.env` cambió sin desactivar el modelo: no se mezclan espacios.
    degradacion = `el proveedor de embeddings configurado tiene dimensión ${provider.dimension} y el modelo activo ${modelo.dimension}`;
  } catch (e) {
    degradacion = `no se pudo embeber la consulta: ${mensajeDe(e)}`;
  }

  evento('vectorial_degradada', { modulo, motivo: degradacion }, 'WARNING');
  alertar('vectorial_degradada', `${modulo.toUpperCase()}: búsqueda solo por texto (FTS) — ${degradacion}`, { modulo }, modulo);
  return { consulta: null, degradacion };
}

/**
 * Configuración del índice HNSW para la rama vectorial del retrieval, común al SGD y al STD.
 *
 * Dos trampas de pgvector que esto evita (verificadas contra la BD real, docs/PLAN-RAG-AVANZADO.md):
 *
 * 1. `hnsw.ef_search` vale 40 por defecto y es el TOPE de filas que devuelve un escaneo HNSW: con
 *    `LIMIT 50` la rama vectorial devolvía siempre 40.
 * 2. Con un filtro (dependencia, expediente, conjunto) HNSW filtra DESPUÉS de traer sus vecinos: un
 *    usuario cuya dependencia tiene ~3 500 chunks entre 220 000 recibía 0 o 1 resultados, sin error.
 *    El escaneo iterativo (pgvector ≥ 0.8) sigue recorriendo el grafo hasta llenar el LIMIT o agotar
 *    `hnsw.max_scan_tuples`; y bajo `UMBRAL_ESCANEO_EXACTO` chunks filtrados se fuerza el escaneo
 *    exacto, que con tan pocos es barato y no depende de cuánto recorra el grafo.
 *
 * El modo se decide ANTES de consultar (antes se decidía con el número de resultados ya obtenidos y
 * el `SET LOCAL` llegaba tarde: nunca tenía efecto).
 */

export const UMBRAL_ESCANEO_EXACTO = 2000;
/** Debe ser ≥ al LIMIT de la rama (50): es el tamaño de la lista de candidatos del escaneo. */
export const HNSW_EF_SEARCH = 100;

/**
 * Envuelve la consulta de vecinos para el escaneo iterativo `relaxed_order`, que puede devolver las
 * filas ligeramente fuera de orden: se materializa y se reordena por distancia (el `+ 0` impide que
 * Postgres 17+ vuelva a usar el índice para el ORDER BY exterior; ver README de pgvector).
 * `consultaInterna` debe exponer `chunk_id` y `distancia`, ya ordenada por `distancia` y con LIMIT.
 */
export function sqlVecinosOrdenados(consultaInterna: string): string {
  return `WITH vecinos AS MATERIALIZED (${consultaInterna})
          SELECT chunk_id FROM vecinos ORDER BY distancia + 0`;
}

/**
 * Corre `consulta` (la rama vectorial) con el modo de escaneo indicado, solo dentro de `tx`. En modo
 * exacto, los índices se vuelven a habilitar al terminar: el resto del retrieval (FTS, detalle de
 * chunks) sí debe usarlos.
 */
export async function conEscaneoVectorial<T>(
  db: Sequelize,
  tx: Transaction,
  exacto: boolean,
  consulta: () => Promise<T>,
): Promise<T> {
  if (exacto) {
    await db.query('SET LOCAL enable_indexscan = off', { transaction: tx });
    const resultado = await consulta();
    // Sin try/finally a propósito: si la consulta falla, la transacción ya está abortada (un SET ahí
    // también fallaría y taparía el error real) y el rollback descarta el SET LOCAL de todos modos.
    await db.query('SET LOCAL enable_indexscan = on', { transaction: tx });
    return resultado;
  }
  await db.query(`SET LOCAL hnsw.ef_search = ${HNSW_EF_SEARCH}`, { transaction: tx });
  await db.query("SET LOCAL hnsw.iterative_scan = 'relaxed_order'", { transaction: tx });
  return consulta();
}

/** Lo que de la búsqueda va a la traza: cifras e ids, no el texto de los fragmentos. */
export function resumirBusqueda(r: {
  chunks: { chunkId: number }[]; candidatosVec: number; candidatosFts: number; escaneoExacto: boolean;
  degradacionVectorial?: string | null;
}) {
  return {
    salida: {
      candidatosVec: r.candidatosVec, candidatosFts: r.candidatosFts, escaneoExacto: r.escaneoExacto,
      chunks: r.chunks.map((c) => c.chunkId), degradacionVectorial: r.degradacionVectorial ?? null,
    },
    nivel: r.degradacionVectorial ? 'WARNING' as const : 'DEFAULT' as const,
  };
}
