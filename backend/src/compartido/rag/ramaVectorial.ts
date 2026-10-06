import type { Sequelize, Transaction } from 'sequelize';

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
