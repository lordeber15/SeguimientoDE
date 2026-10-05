import { QueryTypes } from 'sequelize';
import { stdRagSequelize } from '../config/stdRagDatabase';
import { leerBooleano, leerNumero } from '../../../compartido/rag/configService';

/**
 * Mantenimiento periódico de `std_rag` — mismo diseño que `modulos/sgd/rag/mantenimientoService.ts`
 * (advisory lock propio, interruptores en `app.config` leídos en cada tick, retención ACTIVADA por
 * defecto y recolector de basura DESACTIVADO). Única diferencia real: la retención del SGD también
 * purga `app.login_intento` (intentos de login), que vive en `seguimiento_app` — `std_rag` no tiene
 * esa tabla (el login es el mismo del SGD, no se replica aquí), así que solo purga `uso_token` y
 * `retrieval_log`.
 */

const LOCK_ID = 815_243_102; // namespace propio, distinto de mantenimientoService.ts (815_243_002) y barridoStdService.ts (815_243_101)
const CADENCIA_HORAS = 24;

async function registrarMantenimiento(
  tipo: 'retencion' | 'gc',
  feInicio: Date,
  filasAfectadas: number,
  detalle: object | null,
  error?: string,
): Promise<void> {
  await stdRagSequelize.query(
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

export interface ResultadoRetencionStd {
  usoToken: number;
  retrievalLog: number;
}

export async function ejecutarRetencionStd(): Promise<ResultadoRetencionStd> {
  const inicio = new Date();
  try {
    const dias = await leerNumero('rag.retencion.dias', 180, stdRagSequelize);
    const corte = `now() - ($1 || ' days')::interval`;

    const usoToken = await stdRagSequelize.query<{ id: number }>(
      `DELETE FROM rag.uso_token WHERE fe < ${corte} RETURNING id`,
      { bind: [dias], type: QueryTypes.SELECT },
    );
    const retrievalLog = await stdRagSequelize.query<{ id: number }>(
      `DELETE FROM rag.retrieval_log WHERE fe < ${corte} RETURNING id`,
      { bind: [dias], type: QueryTypes.SELECT },
    );

    const resultado: ResultadoRetencionStd = {
      usoToken: usoToken.length,
      retrievalLog: retrievalLog.length,
    };
    await registrarMantenimiento('retencion', inicio, resultado.usoToken + resultado.retrievalLog, resultado);
    return resultado;
  } catch (error) {
    await registrarMantenimiento('retencion', inicio, 0, null, motivoDe(error));
    throw error;
  }
}

export interface ResultadoGCStd {
  marcados: number;
  recolectados: number;
  chunksBorrados: number;
}

/** Mismo algoritmo de tres pasos que `ejecutarGC` del SGD — ver sus comentarios para el razonamiento completo. */
export async function ejecutarGCStd(): Promise<ResultadoGCStd> {
  const inicio = new Date();
  try {
    const graciaDias = await leerNumero('rag.gc.gracia_dias', 30, stdRagSequelize);

    const marcados = await stdRagSequelize.query<{ sha256: string }>(
      `UPDATE rag.contenido c SET fe_huerfano = now()
        WHERE fe_huerfano IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM rag.documento d
             WHERE d.vigente AND (d.contenido_sha256 = c.sha256 OR d.sha256_anterior = c.sha256)
          )
        RETURNING c.sha256`,
      { type: QueryTypes.SELECT },
    );

    await stdRagSequelize.query(
      `UPDATE rag.contenido c SET fe_huerfano = NULL
        WHERE fe_huerfano IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM rag.documento d
             WHERE d.vigente AND (d.contenido_sha256 = c.sha256 OR d.sha256_anterior = c.sha256)
          )`,
      { type: QueryTypes.UPDATE },
    );

    const candidatos = await stdRagSequelize.query<{ sha256: string }>(
      `SELECT sha256 FROM rag.contenido
        WHERE fe_huerfano IS NOT NULL AND fe_huerfano < now() - ($1 || ' days')::interval`,
      { bind: [graciaDias], type: QueryTypes.SELECT },
    );

    let chunksBorrados = 0;
    for (const c of candidatos) {
      const filas = await stdRagSequelize.query<{ id: number }>(
        `DELETE FROM rag.chunk WHERE sha256 = $1 RETURNING id`,
        { bind: [c.sha256], type: QueryTypes.SELECT },
      );
      chunksBorrados += filas.length;
      await stdRagSequelize.query(
        `UPDATE rag.contenido SET chunks_generados = 0 WHERE sha256 = $1`,
        { bind: [c.sha256], type: QueryTypes.UPDATE },
      );
    }

    const resultado: ResultadoGCStd = {
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
  const filas = await stdRagSequelize.query<{ fe_inicio: string }>(
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

export function iniciarMantenimientoPeriodicoStd(): void {
  if (temporizador) return;

  const tick = async () => {
    const bloqueo = await stdRagSequelize.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', {
      bind: [LOCK_ID],
      type: QueryTypes.SELECT,
    });
    if (!bloqueo[0]?.ok) return;

    try {
      if ((await leerBooleano('rag.retencion.activa', true, stdRagSequelize)) && (await tocaCorrer('retencion'))) {
        const r = await ejecutarRetencionStd();
        console.log(`Mantenimiento STD: retención purgó ${r.usoToken} uso_token, ${r.retrievalLog} retrieval_log.`);
      }
      if ((await leerBooleano('rag.gc.activo', false, stdRagSequelize)) && (await tocaCorrer('gc'))) {
        const r = await ejecutarGCStd();
        console.log(
          `Mantenimiento STD: GC marcó ${r.marcados} contenido(s) huérfano(s) nuevo(s) y recolectó `
            + `${r.recolectados} (${r.chunksBorrados} chunks borrados, markdown conservado).`,
        );
      }
    } catch (error) {
      console.error('Mantenimiento periódico del STD falló:', error);
    } finally {
      await stdRagSequelize.query('SELECT pg_advisory_unlock($1)', { bind: [LOCK_ID], type: QueryTypes.SELECT });
    }
  };

  temporizador = setInterval(() => void tick(), 3_600_000);
  temporizador.unref();
}
