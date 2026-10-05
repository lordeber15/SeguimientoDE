import { QueryTypes } from 'sequelize';
import { DB_SCHEMA, sequelize } from '../config/database';

const S = DB_SCHEMA;

/**
 * Estado EN VIVO de un lote de expedientes, leído del SGD (docs/PLAN-CHAT-CONSULTAS.md, D1): el
 * último movimiento y si quedó archivado. A propósito no sale de la copia en `rag.*` ni de
 * `dashboard.paso`: esas copias dependen de que el barrido / el refresco del dashboard hayan
 * corrido, y "¿sigue en trámite?" es justo la pregunta que no admite un dato viejo.
 *
 * Archivado = el ÚLTIMO paso del expediente quedó en `es_doc_rec = '3'` — mismo criterio que
 * `cerrado` en `calidadProcesosService`. "Algún destino archivado" no sirve: un expediente vivo
 * puede tener una rama archivada (Fase 0).
 *
 * Una consulta por lote, no una por expediente.
 */

export interface EstadoVivoExpediente {
  /** Fecha (AAAA-MM-DD) del movimiento más reciente: emisión, recepción o archivo. */
  ultimoMovimiento: string | null;
  /** Dependencia donde quedó el último paso (destino; si no hay destino, la emisora). */
  dependenciaActual: string | null;
  archivado: boolean;
  /** Fecha (AAAA-MM-DD) del archivo del último paso, si está archivado. */
  feArchivo: string | null;
  /** Movimiento dentro de los últimos `mesesActual` meses (D5: cuenta aunque esté archivado). */
  actual: boolean;
}

export const clave = (ann: string, sec: string) => `${ann}|${sec}`;

export async function estadoVivoExpedientes(
  pares: { nuAnnExp: string; nuSecExp: string }[],
  mesesActual: number,
): Promise<Map<string, EstadoVivoExpediente>> {
  const resultado = new Map<string, EstadoVivoExpediente>();
  if (pares.length === 0) return resultado;

  const filas = await sequelize.query<{
    ann: string; sec: string; fe_ult_mov: string | null; dependencia: string | null;
    archivado: boolean; fe_archivo: string | null; actual: boolean;
  }>(
    `WITH pares AS (
       SELECT unnest($1::text[]) AS ann, unnest($2::text[]) AS sec
     ),
     pasos AS (
       SELECT r.nu_ann_exp, r.nu_sec_exp, r.fe_emi, r.nu_emi, d.nu_des,
              d.es_doc_rec, d.fe_arc_doc, COALESCE(d.co_dep_des, r.co_dep_emi) AS co_dep,
              GREATEST(r.fe_emi, d.fe_rec_doc, d.fe_arc_doc) AS fe_mov
         FROM ${S}.tdtv_remitos r
         JOIN pares p ON p.ann = r.nu_ann_exp AND p.sec = r.nu_sec_exp
         LEFT JOIN ${S}.tdtv_destinos d
           ON d.nu_ann = r.nu_ann AND d.nu_emi = r.nu_emi AND COALESCE(d.es_eli,'0') <> '1'
        WHERE COALESCE(r.es_eli,'0') <> '1'
          AND TRIM(COALESCE(r.es_doc_emi,'')) NOT IN ('5','9')
     ),
     ultimo AS (
       -- Orden canónico de pasos (fe_envio, nu_emi, nu_des), el mismo de calidadProcesosService.
       SELECT DISTINCT ON (nu_ann_exp, nu_sec_exp)
              nu_ann_exp, nu_sec_exp, es_doc_rec, fe_arc_doc, co_dep
         FROM pasos
        ORDER BY nu_ann_exp, nu_sec_exp, fe_emi DESC, nu_emi DESC, nu_des DESC NULLS LAST
     ),
     movimiento AS (
       SELECT nu_ann_exp, nu_sec_exp, max(fe_mov) AS fe_ult_mov FROM pasos GROUP BY 1, 2
     )
     SELECT u.nu_ann_exp AS ann, u.nu_sec_exp AS sec,
            to_char(m.fe_ult_mov, 'YYYY-MM-DD') AS fe_ult_mov,
            COALESCE(dep.de_sigla, u.co_dep) AS dependencia,
            (u.es_doc_rec = '3') AS archivado,
            CASE WHEN u.es_doc_rec = '3' THEN to_char(u.fe_arc_doc, 'YYYY-MM-DD') END AS fe_archivo,
            (m.fe_ult_mov >= now() - make_interval(months => $3::int)) AS actual
       FROM ultimo u
       JOIN movimiento m USING (nu_ann_exp, nu_sec_exp)
       LEFT JOIN ${S}.rhtm_dependencia dep ON dep.co_dependencia = u.co_dep`,
    {
      bind: [pares.map((p) => p.nuAnnExp), pares.map((p) => p.nuSecExp), Math.max(1, Math.round(mesesActual))],
      type: QueryTypes.SELECT,
    },
  );

  for (const f of filas) {
    resultado.set(clave(f.ann, f.sec), {
      ultimoMovimiento: f.fe_ult_mov,
      dependenciaActual: f.dependencia,
      archivado: Boolean(f.archivado),
      feArchivo: f.fe_archivo,
      actual: Boolean(f.actual),
    });
  }
  return resultado;
}
