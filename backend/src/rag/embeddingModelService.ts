import { QueryTypes } from 'sequelize';
import { appSequelize } from '../config/appDatabase';
import type { EmbeddingProvider } from '../ai/types';

/**
 * Registro de modelos de embedding y cuál está activo.
 *
 * Guardarraíl contra el fallo silencioso más caro del sistema: mezclar vectores de dos espacios
 * semánticos en la misma búsqueda. `activo` es único por índice parcial (migración 002), así que
 * la BD misma impide tener dos modelos activos a la vez.
 */

export interface FilaModelo {
  id: number;
  proveedor: string;
  modelo: string;
  dimension: number;
  activo: boolean;
  backfillPct: number;
}

export async function listarModelos(): Promise<FilaModelo[]> {
  return appSequelize.query<FilaModelo>(
    `SELECT id, proveedor, modelo, dimension, activo, backfill_pct AS "backfillPct"
       FROM rag.embedding_model ORDER BY fe_alta`,
    { type: QueryTypes.SELECT },
  );
}

export async function modeloActivo(): Promise<FilaModelo | null> {
  const filas = await appSequelize.query<FilaModelo>(
    `SELECT id, proveedor, modelo, dimension, activo, backfill_pct AS "backfillPct"
       FROM rag.embedding_model WHERE activo LIMIT 1`,
    { type: QueryTypes.SELECT },
  );
  return filas[0] ?? null;
}

/** Da de alta el modelo configurado si no existe todavía. NUNCA lo activa: eso es un acto administrativo. */
export async function registrarSiNoExiste(provider: EmbeddingProvider): Promise<FilaModelo> {
  const filas = await appSequelize.query<FilaModelo>(
    `INSERT INTO rag.embedding_model (proveedor, modelo, dimension)
     VALUES ($1, $2, $3)
     ON CONFLICT (proveedor, modelo) DO UPDATE SET proveedor = EXCLUDED.proveedor
     RETURNING id, proveedor, modelo, dimension, activo, backfill_pct AS "backfillPct"`,
    { bind: [provider.nombre, provider.modelo, provider.dimension], type: QueryTypes.SELECT },
  );
  await asegurarParticion(filas[0].id, filas[0].dimension);
  return filas[0];
}

/**
 * Las tablas de vectores están particionadas por `modelo_id` (una partición por modelo, dentro de
 * la tabla de su dimensión). Sin esto, CUALQUIER INSERT contra una tabla particionada sin
 * particiones falla con "no partition of relation found for row" — no es un caso raro, es
 * SIEMPRE, porque PostgreSQL no crea particiones solo; hay que declararlas explícitamente.
 * `IF NOT EXISTS` la hace idempotente si el modelo ya se registró antes.
 */
async function asegurarParticion(modeloId: number, dimension: number): Promise<void> {
  const tabla = tablaVectores(dimension);
  await appSequelize.query(
    `CREATE TABLE IF NOT EXISTS rag.${tabla}_p${modeloId}
       PARTITION OF rag.${tabla} FOR VALUES IN (${modeloId})`,
  );
}

export class ModeloError extends Error {
  readonly status: number;
  constructor(mensaje: string, status = 400) {
    super(mensaje);
    this.name = 'ModeloError';
    this.status = status;
  }
}

/**
 * Activa un modelo, verificando ANTES que su dimensión declarada coincide con lo que el
 * proveedor devuelve de verdad — `provider.comprobar()` ya hace esa comprobación y lanza si no
 * coincide. Sin esto, un `OLLAMA_EMBED_DIM` mal puesto en el `.env` pasaría desapercibido hasta
 * que el primer INSERT de vectores fallara a mitad de una ingesta de horas.
 */
export async function activarModelo(id: number, actor: string, provider: EmbeddingProvider): Promise<void> {
  await provider.comprobar();

  await appSequelize.transaction(async (tx) => {
    const filas = await appSequelize.query<{ dimension: number }>(
      'SELECT dimension FROM rag.embedding_model WHERE id = $1',
      { bind: [id], type: QueryTypes.SELECT, transaction: tx },
    );
    if (filas.length === 0) throw new ModeloError('El modelo no existe', 404);
    if (filas[0].dimension !== provider.dimension) {
      throw new ModeloError(
        `El modelo registrado tiene dimensión ${filas[0].dimension}, pero el proveedor `
          + `configurado ahora devuelve ${provider.dimension}. Registre un modelo nuevo.`,
      );
    }

    await appSequelize.query('UPDATE rag.embedding_model SET activo = false WHERE activo', {
      type: QueryTypes.UPDATE,
      transaction: tx,
    });
    await appSequelize.query('UPDATE rag.embedding_model SET activo = true WHERE id = $1', {
      bind: [id],
      type: QueryTypes.UPDATE,
      transaction: tx,
    });
  });

  await appSequelize.query(
    `INSERT INTO app.auditoria (actor, accion, detalle) VALUES ($1, 'embedding_model.activar', $2::jsonb)`,
    { bind: [actor, JSON.stringify({ id })], type: QueryTypes.INSERT },
  );
}

/** Nombre de la tabla física según la dimensión (migración 002: una tabla por dimensión). */
export function tablaVectores(dimension: number): 'embedding_1024' | 'embedding_1536' | 'embedding_h3072' {
  if (dimension <= 1024) return 'embedding_1024';
  if (dimension <= 1536) return 'embedding_1536';
  return 'embedding_h3072'; // 3072 dims exige halfvec: HNSW sobre `vector` está limitado a 2000
}

/**
 * Construye el índice HNSW sobre la PARTICIÓN de este modelo (migración 002: una partición por
 * `modelo_id` dentro de la tabla de su dimensión) — nunca sobre la tabla padre, que obligaría a
 * reconstruir el índice de cualquier otro modelo que ya tuviera uno.
 *
 * Se llama al **terminar con éxito un job de embeddings** (`ingestaService.ts`), no al activar el
 * modelo: la migración 002 ya explica por qué — construir el índice con los datos ya cargados es
 * ~10× más rápido que insertar con el índice vivo. Activar el modelo ocurre ANTES de que exista
 * ningún vector; crear el índice ahí lo dejaría creciendo con cada INSERT desde el primer chunk,
 * justo el escenario que la migración evita a propósito.
 *
 * Idempotente (`IF NOT EXISTS`): un job de re-embedding incremental posterior no reconstruye
 * nada, solo confirma que el índice ya existe.
 */
export async function crearIndiceHnsw(modeloId: number, dimension: number): Promise<void> {
  const tabla = tablaVectores(dimension);
  const opsClass = tabla === 'embedding_h3072' ? 'halfvec_cosine_ops' : 'vector_cosine_ops';
  await appSequelize.query(
    `CREATE INDEX IF NOT EXISTS ${tabla}_p${modeloId}_hnsw_idx
       ON rag.${tabla}_p${modeloId} USING hnsw (vec ${opsClass})`,
  );
}
