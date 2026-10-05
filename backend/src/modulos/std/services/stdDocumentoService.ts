import { consultarStd } from '../config/stdDatabase';

/**
 * Consultas de solo lectura sobre la BD del STD para el barrido y la ingesta. Ver la skill
 * `std-database` para el esquema completo; aquí solo lo que hace falta para detectar y traer los
 * PDF de cada documento.
 *
 * Tres fuentes de archivo por documento (`id_documento`):
 *   1. `tbl_documento.id_adjunto`            → origen 'principal'
 *   2. `tbl_documento_adjunto`                → origen 'anexo'
 *   3. `tbl_documento_mov_adjunto` (vía `tbl_documento_mov.id_documento`) → origen 'derivacion'
 *
 * Solo entran los adjuntos que son PDF de verdad: `id_tipo_adjunto <> 10` descarta los externos
 * del SISEM (no tienen archivo local), `tamano > 0` descarta los 45 adjuntos vacíos, y el OR de
 * mime/nombre cubre los dos formatos de `mime` que coexisten en esta BD (ver la skill).
 *
 * Nunca se usan funciones ni procedimientos almacenados del STD (`fn_getPersona`,
 * `sp_replace_adjunto`): el usuario de solo lectura puede no tener `EXECUTE`, y de todos modos
 * `consultarStd` solo admite SELECT/WITH.
 */

const FILTRO_PDF = `a.id_tipo_adjunto <> 10 AND a.tamano > 0
    AND (a.mime LIKE 'application/pdf%' OR LOWER(a.nombre) LIKE '%.pdf')`;

export interface FilaWatermarkStd {
  id_documento: number;
  documento: string | null;
  adjuntos_pdf: number;
  watermark: string | null;
}

/**
 * Cedazo único: por cada documento con al menos un PDF (en cualquiera de las tres fuentes),
 * cuántos tiene y cuál es el más reciente `modificado` entre el documento, sus movimientos y sus
 * adjuntos. Se compara en memoria contra `rag.documento_std` — igual que el barrido del SGD, las
 * dos bases están en servidores distintos y no admiten JOIN.
 */
export async function leerWatermarksStd(): Promise<FilaWatermarkStd[]> {
  return consultarStd<FilaWatermarkStd>(`
    SELECT cand.id_documento, d.documento,
           -- Enlaces, no archivos distintos: es lo que guarda rag.documento (ver migración std/002).
           COUNT(*)                        AS adjuntos_pdf,
           MAX(cand.modificado)            AS watermark
    FROM (
      SELECT d.id_documento, d.id_adjunto, GREATEST(d.modificado, a.modificado) AS modificado
      FROM tbl_documento d
      JOIN tbl_adjunto a ON a.id_adjunto = d.id_adjunto
      WHERE d.id_adjunto IS NOT NULL AND ${FILTRO_PDF}

      UNION ALL

      SELECT da.id_documento, da.id_adjunto, GREATEST(da.modificado, a.modificado) AS modificado
      FROM tbl_documento_adjunto da
      JOIN tbl_adjunto a ON a.id_adjunto = da.id_adjunto
      WHERE ${FILTRO_PDF}

      UNION ALL

      SELECT dm.id_documento, dma.id_adjunto,
             GREATEST(dma.modificado, a.modificado, dm.modificado) AS modificado
      FROM tbl_documento_mov_adjunto dma
      JOIN tbl_documento_mov dm ON dm.id_documento_mov = dma.id_documento_mov
      JOIN tbl_adjunto a ON a.id_adjunto = dma.id_adjunto
      WHERE ${FILTRO_PDF}
    ) cand
    JOIN tbl_documento d ON d.id_documento = cand.id_documento
    GROUP BY cand.id_documento, d.documento
  `);
}

export type OrigenAdjuntoStd = 'principal' | 'anexo' | 'derivacion';

export interface FilaAdjuntoPdfStd {
  id_documento: number;
  origen: OrigenAdjuntoStd;
  id_documento_mov: number | null;
  id_adjunto: number;
  nombre_archivo: string | null;
  mime: string | null;
  sha1_std: string | null;
  tamano: number | null;
  documento: string | null;
  tipo_doc: string | null;
  origen_doc: string | null;
  asunto: string | null;
  fecha: string | null;
  flg_confidencial: number | null;
  remitente: string | null;
  area_origen: string | null;
}

interface FilaCruda {
  id_documento: number;
  id_documento_mov: number | null;
  id_adjunto: number;
  nombre_archivo: string | null;
  mime: string | null;
  sha1_std: string | null;
  tamano: number | null;
  documento: string | null;
  tipo_doc: string | null;
  origen_doc: string | null;
  asunto: string | null;
  fecha: string | null;
  flg_confidencial: number | null;
  remitente: string | null;
  area_origen: string | null;
}

const CAMPOS_COMUNES = `
  a.id_adjunto, a.nombre AS nombre_archivo, a.mime, a.hash AS sha1_std, a.tamano,
  d.documento, td.tipo_documento AS tipo_doc, od.origen_documento AS origen_doc,
  d.asunto, d.fecha, d.flg_confidencial`;

/**
 * PDF de los documentos pedidos, repartidos en sus tres orígenes. Se hacen tres consultas en
 * paralelo (una por fuente) en vez de una sola UNION: los JOIN de remitente/área difieren de
 * forma real entre el documento principal/anexo (remitente = `tbl_documento.id_remitente`, área
 * = área usuaria del documento) y una derivación (remitente = quien la envió, área = su área de
 * origen) — forzarlos a la misma forma de columnas habría sido menos claro que combinarlos aquí.
 */
export async function leerAdjuntosPdfStd(idsDocumento: number[]): Promise<FilaAdjuntoPdfStd[]> {
  if (idsDocumento.length === 0) return [];
  const ids = idsDocumento;

  const [principales, anexos, derivaciones] = await Promise.all([
    consultarStd<FilaCruda>(
      `SELECT d.id_documento, NULL AS id_documento_mov, ${CAMPOS_COMUNES},
              rp.nombre AS remitente, au.area_usuaria AS area_origen
         FROM tbl_documento d
         JOIN tbl_adjunto a ON a.id_adjunto = d.id_adjunto
         JOIN tbl_tipo_documento td ON td.id_tipo_documento = d.id_tipo_documento
         JOIN tbl_origen_documento od ON od.id_origen_documento = d.id_origen_documento
         LEFT JOIN tbl_persona rp ON rp.id_persona = d.id_remitente
         LEFT JOIN tbl_area_usuaria au ON au.id_area_usuaria = d.id_area_usuaria
        WHERE d.id_documento IN (:ids) AND ${FILTRO_PDF}`,
      { ids },
    ),
    consultarStd<FilaCruda>(
      `SELECT d.id_documento, NULL AS id_documento_mov, ${CAMPOS_COMUNES},
              rp.nombre AS remitente, au.area_usuaria AS area_origen
         FROM tbl_documento_adjunto da
         JOIN tbl_documento d ON d.id_documento = da.id_documento
         JOIN tbl_adjunto a ON a.id_adjunto = da.id_adjunto
         JOIN tbl_tipo_documento td ON td.id_tipo_documento = d.id_tipo_documento
         JOIN tbl_origen_documento od ON od.id_origen_documento = d.id_origen_documento
         LEFT JOIN tbl_persona rp ON rp.id_persona = d.id_remitente
         LEFT JOIN tbl_area_usuaria au ON au.id_area_usuaria = d.id_area_usuaria
        WHERE da.id_documento IN (:ids) AND ${FILTRO_PDF}`,
      { ids },
    ),
    consultarStd<FilaCruda>(
      `SELECT dm.id_documento, dm.id_documento_mov, ${CAMPOS_COMUNES},
              op.nombre AS remitente, ao.area AS area_origen
         FROM tbl_documento_mov_adjunto dma
         JOIN tbl_documento_mov dm ON dm.id_documento_mov = dma.id_documento_mov
         JOIN tbl_documento d ON d.id_documento = dm.id_documento
         JOIN tbl_adjunto a ON a.id_adjunto = dma.id_adjunto
         JOIN tbl_tipo_documento td ON td.id_tipo_documento = d.id_tipo_documento
         JOIN tbl_origen_documento od ON od.id_origen_documento = d.id_origen_documento
         LEFT JOIN tbl_persona op ON op.id_persona = dm.id_origen
         LEFT JOIN tbl_area ao ON ao.id_area = dm.id_area_origen
        WHERE dm.id_documento IN (:ids) AND ${FILTRO_PDF}`,
      { ids },
    ),
  ]);

  return [
    ...principales.map((f) => ({ ...f, origen: 'principal' as const })),
    ...anexos.map((f) => ({ ...f, origen: 'anexo' as const })),
    ...derivaciones.map((f) => ({ ...f, origen: 'derivacion' as const })),
  ];
}

export interface FilaAdjuntoStd {
  adjunto: string;
  hash: string | null;
}

/** `tbl_adjunto.adjunto` (la clave física de 40 hex) de un `id_adjunto`, para resolver su ruta en disco. */
export async function leerClaveAdjuntoStd(idAdjunto: number): Promise<FilaAdjuntoStd | undefined> {
  const [fila] = await consultarStd<FilaAdjuntoStd>(
    'SELECT adjunto, hash FROM tbl_adjunto WHERE id_adjunto = :id',
    { id: idAdjunto },
  );
  return fila;
}
