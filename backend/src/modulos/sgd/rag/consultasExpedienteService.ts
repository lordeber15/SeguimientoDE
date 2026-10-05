import { QueryTypes } from 'sequelize';
import { appSequelize } from '../../../compartido/config/appDatabase';
import { DB_SCHEMA, sequelize } from '../config/database';
import { clave } from './enriquecimientoSgdService';
import type { FiltroAcceso } from './retrievalService';

const S = DB_SCHEMA;

/**
 * Datos de las respuestas `ultimo_documento` y `participantes` del chat
 * (docs/PLAN-CHAT-CONSULTAS.md, Fase 5, D6/D7): SQL puro, sin modelo de respuesta.
 *
 * - Lo que identifica un documento (asunto, emisor, remitente, coincidencias) sale de `rag.*`.
 * - Lo que cambia con el trámite (destinatarios, indicaciones, estado de cada movimiento) se lee EN
 *   VIVO del SGD, igual que el estado de archivo de los listados (D1).
 * - Usuarios restringidos a una dependencia: en `rag.*` solo documentos de su dependencia (el mismo
 *   `FiltroAcceso` de siempre) y, en el SGD, solo movimientos que su dependencia emitió o recibió —
 *   no el trámite completo de un expediente que vio porque UN documento suyo coincidía.
 */

type Par = { nuAnnExp: string; nuSecExp: string };

const nombreEmpleado = (alias: string) =>
  `NULLIF(TRIM(CONCAT_WS(' ', ${alias}.cemp_apepat, ${alias}.cemp_apemat, ${alias}.cemp_denom)), '')`;

/** Destinatario de un movimiento: misma regla por `ti_des` que `documentoService` (destinos). */
const PERSONA_DESTINO = `CASE dest.ti_des
    WHEN '01' THEN ${nombreEmpleado('ed')}
    WHEN '02' THEN COALESCE(NULLIF(TRIM(pd.cpro_razsoc), ''), 'RUC: ' || COALESCE(dest.nu_ruc_des, ''))
    WHEN '03' THEN 'DNI: ' || COALESCE(dest.nu_dni_des, '')
    WHEN '04' THEN NULLIF(TRIM(COALESCE(dest.co_otr_ori_des, '')), '')
  END`;

/** Quién emitió un remito: remitente externo ('02'/'03', ver Fase 0) o dependencia · empleado. */
const EMISOR_REMITO = `CASE TRIM(COALESCE(r.ti_emi, ''))
    WHEN '02' THEN COALESCE(NULLIF(TRIM(pe.cpro_razsoc), ''), NULLIF(UPPER(TRIM(r.de_ori_emi)), ''), 'RUC: ' || r.nu_ruc_emi)
    WHEN '03' THEN COALESCE(NULLIF(UPPER(TRIM(r.de_ori_emi)), ''), 'DNI: ' || r.nu_dni_emi)
    ELSE NULLIF(CONCAT_WS(' · ', COALESCE(de.de_sigla, r.co_dep_emi), ${nombreEmpleado('ee')}), '')
  END`;

// ── Último documento ────────────────────────────────────────────────────────────────────────────

export interface IndicacionDestino {
  destino: string | null;
  persona: string | null;
  tramite: string | null;
  indicacion: string | null;
  estado: string | null;
  /** AAAA-MM-DD de recepción (o de archivo si se archivó sin recepción registrada). */
  fecha: string | null;
}

export interface DocumentoEncontrado {
  nuAnn: string;
  nuEmi: string;
  nuAnnExp: string | null;
  nuSecExp: string | null;
  numeroExpediente: string | null;
  titulo: string | null;
  asunto: string | null;
  /** AAAA-MM-DD. */
  fecha: string | null;
  emisor: string | null;
  remitente: string | null;
  terminosCoinciden: number;
}

/**
 * Documentos de los expedientes `pares` ordenados por cuántos términos cumplen (en metadatos o en
 * su contenido) y, a igualdad, por fecha de emisión descendente. Sin términos, solo por fecha.
 * "El último documento de controversia de la obra X" = el más reciente entre los que mejor cumplen.
 */
export async function documentosRecientes(
  pares: Par[],
  terminos: string[],
  filtro: FiltroAcceso,
  limite: number,
): Promise<DocumentoEncontrado[]> {
  if (pares.length === 0) return [];
  const filas = await appSequelize.query<{
    nu_ann: string; nu_emi: string; ann: string | null; sec: string | null; numero: string | null;
    titulo: string | null; asunto: string | null; fecha: string | null; emisor: string | null;
    remitente: string | null; terminos: number;
  }>(
    `WITH pares AS (SELECT unnest($1::text[]) AS ann, unnest($2::text[]) AS sec),
          q AS (
            SELECT phraseto_tsquery('es_unaccent', t) AS q
              FROM unnest($3::text[]) AS t
             WHERE phraseto_tsquery('es_unaccent', t)::text <> ''
          )
     SELECT d.nu_ann, d.nu_emi, d.nu_ann_exp AS ann, d.nu_sec_exp AS sec, e.numero_sgd AS numero,
            d.titulo, d.asunto, to_char(d.fe_emi, 'YYYY-MM-DD') AS fecha,
            NULLIF(concat_ws(' · ', d.de_dep_emi, d.emisor_empleado), '') AS emisor,
            d.remitente_externo AS remitente,
            (SELECT count(*)::int FROM q
              WHERE d.tsv_meta @@ q.q
                 OR EXISTS (SELECT 1 FROM rag.chunk c WHERE c.sha256 = d.contenido_sha256 AND c.tsv @@ q.q)
            ) AS terminos
       FROM rag.documento d
       JOIN pares p ON p.ann = d.nu_ann_exp AND p.sec = d.nu_sec_exp
       LEFT JOIN rag.expediente e ON e.nu_ann_exp = d.nu_ann_exp AND e.nu_sec_exp = d.nu_sec_exp
      WHERE d.vigente AND ($4::text IS NULL OR d.co_dep_emi = $4)
      ORDER BY terminos DESC, d.fe_emi DESC NULLS LAST, d.nu_emi DESC
      LIMIT $5`,
    {
      bind: [pares.map((p) => p.nuAnnExp), pares.map((p) => p.nuSecExp), terminos, filtro.coDependencia, limite],
      type: QueryTypes.SELECT,
    },
  );
  return filas.map((f) => ({
    nuAnn: f.nu_ann,
    nuEmi: f.nu_emi,
    nuAnnExp: f.ann,
    nuSecExp: f.sec,
    numeroExpediente: f.numero,
    titulo: f.titulo,
    asunto: f.asunto?.replace(/\s+/g, ' ').trim() ?? null,
    fecha: f.fecha,
    emisor: f.emisor,
    remitente: f.remitente,
    terminosCoinciden: Number(f.terminos),
  }));
}

/** A quién se envió un documento y con qué indicación — en vivo del SGD. */
export async function indicacionesDocumento(nuAnn: string, nuEmi: string, filtro: FiltroAcceso): Promise<IndicacionDestino[]> {
  return sequelize.query<IndicacionDestino>(
    `SELECT COALESCE(dd.de_sigla, dest.co_dep_des) AS destino,
            ${PERSONA_DESTINO} AS persona,
            mot.de_mot AS tramite,
            NULLIF(TRIM(dest.de_pro), '') AS indicacion,
            est.de_est AS estado,
            to_char(COALESCE(dest.fe_rec_doc, dest.fe_arc_doc), 'YYYY-MM-DD') AS fecha
       FROM ${S}.tdtv_destinos dest
       JOIN ${S}.tdtv_remitos r ON r.nu_ann = dest.nu_ann AND r.nu_emi = dest.nu_emi
       LEFT JOIN ${S}.rhtm_dependencia dd ON dd.co_dependencia = dest.co_dep_des
       LEFT JOIN ${S}.rhtm_per_empleados ed ON ed.cemp_codemp = dest.co_emp_des
       LEFT JOIN ${S}.lg_pro_proveedor pd ON pd.cpro_ruc = dest.nu_ruc_des
       LEFT JOIN ${S}.tdtr_motivo mot ON mot.co_mot = dest.co_mot
       LEFT JOIN ${S}.tdtr_estados est ON est.co_est = dest.es_doc_rec AND est.de_tab = 'TDTV_DESTINOS'
      WHERE dest.nu_ann = $1 AND dest.nu_emi = $2 AND COALESCE(dest.es_eli, '0') <> '1'
        AND ($3::text IS NULL OR r.co_dep_emi = $3 OR dest.co_dep_des = $3)
      ORDER BY dest.nu_des`,
    { bind: [nuAnn, nuEmi, filtro.coDependencia], type: QueryTypes.SELECT },
  );
}

// ── Pistas de obra (para agrupar) ───────────────────────────────────────────────────────────────

/** "Contrato N° 341-2025-MCEBS" — el número tolera espacios alrededor de los guiones (OCR). */
const RE_CONTRATO = String.raw`contrato\s+n[°º.o]*\s*(\d{1,4}\s*-\s*\d{4}\s*-\s*[a-z]+)`;

/**
 * Contratos más citados en el contenido de cada expediente. Los asuntos de controversia casi nunca
 * nombran la obra ("Notificación de controversia N 02…"), pero sus documentos citan el contrato una
 * y otra vez: es la clave de agrupación más confiable que hay (medido en Fase 5).
 */
export async function contratosPorExpediente(pares: Par[], porExpediente = 3): Promise<Map<string, string[]>> {
  const resultado = new Map<string, string[]>();
  if (pares.length === 0) return resultado;
  const filas = await appSequelize.query<{ ann: string; sec: string; contratos: string[] }>(
    `WITH m AS (
       SELECT d.nu_ann_exp AS ann, d.nu_sec_exp AS sec,
              upper(regexp_replace(x[1], '\\s+', '', 'g')) AS contrato
         FROM rag.documento d
         JOIN (SELECT unnest($1::text[]) AS ann, unnest($2::text[]) AS sec) p
           ON p.ann = d.nu_ann_exp AND p.sec = d.nu_sec_exp
         JOIN rag.chunk c ON c.sha256 = d.contenido_sha256
        CROSS JOIN LATERAL regexp_matches(c.texto, $3, 'gi') AS x
        WHERE d.vigente
     ),
     conteo AS (SELECT ann, sec, contrato, count(*) AS n FROM m GROUP BY 1, 2, 3)
     SELECT ann, sec, (array_agg(contrato ORDER BY n DESC))[1:$4] AS contratos
       FROM conteo GROUP BY ann, sec`,
    {
      bind: [pares.map((p) => p.nuAnnExp), pares.map((p) => p.nuSecExp), RE_CONTRATO, porExpediente],
      type: QueryTypes.SELECT,
    },
  );
  for (const f of filas) resultado.set(clave(f.ann, f.sec), f.contratos);
  return resultado;
}

/** Muestra de fragmentos por contrato sobre la que se aplica la regex del nombre (la regex sobre
 *  cientos de fragmentos largos costaba ~0,8 s por contrato). */
const MUESTRA_NOMBRE_CONTRATO = 80;
const TTL_NOMBRES_MS = 60 * 60 * 1000;
/** El nombre del proyecto de un contrato no cambia: se memoriza por proceso durante una hora. */
const cacheNombres = new Map<string, { valor: { nombre: string; menciones: number } | null; hasta: number }>();

/**
 * Nombre del proyecto/obra de cada contrato: el texto entre comillas que sigue al número
 * ("…Contrato N° 352-2025-MCE\\, para la ejecución de la obra “Construcción y Equipamiento del…”"),
 * el más repetido en una muestra de fragmentos. `menciones` = fragmentos que citan el contrato:
 * con decenas es confiable; con menos de 10, dudoso (el nombre puede venir de otro documento).
 */
export async function nombresDeContratos(contratos: string[]): Promise<Map<string, { nombre: string; menciones: number }>> {
  const resultado = new Map<string, { nombre: string; menciones: number }>();
  const ahora = Date.now();
  const pendientes: string[] = [];
  for (const c of contratos) {
    const enCache = cacheNombres.get(c);
    if (enCache && enCache.hasta > ahora) {
      if (enCache.valor) resultado.set(c, enCache.valor);
    } else {
      pendientes.push(c);
    }
  }
  if (pendientes.length === 0) return resultado;

  const filas = await appSequelize.query<{ contrato: string; nombre: string | null; menciones: number }>(
    `SELECT k.contrato, t.nombre,
            (SELECT count(*)::int FROM rag.chunk c WHERE c.tsv @@ phraseto_tsquery('es_unaccent', k.contrato)) AS menciones
       FROM unnest($1::text[]) AS k(contrato)
       LEFT JOIN LATERAL (
         SELECT regexp_replace(x[1], '\\s+', ' ', 'g') AS nombre, count(*) AS veces
           FROM (SELECT c.texto FROM rag.chunk c
                  WHERE c.tsv @@ phraseto_tsquery('es_unaccent', k.contrato)
                  LIMIT $2) AS muestra
          CROSS JOIN LATERAL regexp_matches(
            muestra.texto,
            'contrato\\s+n[°º.o]*\\s*' || replace(k.contrato, '-', '\\s*-\\s*') || '[^“"”]{0,160}[“"]([^”"]{15,220})[”"]',
            'gi') AS x
          GROUP BY 1 ORDER BY 2 DESC LIMIT 1
       ) t ON true`,
    { bind: [pendientes, MUESTRA_NOMBRE_CONTRATO], type: QueryTypes.SELECT },
  );
  for (const f of filas) {
    const valor = f.nombre ? { nombre: f.nombre, menciones: Number(f.menciones) } : null;
    cacheNombres.set(f.contrato, { valor, hasta: ahora + TTL_NOMBRES_MS });
    if (valor) resultado.set(f.contrato, valor);
  }
  return resultado;
}

// ── Participantes ───────────────────────────────────────────────────────────────────────────────

export interface ParticipanteExterno { nombre: string; documento: string | null; documentos: number; expedientes: number }
export interface ParticipanteInterno { dependencia: string | null; empleado: string | null; documentos: number; expedientes: number }
export interface Destinatario { dependencia: string | null; persona: string | null; veces: number; expedientes: number }

export interface MovimientoExpediente {
  /** AAAA-MM-DD de emisión del documento. */
  fecha: string | null;
  documento: string | null;
  emisor: string | null;
  destino: string | null;
  persona: string | null;
  tramite: string | null;
  indicacion: string | null;
  estado: string | null;
}

export interface TramiteExpediente {
  nuAnnExp: string;
  nuSecExp: string;
  numeroExpediente: string | null;
  movimientos: MovimientoExpediente[];
}

const LIMITE_LISTA = 25;

/** Remitentes externos y emisores internos de los expedientes — de `rag.*`, en dos consultas. */
export async function participantesRag(pares: Par[], filtro: FiltroAcceso): Promise<{
  remitentes: ParticipanteExterno[];
  emisores: ParticipanteInterno[];
}> {
  if (pares.length === 0) return { remitentes: [], emisores: [] };
  const bind = [pares.map((p) => p.nuAnnExp), pares.map((p) => p.nuSecExp), filtro.coDependencia, LIMITE_LISTA];
  const base = `FROM rag.documento d
       JOIN (SELECT unnest($1::text[]) AS ann, unnest($2::text[]) AS sec) p
         ON p.ann = d.nu_ann_exp AND p.sec = d.nu_sec_exp
      WHERE d.vigente AND ($3::text IS NULL OR d.co_dep_emi = $3)`;

  const [remitentes, emisores] = await Promise.all([
    appSequelize.query<ParticipanteExterno>(
      `SELECT d.remitente_externo AS nombre, max(d.remitente_doc) AS documento,
              count(*)::int AS documentos, count(DISTINCT (d.nu_ann_exp, d.nu_sec_exp))::int AS expedientes
         ${base} AND d.remitente_externo IS NOT NULL
        GROUP BY d.remitente_externo
        ORDER BY expedientes DESC, documentos DESC LIMIT $4`,
      { bind, type: QueryTypes.SELECT },
    ),
    appSequelize.query<ParticipanteInterno>(
      `SELECT d.de_dep_emi AS dependencia, d.emisor_empleado AS empleado,
              count(*)::int AS documentos, count(DISTINCT (d.nu_ann_exp, d.nu_sec_exp))::int AS expedientes
         ${base} AND d.emisor_empleado IS NOT NULL
        GROUP BY d.de_dep_emi, d.emisor_empleado
        ORDER BY expedientes DESC, documentos DESC LIMIT $4`,
      { bind, type: QueryTypes.SELECT },
    ),
  ]);
  return { remitentes, emisores };
}

/** A quiénes se derivaron los documentos de esos expedientes — en vivo del SGD. */
export async function destinatariosSgd(pares: Par[], filtro: FiltroAcceso): Promise<Destinatario[]> {
  if (pares.length === 0) return [];
  return sequelize.query<Destinatario>(
    `SELECT COALESCE(dd.de_sigla, dest.co_dep_des) AS dependencia,
            ${PERSONA_DESTINO} AS persona,
            count(*)::int AS veces,
            count(DISTINCT (r.nu_ann_exp, r.nu_sec_exp))::int AS expedientes
       FROM ${S}.tdtv_remitos r
       JOIN (SELECT unnest($1::text[]) AS ann, unnest($2::text[]) AS sec) p
         ON p.ann = r.nu_ann_exp AND p.sec = r.nu_sec_exp
       JOIN ${S}.tdtv_destinos dest ON dest.nu_ann = r.nu_ann AND dest.nu_emi = r.nu_emi
       LEFT JOIN ${S}.rhtm_dependencia dd ON dd.co_dependencia = dest.co_dep_des
       LEFT JOIN ${S}.rhtm_per_empleados ed ON ed.cemp_codemp = dest.co_emp_des
       LEFT JOIN ${S}.lg_pro_proveedor pd ON pd.cpro_ruc = dest.nu_ruc_des
      WHERE COALESCE(r.es_eli, '0') <> '1' AND TRIM(COALESCE(r.es_doc_emi, '')) NOT IN ('5', '9')
        AND COALESCE(dest.es_eli, '0') <> '1'
        AND ($3::text IS NULL OR r.co_dep_emi = $3 OR dest.co_dep_des = $3)
      GROUP BY 1, 2
      ORDER BY expedientes DESC, veces DESC
      LIMIT $4`,
    {
      bind: [pares.map((p) => p.nuAnnExp), pares.map((p) => p.nuSecExp), filtro.coDependencia, LIMITE_LISTA],
      type: QueryTypes.SELECT,
    },
  );
}

/**
 * Trámite cronológico (quién envió qué a quién, con qué indicación) de unos pocos expedientes — en
 * vivo del SGD, en una sola consulta. Orden canónico de pasos: emisión, nu_emi, nu_des.
 */
export async function tramiteExpedientes(
  pares: (Par & { numeroExpediente: string | null })[],
  filtro: FiltroAcceso,
  maxMovimientos = 40,
): Promise<TramiteExpediente[]> {
  if (pares.length === 0) return [];
  const filas = await sequelize.query<MovimientoExpediente & { ann: string; sec: string }>(
    `SELECT r.nu_ann_exp AS ann, r.nu_sec_exp AS sec,
            to_char(r.fe_emi, 'YYYY-MM-DD') AS fecha,
            TRIM(CONCAT_WS(' N° ', COALESCE(td.cdoc_desdoc, r.co_tip_doc_adm), res.nu_doc::text)) AS documento,
            ${EMISOR_REMITO} AS emisor,
            COALESCE(dd.de_sigla, dest.co_dep_des) AS destino,
            ${PERSONA_DESTINO} AS persona,
            mot.de_mot AS tramite,
            NULLIF(TRIM(dest.de_pro), '') AS indicacion,
            est.de_est AS estado
       FROM ${S}.tdtv_remitos r
       JOIN (SELECT unnest($1::text[]) AS ann, unnest($2::text[]) AS sec) p
         ON p.ann = r.nu_ann_exp AND p.sec = r.nu_sec_exp
       LEFT JOIN ${S}.tdtx_remitos_resumen res ON res.nu_ann = r.nu_ann AND res.nu_emi = r.nu_emi
       LEFT JOIN ${S}.si_mae_tipo_doc td ON td.cdoc_tipdoc = r.co_tip_doc_adm
       LEFT JOIN ${S}.rhtm_dependencia de ON de.co_dependencia = r.co_dep_emi
       LEFT JOIN ${S}.rhtm_per_empleados ee ON ee.cemp_codemp = r.co_emp_emi
       LEFT JOIN ${S}.lg_pro_proveedor pe ON pe.cpro_ruc = r.nu_ruc_emi
       LEFT JOIN ${S}.tdtv_destinos dest
         ON dest.nu_ann = r.nu_ann AND dest.nu_emi = r.nu_emi AND COALESCE(dest.es_eli, '0') <> '1'
       LEFT JOIN ${S}.rhtm_dependencia dd ON dd.co_dependencia = dest.co_dep_des
       LEFT JOIN ${S}.rhtm_per_empleados ed ON ed.cemp_codemp = dest.co_emp_des
       LEFT JOIN ${S}.lg_pro_proveedor pd ON pd.cpro_ruc = dest.nu_ruc_des
       LEFT JOIN ${S}.tdtr_motivo mot ON mot.co_mot = dest.co_mot
       LEFT JOIN ${S}.tdtr_estados est ON est.co_est = dest.es_doc_rec AND est.de_tab = 'TDTV_DESTINOS'
      WHERE COALESCE(r.es_eli, '0') <> '1' AND TRIM(COALESCE(r.es_doc_emi, '')) NOT IN ('5', '9')
        AND ($3::text IS NULL OR r.co_dep_emi = $3 OR dest.co_dep_des = $3)
      ORDER BY r.nu_ann_exp, r.nu_sec_exp, r.fe_emi, r.nu_emi, dest.nu_des`,
    {
      bind: [pares.map((p) => p.nuAnnExp), pares.map((p) => p.nuSecExp), filtro.coDependencia],
      type: QueryTypes.SELECT,
    },
  );

  const porClave = new Map<string, MovimientoExpediente[]>();
  for (const { ann, sec, ...mov } of filas) {
    const k = clave(ann, sec);
    const lista = porClave.get(k) ?? [];
    lista.push(mov);
    porClave.set(k, lista);
  }
  // Se respeta el orden de relevancia de `pares`; de cada trámite, los últimos `maxMovimientos`.
  return pares.map((p) => ({
    nuAnnExp: p.nuAnnExp,
    nuSecExp: p.nuSecExp,
    numeroExpediente: p.numeroExpediente,
    movimientos: (porClave.get(clave(p.nuAnnExp, p.nuSecExp)) ?? []).slice(-maxMovimientos),
  }));
}
