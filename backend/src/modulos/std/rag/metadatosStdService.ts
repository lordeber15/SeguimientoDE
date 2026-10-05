import { QueryTypes } from 'sequelize';
import { stdRagSequelize } from '../config/stdRagDatabase';
import { leerMetadatosDocumentosStd } from '../services/stdConsultasService';

/**
 * Copia en `rag.documento_std` lo que identifica a cada documento en el STD (asunto, tipo, origen,
 * remitente con su entidad, N° de contrato en `etiquetas`, área de origen) — la base de la búsqueda
 * por metadatos del chat (docs/PLAN-CHAT-CONSULTAS.md, Fase 7; migración std/003).
 *
 * - El barrido la llama con los documentos que cambiaron (un cambio en `tbl_documento` mueve su
 *   watermark), así que se mantiene al día sola.
 * - `soloPendientes` completa los que nunca se sincronizaron (`fe_metadatos IS NULL`): la carga
 *   inicial tras la migración, que corre al arrancar el backend.
 */

const LOTE = 2000;

let enCurso: Promise<number> | null = null;

export async function sincronizarMetadatosStd(opciones: { ids?: number[]; soloPendientes?: boolean } = {}): Promise<number> {
  let ids = opciones.ids;
  if (!ids) {
    const filas = await stdRagSequelize.query<{ id_documento: string }>(
      `SELECT id_documento FROM rag.documento_std
        ${opciones.soloPendientes ? 'WHERE fe_metadatos IS NULL' : ''}
        ORDER BY id_documento`,
      { type: QueryTypes.SELECT },
    );
    ids = filas.map((f) => Number(f.id_documento));
  }

  let actualizados = 0;
  for (let i = 0; i < ids.length; i += LOTE) {
    const lote = ids.slice(i, i + LOTE);
    const meta = await leerMetadatosDocumentosStd(lote);
    if (meta.length === 0) continue;
    // UPDATE ... FROM unnest(...) AS t(...): el SET lee `t.columna` (el valor de ESTA fila), nunca
    // el `$N` crudo — ver la advertencia en `barridoStdService.actualizarDocumentosStd`.
    await stdRagSequelize.query(
      `UPDATE rag.documento_std ds SET
         documento = COALESCE(t.documento, ds.documento), tipo_doc = t.tipo_doc, origen_doc = t.origen_doc,
         asunto = t.asunto, fecha = t.fecha, flg_confidencial = t.confidencial, etiquetas = t.etiquetas,
         remitente = t.remitente, remitente_entidad = t.entidad, area_origen = t.area, fe_metadatos = now()
       FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::date[], $7::boolean[],
                   $8::text[], $9::text[], $10::text[], $11::text[])
            AS t(id, documento, tipo_doc, origen_doc, asunto, fecha, confidencial, etiquetas, remitente, entidad, area)
       WHERE ds.id_documento = t.id`,
      {
        bind: [
          meta.map((m) => m.id_documento),
          meta.map((m) => m.documento),
          meta.map((m) => m.tipo_doc),
          meta.map((m) => m.origen_doc),
          meta.map((m) => m.asunto),
          // MariaDB guarda fechas imposibles ("0003-10-04"): fuera de rango, sin fecha.
          meta.map((m) => (m.fecha && m.fecha >= '1990-01-01' && m.fecha <= '2100-01-01' ? m.fecha.slice(0, 10) : null)),
          meta.map((m) => Boolean(m.flg_confidencial)),
          meta.map((m) => m.etiquetas),
          meta.map((m) => m.remitente),
          meta.map((m) => m.remitente_entidad),
          meta.map((m) => m.area_origen),
        ],
        type: QueryTypes.UPDATE,
      },
    );
    actualizados += meta.length;
    await new Promise((r) => setImmediate(r));
  }
  return actualizados;
}

/** Carga inicial en segundo plano (al arrancar): una sola a la vez, y nunca tumba el arranque. */
export function sincronizarMetadatosPendientesStd(): Promise<number> {
  if (!enCurso) {
    enCurso = sincronizarMetadatosStd({ soloPendientes: true })
      .catch((error) => {
        console.error('Sincronización de metadatos del STD falló:', error);
        return 0;
      })
      .finally(() => { enCurso = null; });
  }
  return enCurso;
}
