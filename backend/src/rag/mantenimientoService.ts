import { QueryTypes } from 'sequelize';
import { appSequelize } from '../config/appDatabase';
import { leerBooleano, leerNumero } from './configService';

/**
 * Mantenimiento periódico de la base RAG (Fase 6, PLAN-RAG.md §6.6 y riesgo #12): retención de
 * logs sin límite y recolector de basura de contenidos huérfanos.
 *
 * Mismo patrón que `barridoService.ts`: `setInterval` que comprueba el interruptor y la cadencia
 * en `app.config` en cada tick (sin caché, así que un cambio surte efecto sin reiniciar), y un
 * advisory lock propio para no solaparse con otro tick ni con otra instancia del backend.
 *
 * Retención y recolector arrancan con interruptores DISTINTOS a propósito: la retención solo
 * purga ruido de auditoría/depuración sin valor a largo plazo (arranca ACTIVADA, "desde el día
 * 1" según el riesgo #12); el recolector borra datos ya ingeridos —aunque D1 los haga baratos de
 * reconstruir—, así que arranca DESACTIVADO, igual que el barrido (D8): control total al
 * principio, decisión del administrador encenderlo.
 */

const LOCK_ID = 815_243_002; // distinto del de barridoService.ts (815_243_001)
const CADENCIA_HORAS = 24;

async function registrarMantenimiento(
  tipo: 'retencion' | 'gc',
  feInicio: Date,
  filasAfectadas: number,
  detalle: object | null,
  error?: string,
): Promise<void> {
  await appSequelize.query(
    `INSERT INTO rag.mantenimiento (tipo, fe_inicio, fe_fin, filas_afectadas, detalle, error)
     VALUES ($1, $2, now(), $3, $4::jsonb, $5)`,
    {
      bind: [tipo, feInicio, filasAfectadas, detalle ? JSON.stringify(detalle) : null, error ?? null],
      type: QueryTypes.INSERT,
    },
  );
}

function motivoDe(error: unknown): string {
  return error instanceof Error ? error.message : 'error desconocido';
}

export interface ResultadoRetencion {
  loginIntento: number;
  usoToken: number;
  retrievalLog: number;
}

/** Purga `app.login_intento`, `rag.uso_token` y `rag.retrieval_log` más viejos que el corte configurado. */
export async function ejecutarRetencion(): Promise<ResultadoRetencion> {
  const inicio = new Date();
  try {
    const dias = await leerNumero('rag.retencion.dias', 180);
    const corte = `now() - ($1 || ' days')::interval`;

    const loginIntento = await appSequelize.query<{ id: number }>(
      `DELETE FROM app.login_intento WHERE fe_intento < ${corte} RETURNING id`,
      { bind: [dias], type: QueryTypes.SELECT },
    );
    const usoToken = await appSequelize.query<{ id: number }>(
      `DELETE FROM rag.uso_token WHERE fe < ${corte} RETURNING id`,
      { bind: [dias], type: QueryTypes.SELECT },
    );
    const retrievalLog = await appSequelize.query<{ id: number }>(
      `DELETE FROM rag.retrieval_log WHERE fe < ${corte} RETURNING id`,
      { bind: [dias], type: QueryTypes.SELECT },
    );

    const resultado: ResultadoRetencion = {
      loginIntento: loginIntento.length,
      usoToken: usoToken.length,
      retrievalLog: retrievalLog.length,
    };
    await registrarMantenimiento(
      'retencion', inicio,
      resultado.loginIntento + resultado.usoToken + resultado.retrievalLog,
      resultado,
    );
    return resultado;
  } catch (error) {
    await registrarMantenimiento('retencion', inicio, 0, null, motivoDe(error));
    throw error;
  }
}

export interface ResultadoGC {
  marcados: number;
  recolectados: number;
  chunksBorrados: number;
}

/**
 * Recolector de basura de contenidos huérfanos (PLAN-RAG.md §6.6).
 *
 * Tres pasos en cada corrida:
 * 1. Marca como huérfano (`fe_huerfano = now()`) el contenido que YA no referencia ningún
 *    documento vivo, ni por `contenido_sha256` ni por `sha256_anterior` — arranca el reloj de
 *    gracia. Idempotente: si ya estaba marcado, no se toca.
 * 2. Desmarca el que un barrido posterior volvió a referenciar — el margen de gracia existe
 *    justo para este caso.
 * 3. Recolecta de verdad el que lleva huérfano más que `rag.gc.gracia_dias`: borra sus
 *    `rag.chunk` (que en cascada borra sus embeddings en las tres tablas de dimensión — migración
 *    002), y **nunca** su fila en `rag.contenido`: el markdown se conserva siempre (D1).
 *    `chunks_generados` se resetea a 0 para que la ingesta lo sepa si alguien vuelve a subir el
 *    mismo archivo — ver el arreglo en `ingestaService.ts` que re-trocea desde el markdown en
 *    ese caso, en vez de asumir que los chunks siguen ahí.
 */
export async function ejecutarGC(): Promise<ResultadoGC> {
  const inicio = new Date();
  try {
    const graciaDias = await leerNumero('rag.gc.gracia_dias', 30);

    const marcados = await appSequelize.query<{ sha256: string }>(
      `UPDATE rag.contenido c SET fe_huerfano = now()
        WHERE fe_huerfano IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM rag.documento d
             WHERE d.vigente AND (d.contenido_sha256 = c.sha256 OR d.sha256_anterior = c.sha256)
          )
        RETURNING c.sha256`,
      { type: QueryTypes.SELECT },
    );

    await appSequelize.query(
      `UPDATE rag.contenido c SET fe_huerfano = NULL
        WHERE fe_huerfano IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM rag.documento d
             WHERE d.vigente AND (d.contenido_sha256 = c.sha256 OR d.sha256_anterior = c.sha256)
          )`,
      { type: QueryTypes.UPDATE },
    );

    const candidatos = await appSequelize.query<{ sha256: string }>(
      `SELECT sha256 FROM rag.contenido
        WHERE fe_huerfano IS NOT NULL AND fe_huerfano < now() - ($1 || ' days')::interval`,
      { bind: [graciaDias], type: QueryTypes.SELECT },
    );

    let chunksBorrados = 0;
    for (const c of candidatos) {
      const filas = await appSequelize.query<{ id: number }>(
        `DELETE FROM rag.chunk WHERE sha256 = $1 RETURNING id`,
        { bind: [c.sha256], type: QueryTypes.SELECT },
      );
      chunksBorrados += filas.length;
      await appSequelize.query(
        `UPDATE rag.contenido SET chunks_generados = 0 WHERE sha256 = $1`,
        { bind: [c.sha256], type: QueryTypes.UPDATE },
      );
    }

    const resultado: ResultadoGC = {
      marcados: marcados.length,
      recolectados: candidatos.length,
      chunksBorrados,
    };
    await registrarMantenimiento('gc', inicio, resultado.recolectados, resultado);
    return resultado;
  } catch (error) {
    await registrarMantenimiento('gc', inicio, 0, null, motivoDe(error));
    throw error;
  }
}

async function ultimaEjecucionExitosa(tipo: 'retencion' | 'gc'): Promise<Date | null> {
  const filas = await appSequelize.query<{ fe_inicio: string }>(
    `SELECT fe_inicio::text FROM rag.mantenimiento
      WHERE tipo = $1 AND error IS NULL ORDER BY fe_inicio DESC LIMIT 1`,
    { bind: [tipo], type: QueryTypes.SELECT },
  );
  return filas[0] ? new Date(filas[0].fe_inicio) : null;
}

async function tocaCorrer(tipo: 'retencion' | 'gc'): Promise<boolean> {
  const ultima = await ultimaEjecucionExitosa(tipo);
  return !ultima || Date.now() - ultima.getTime() > CADENCIA_HORAS * 3_600_000;
}

let temporizador: NodeJS.Timeout | null = null;

export function iniciarMantenimientoPeriodico(): void {
  if (temporizador) return;

  const tick = async () => {
    const bloqueo = await appSequelize.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', {
      bind: [LOCK_ID],
      type: QueryTypes.SELECT,
    });
    if (!bloqueo[0]?.ok) return; // otro tick (u otra instancia) ya está en ello

    try {
      if ((await leerBooleano('rag.retencion.activa', true)) && (await tocaCorrer('retencion'))) {
        const r = await ejecutarRetencion();
        console.log(
          `Mantenimiento: retención purgó ${r.loginIntento} login_intento, ${r.usoToken} `
            + `uso_token, ${r.retrievalLog} retrieval_log.`,
        );
      }
      if ((await leerBooleano('rag.gc.activo', false)) && (await tocaCorrer('gc'))) {
        const r = await ejecutarGC();
        console.log(
          `Mantenimiento: GC marcó ${r.marcados} contenido(s) huérfano(s) nuevo(s) y recolectó `
            + `${r.recolectados} (${r.chunksBorrados} chunks borrados, markdown conservado).`,
        );
      }
    } catch (error) {
      console.error('Mantenimiento periódico falló:', error);
    } finally {
      await appSequelize.query('SELECT pg_advisory_unlock($1)', { bind: [LOCK_ID], type: QueryTypes.SELECT });
    }
  };

  // Comprueba cada hora si toca correr; la cadencia real (24 h) se decide dentro de `tocaCorrer`.
  temporizador = setInterval(() => void tick(), 3_600_000);
  temporizador.unref();
}
