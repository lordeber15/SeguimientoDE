import { QueryTypes } from 'sequelize';
import { stdRagSequelize } from '../config/stdRagDatabase';
import {
  leerAdjuntosPdfStd,
  leerWatermarksStd,
  type FilaAdjuntoPdfStd,
  type FilaWatermarkStd,
} from '../services/stdDocumentoService';
import { leerBooleano, leerNumero } from '../../../compartido/rag/configService';

/**
 * Barrido de detección incremental del STD — mismo diseño que `barridoService.ts` del SGD
 * (ver docs/PLAN-RAG.md §6), adaptado a que aquí el ancla es el DOCUMENTO
 * (`rag.documento_std`), no el expediente: el STD no tiene expedientes.
 *
 * Detecta, no ingesta: nunca encola trabajo por su cuenta. La cadencia es mucho más laxa que la
 * del SGD (24 h por defecto, en `rag.barrido.cadencia_min` de `std_rag`) porque el STD casi no
 * cambia — el grueso de su actividad hoy son movimientos sobre documentos ya existentes, no
 * documentos nuevos.
 */

const LOCK_ID = 815_243_101; // namespace propio, distinto del 815_243_001 del barrido SGD

export type DisparoBarridoStd = 'automatico' | 'manual';

export interface ResultadoBarridoStd {
  id: number | null;
  documentosRevisados: number;
  documentosNuevos: number;
  documentosCambiados: number;
  ms: number;
}

export class BarridoStdOcupado extends Error {
  constructor() {
    super('Ya hay un barrido del STD en curso');
    this.name = 'BarridoStdOcupado';
  }
}

export async function barrerStd(disparo: DisparoBarridoStd = 'manual'): Promise<ResultadoBarridoStd> {
  const inicio = Date.now();

  const bloqueo = await stdRagSequelize.query<{ ok: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS ok',
    { bind: [LOCK_ID], type: QueryTypes.SELECT },
  );
  if (!bloqueo[0]?.ok) throw new BarridoStdOcupado();

  const [{ id }] = await stdRagSequelize.query<{ id: number }>(
    "INSERT INTO rag.barrido (tipo, disparo) VALUES ('documento', $1) RETURNING id",
    { bind: [disparo], type: QueryTypes.SELECT },
  );

  const conteo = { revisados: 0, nuevos: 0, cambiados: 0 };

  try {
    const watermarks = await leerWatermarksStd();
    conteo.revisados = watermarks.length;

    const conocidos = await stdRagSequelize.query<{
      id_documento: number;
      adjuntos_pdf_std: number;
      watermark_std: string | null;
    }>('SELECT id_documento, adjuntos_pdf_std, watermark_std FROM rag.documento_std', {
      type: QueryTypes.SELECT,
    });
    // `Number(...)` en ambos lados: `id_documento` es `bigint` en Postgres, que `pg` devuelve
    // como STRING, mientras que MariaDB (vía mysql2) devuelve su INT como `number` — sin
    // normalizar, el Map nunca encontraba coincidencia y CADA barrido reprocesaba el corpus
    // entero como si todo hubiera cambiado. (El SGD nunca tropezó con esto porque sus claves de
    // expediente son `text` en ambos lados, no `bigint`.)
    const porId = new Map(conocidos.map((c) => [Number(c.id_documento), c]));

    const cambiados = watermarks.filter((w) => {
      const previo = porId.get(Number(w.id_documento));
      if (!previo) return true;
      return (
        Number(previo.adjuntos_pdf_std) !== Number(w.adjuntos_pdf)
        || String(previo.watermark_std ?? '') !== String(w.watermark ?? '')
      );
    });

    // Lotes, igual razón que el SGD: no traer los metadatos de 60 mil documentos de una vez.
    const LOTE = 200;
    for (let i = 0; i < cambiados.length; i += LOTE) {
      const lote = cambiados.slice(i, i + LOTE);
      const adjuntos = await leerAdjuntosPdfStd(lote.map((w) => w.id_documento));

      const resumen = await sincronizarDocumentos(lote, adjuntos);
      conteo.nuevos += resumen.nuevos;
      conteo.cambiados += resumen.cambiados;

      await actualizarDocumentosStd(lote);
      await new Promise((r) => setImmediate(r));
    }

    await stdRagSequelize.query(
      `UPDATE rag.barrido SET fe_fin = now(), expedientes_revisados = $2,
              documentos_nuevos = $3, documentos_cambiados = $4
        WHERE id = $1`,
      { bind: [id, conteo.revisados, conteo.nuevos, conteo.cambiados], type: QueryTypes.UPDATE },
    );

    return {
      id,
      documentosRevisados: conteo.revisados,
      documentosNuevos: conteo.nuevos,
      documentosCambiados: conteo.cambiados,
      ms: Date.now() - inicio,
    };
  } catch (error) {
    await stdRagSequelize.query('UPDATE rag.barrido SET fe_fin = now(), error = $2 WHERE id = $1', {
      bind: [id, error instanceof Error ? error.message : 'error desconocido'],
      type: QueryTypes.UPDATE,
    });
    throw error;
  } finally {
    await stdRagSequelize.query('SELECT pg_advisory_unlock($1)', {
      bind: [LOCK_ID],
      type: QueryTypes.SELECT,
    });
  }
}

/**
 * Upsert de `rag.documento` por ENLACE: (id_adjunto, id_documento, origen, id_documento_mov) — un
 * mismo `tbl_adjunto` puede estar enlazado en varios sitios del STD y cada enlace es una fila (ver
 * la migración std/002; el contenido se sigue deduplicando por sha256). A diferencia
 * del SGD, aquí no hay "bajas" que detectar en este paso: el STD no marca sus adjuntos como
 * eliminados de una forma que el barrido deba vigilar — si algún día hiciera falta, iría aquí
 * mismo, igual que `reconciliarEstados()` en el SGD.
 */
async function sincronizarDocumentos(
  lote: { id_documento: number; documento: string | null }[],
  adjuntosCrudos: FilaAdjuntoPdfStd[],
): Promise<{ nuevos: number; cambiados: number }> {
  // Colapsa solo filas repetidas EN LA MISMA CLAVE de enlace (filas duplicadas dentro de una misma
  // tabla del STD, sin información distinta): Postgres no deja que un único INSERT ... ON CONFLICT
  // DO UPDATE toque dos veces la misma fila.
  const porEnlace = new Map<string, FilaAdjuntoPdfStd>();
  for (const a of adjuntosCrudos) {
    const clave = `${a.id_adjunto}|${a.id_documento}|${a.origen}|${a.id_documento_mov ?? 0}`;
    if (!porEnlace.has(clave)) porEnlace.set(clave, a);
  }
  const adjuntos = [...porEnlace.values()];
  if (adjuntos.length === 0) return { nuevos: 0, cambiados: 0 };

  // Da de alta primero los `rag.documento_std` que falten: `rag.documento.id_documento` tiene FK
  // hacia ahí, y el UPSERT de abajo fallaría para un documento visto por primera vez.
  await stdRagSequelize.query(
    `INSERT INTO rag.documento_std (id_documento, documento)
     SELECT * FROM unnest($1::bigint[], $2::text[])
     ON CONFLICT (id_documento) DO NOTHING`,
    {
      bind: [lote.map((w) => w.id_documento), lote.map((w) => w.documento)],
      type: QueryTypes.INSERT,
    },
  );

  const filas = await stdRagSequelize.query<{ inserted: boolean }>(
    `INSERT INTO rag.documento
       (id_adjunto, id_documento, origen, id_documento_mov, nro_std, documento, tipo_doc,
        origen_doc, asunto, fecha, remitente, area_origen, flg_confidencial, nombre_archivo, mime, sha1_std)
     SELECT * FROM unnest(
       $1::bigint[], $2::bigint[], $3::text[], $4::bigint[], $5::text[], $6::text[], $7::text[],
       $8::text[], $9::text[], $10::date[], $11::text[], $12::text[], $13::boolean[], $14::text[],
       $15::text[], $16::text[])
     ON CONFLICT (id_adjunto, id_documento, origen, (COALESCE(id_documento_mov, 0))) DO UPDATE SET
       documento = EXCLUDED.documento, tipo_doc = EXCLUDED.tipo_doc, origen_doc = EXCLUDED.origen_doc,
       asunto = EXCLUDED.asunto, fecha = EXCLUDED.fecha, remitente = EXCLUDED.remitente,
       area_origen = EXCLUDED.area_origen, flg_confidencial = EXCLUDED.flg_confidencial,
       nombre_archivo = EXCLUDED.nombre_archivo, mime = EXCLUDED.mime, sha1_std = EXCLUDED.sha1_std
     RETURNING (xmax = 0) AS inserted`,
    {
      bind: [
        adjuntos.map((a) => a.id_adjunto),
        adjuntos.map((a) => a.id_documento),
        adjuntos.map((a) => a.origen),
        adjuntos.map((a) => a.id_documento_mov),
        adjuntos.map((a) => String(a.id_documento)),
        adjuntos.map((a) => a.documento),
        adjuntos.map((a) => a.tipo_doc),
        adjuntos.map((a) => a.origen_doc),
        adjuntos.map((a) => a.asunto),
        adjuntos.map((a) => a.fecha),
        adjuntos.map((a) => a.remitente),
        adjuntos.map((a) => a.area_origen),
        adjuntos.map((a) => Boolean(a.flg_confidencial)),
        adjuntos.map((a) => a.nombre_archivo),
        adjuntos.map((a) => a.mime),
        adjuntos.map((a) => a.sha1_std),
      ],
      type: QueryTypes.SELECT,
    },
  );

  return {
    nuevos: filas.filter((f) => f.inserted).length,
    cambiados: filas.length - filas.filter((f) => f.inserted).length,
  };
}

async function actualizarDocumentosStd(watermarks: FilaWatermarkStd[]): Promise<void> {
  if (watermarks.length === 0) return;

  // OJO: en `UPDATE ... FROM unnest(...) AS t(...)`, el SET debe referirse a `t.columna`, nunca
  // al `$N` crudo — `$N` es el ARRAY completo que se le pasó a `unnest`, no el valor de esta
  // fila. Por eso aquí (al revés que en `sincronizarDocumentos`, que sí hace un UPDATE...FROM
  // correcto porque solo lee `t.*` en el WHERE) se usa el mismo patrón INSERT ON CONFLICT que ya
  // usa `actualizarExpedientes` en el barrido del SGD, donde `EXCLUDED.columna` sí es por fila.
  await stdRagSequelize.query(
    `INSERT INTO rag.documento_std (id_documento, documento, adjuntos_pdf_std, watermark_std, fe_ultimo_barrido)
     SELECT * FROM unnest($1::bigint[], $2::text[], $3::int[], $4::text[]),
                  LATERAL (SELECT now()) AS t(fe)
     ON CONFLICT (id_documento) DO UPDATE SET
       documento = COALESCE(EXCLUDED.documento, rag.documento_std.documento),
       adjuntos_pdf_std = EXCLUDED.adjuntos_pdf_std,
       watermark_std = EXCLUDED.watermark_std,
       fe_ultimo_barrido = now()`,
    {
      bind: [
        watermarks.map((w) => w.id_documento),
        watermarks.map((w) => w.documento),
        watermarks.map((w) => Number(w.adjuntos_pdf)),
        watermarks.map((w) => w.watermark),
      ],
      type: QueryTypes.INSERT,
    },
  );

  await refrescarContadoresStd(watermarks.map((w) => w.id_documento));
}

async function refrescarContadoresStd(idsDocumento: number[]): Promise<void> {
  if (idsDocumento.length === 0) return;
  await stdRagSequelize.query(
    `UPDATE rag.documento_std ds SET
       docs_ingestados = c.ok,
       docs_pendientes = c.pendientes,
       docs_sin_texto  = c.sin_texto
     FROM (
       SELECT d.id_documento,
              count(*) FILTER (WHERE d.estado = 'ok')::int AS ok,
              count(*) FILTER (WHERE d.estado IN ('pendiente','en_proceso','convertido'))::int AS pendientes,
              count(*) FILTER (WHERE d.estado = 'sin_texto')::int AS sin_texto
         FROM rag.documento d
        WHERE d.vigente AND d.id_documento = ANY($1::bigint[])
        GROUP BY d.id_documento
     ) c
     WHERE ds.id_documento = c.id_documento`,
    { bind: [idsDocumento], type: QueryTypes.UPDATE },
  );
}

// ── Planificador ─────────────────────────────────────────────────────────────

let temporizador: NodeJS.Timeout | null = null;

export function iniciarPlanificadorBarridoStd(): void {
  if (temporizador) return;

  const tick = async () => {
    try {
      if (!(await leerBooleano('rag.barrido.activo', false, stdRagSequelize))) return;

      const cadencia = await leerNumero('rag.barrido.cadencia_min', 1440, stdRagSequelize);
      const ultimo = await stdRagSequelize.query<{ minutos: number | null }>(
        `SELECT EXTRACT(EPOCH FROM (now() - max(fe_inicio)))/60 AS minutos
           FROM rag.barrido WHERE tipo = 'documento'`,
        { type: QueryTypes.SELECT },
      );

      const minutos = ultimo[0]?.minutos;
      if (minutos !== null && minutos !== undefined && minutos < cadencia) return;

      const resultado = await barrerStd('automatico');
      console.log(
        `Barrido STD: ${resultado.documentosRevisados} documentos, `
          + `${resultado.documentosNuevos} nuevos, ${resultado.documentosCambiados} cambiados, ${resultado.ms} ms`,
      );
    } catch (error) {
      if (error instanceof BarridoStdOcupado) return;
      console.error('Barrido automático del STD falló:', error);
    }
  };

  temporizador = setInterval(() => void tick(), 60_000);
  temporizador.unref();
}
