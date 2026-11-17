import { consultarStd } from '../config/stdDatabase';

/**
 * Lecturas EN VIVO del STD para el chat con consultas estructuradas (docs/PLAN-CHAT-CONSULTAS.md,
 * Fase 7): metadatos por documento (para sincronizar `rag.documento_std`), estado del trámite y
 * movimientos con sus observaciones (las "indicaciones" del STD). Solo SELECT, como todo acceso al
 * STD (`consultarStd`). Esquema: skill `std-database`.
 *
 * Estado de un documento, medido sobre `tbl_documento_mov` (estados 1 Pendiente, 2 Derivado,
 * 3 Archivado): cada derivación queda en 1 hasta que su destinatario la deriva (2) o la archiva (3).
 * Un documento sigue EN TRÁMITE mientras tenga alguna derivación pendiente que no sea copia
 * (`flg_copia = 0`: las copias informativas quedan pendientes para siempre); si no le queda
 * ninguna, está ARCHIVADO. Es la misma lectura que la bandeja del STD.
 */

/** Personas genéricas que no son participantes reales: 1 y 580 = "N/D" (skill `std-database`). */
const PERSONAS_GENERICAS = '1, 580';

export interface MetadatosDocumentoStd {
  id_documento: number;
  documento: string | null;
  tipo_doc: string | null;
  origen_doc: string | null;
  asunto: string | null;
  fecha: string | null;
  flg_confidencial: number | null;
  etiquetas: string | null;
  remitente: string | null;
  remitente_entidad: string | null;
  area_origen: string | null;
}

export async function leerMetadatosDocumentosStd(ids: number[]): Promise<MetadatosDocumentoStd[]> {
  if (ids.length === 0) return [];
  return consultarStd<MetadatosDocumentoStd>(
    `SELECT d.id_documento, d.documento, td.tipo_documento AS tipo_doc, od.origen_documento AS origen_doc,
            d.asunto, d.fecha, d.flg_confidencial, NULLIF(TRIM(d.etiquetas), '') AS etiquetas,
            NULLIF(TRIM(rp.nombre), '') AS remitente,
            NULLIF(TRIM(COALESCE(rp.razon_social, rp.entidad)), '') AS remitente_entidad,
            (SELECT NULLIF(CONCAT_WS(' - ', ar.sigla, ar.area), '')
               FROM tbl_documento_mov m
               LEFT JOIN tbl_area ar ON ar.id_area = m.id_area_origen
              WHERE m.id_documento = d.id_documento
              ORDER BY m.id_documento_mov
              LIMIT 1) AS area_origen
       FROM tbl_documento d
       JOIN tbl_tipo_documento td ON td.id_tipo_documento = d.id_tipo_documento
       JOIN tbl_origen_documento od ON od.id_origen_documento = d.id_origen_documento
       LEFT JOIN tbl_persona rp ON rp.id_persona = d.id_remitente
      WHERE d.id_documento IN (:ids)`,
    { ids },
  );
}

export interface EstadoVivoDocumentoStd {
  /** AAAA-MM-DD del último movimiento. */
  ultimoMovimiento: string | null;
  /** Área (sigla) donde está pendiente la derivación más reciente; null si archivado. */
  areaActual: string | null;
  archivado: boolean;
  /** AAAA-MM-DD del último archivo. */
  feArchivo: string | null;
  /** Movimiento en los últimos N meses (D5: "actualmente", aunque esté archivado). */
  actual: boolean;
}

/** Estado vivo de varios documentos en dos consultas. Un documento sin movimientos no figura. */
export async function estadoVivoDocumentosStd(ids: number[], mesesActual: number): Promise<Map<number, EstadoVivoDocumentoStd>> {
  const resultado = new Map<number, EstadoVivoDocumentoStd>();
  if (ids.length === 0) return resultado;

  const [resumen, pendientes] = await Promise.all([
    consultarStd<{ id_documento: number; ultimo: string | null; pendientes: number | string; fe_archivo: string | null; actual: number | string }>(
      `SELECT m.id_documento,
              DATE_FORMAT(MAX(m.creado), '%Y-%m-%d') AS ultimo,
              SUM(m.id_estado = 1 AND m.flg_copia = 0) AS pendientes,
              DATE_FORMAT(MAX(CASE WHEN m.id_estado IN (3, 5) THEN COALESCE(m.fecha_atendido, m.modificado) END), '%Y-%m-%d') AS fe_archivo,
              MAX(m.creado) >= (NOW() - INTERVAL :meses MONTH) AS actual
         FROM tbl_documento_mov m
        WHERE m.id_documento IN (:ids)
        GROUP BY m.id_documento`,
      { ids, meses: Math.max(1, Math.round(mesesActual)) },
    ),
    consultarStd<{ id_documento: number; area: string | null; persona: string | null }>(
      `SELECT m.id_documento, ar.sigla AS area, NULLIF(TRIM(p.nombre), '') AS persona
         FROM tbl_documento_mov m
         LEFT JOIN tbl_area ar ON ar.id_area = m.id_area_destino
         LEFT JOIN tbl_persona p ON p.id_persona = m.id_destino AND p.id_persona NOT IN (${PERSONAS_GENERICAS})
        WHERE m.id_documento IN (:ids) AND m.id_estado = 1 AND m.flg_copia = 0
        ORDER BY m.id_documento_mov DESC`,
      { ids },
    ),
  ]);

  const areaPendiente = new Map<number, string | null>();
  for (const p of pendientes) {
    const id = Number(p.id_documento);
    if (!areaPendiente.has(id)) areaPendiente.set(id, p.area ?? p.persona);
  }
  for (const r of resumen) {
    const id = Number(r.id_documento);
    const archivado = Number(r.pendientes) === 0;
    resultado.set(id, {
      ultimoMovimiento: r.ultimo,
      areaActual: archivado ? null : areaPendiente.get(id) ?? null,
      archivado,
      feArchivo: archivado ? r.fe_archivo : null,
      actual: Number(r.actual) === 1,
    });
  }
  return resultado;
}

export interface MovimientoStd {
  id_documento: number;
  id_documento_mov: number;
  /** AAAA-MM-DD. */
  fecha: string | null;
  area_origen: string | null;
  origen: string | null;
  area_destino: string | null;
  destino: string | null;
  accion: string | null;
  estado: string | null;
  observacion: string | null;
  copia: number;
}

/**
 * Movimientos de varios documentos, en orden (participantes, trámite, indicaciones), sin las
 * personas genéricas "N/D" y, salvo que se pidan, sin las copias informativas.
 */
export async function movimientosDocumentosStd(ids: number[], incluirCopias = false): Promise<MovimientoStd[]> {
  if (ids.length === 0) return [];
  return consultarStd<MovimientoStd>(
    `SELECT m.id_documento, m.id_documento_mov, DATE_FORMAT(m.creado, '%Y-%m-%d') AS fecha,
            ao.sigla AS area_origen, CASE WHEN m.id_origen IN (${PERSONAS_GENERICAS}) THEN NULL ELSE NULLIF(TRIM(po.nombre), '') END AS origen,
            ad.sigla AS area_destino, CASE WHEN m.id_destino IN (${PERSONAS_GENERICAS}) THEN NULL ELSE NULLIF(TRIM(pd.nombre), '') END AS destino,
            ac.accion, e.estado, NULLIF(TRIM(m.observaciones), '') AS observacion, m.flg_copia AS copia
       FROM tbl_documento_mov m
       LEFT JOIN tbl_persona po ON po.id_persona = m.id_origen
       LEFT JOIN tbl_persona pd ON pd.id_persona = m.id_destino
       LEFT JOIN tbl_area ao ON ao.id_area = m.id_area_origen
       LEFT JOIN tbl_area ad ON ad.id_area = m.id_area_destino
       LEFT JOIN tbl_accion ac ON ac.id_accion = m.id_accion
       LEFT JOIN tbl_estado e ON e.id_estado = m.id_estado
      WHERE m.id_documento IN (:ids) ${incluirCopias ? '' : 'AND m.flg_copia = 0'}
      ORDER BY m.id_documento, m.id_documento_mov`,
    { ids },
  );
}
