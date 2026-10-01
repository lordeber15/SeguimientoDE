import { QueryTypes } from 'sequelize';
import { DB_SCHEMA, sequelize } from '../config/database';
import { padEmi } from './storageService';

// DB_SCHEMA viene de configuración, no de entrada del usuario. Todo lo que llega por HTTP va
// como parámetro `bind`, igual que en seguimientoService.
const S = DB_SCHEMA;

/**
 * Verificado en esta BD: `nu_emi` está guardado limpio y con ceros a la izquierda hasta 10
 * dígitos en las TRES tablas (tdtv_remitos, tdtv_archivo_doc, tdtv_anexos): 0 filas con espacios
 * y 0 con longitud distinta de 10, sobre 106.619 filas. Por eso basta un solo `padEmi` con trim.
 * El proyecto hermano SeguimientoSGD mantiene dos helpers (`padEmi` / `padEmiZ`) porque su
 * instalación sí tenía espacios en `tdtv_anexos`; si esto se despliega contra otra base, revisar.
 */

export interface FilaArchivoDocBd {
  bl_doc: Buffer | null;
  de_ruta_origen: string | null;
}

export interface AnexoListado {
  nuAne: number;
  titulo: string | null;
  nombreArchivo: string | null;
  enBd: boolean;
}

export interface FilaAnexoBd {
  bl_doc: Buffer | null;
  de_rut_ori: string | null;
}

/** Documento principal de un remito. Trae el BLOB, así que solo se llama al descargar. */
export async function getArchivoDoc(nuAnn: string, nuEmi: string): Promise<FilaArchivoDocBd | null> {
  const filas = await sequelize.query<FilaArchivoDocBd>(
    `SELECT bl_doc, de_ruta_origen
       FROM ${S}.tdtv_archivo_doc
      WHERE nu_ann = $1 AND nu_emi = $2
      LIMIT 1`,
    { bind: [nuAnn, padEmi(nuEmi)], type: QueryTypes.SELECT },
  );

  return filas[0] ?? null;
}

/**
 * Lista de anexos de un documento, SIN los binarios.
 *
 * `tdtv_anexos.bl_doc` pesa 14 GB en total; traerlo para listar tumbaría el proceso en un
 * documento con 156 anexos. Tampoco se usa `length(bl_doc)` para saber si está en BD: sobre un
 * valor TOAST comprimido, `length()` obliga a descomprimir el blob entero. `IS NOT NULL` se
 * responde con la cabecera de la fila y el tamaño real se comprueba al descargar.
 */
export async function getAnexos(nuAnn: string, nuEmi: string): Promise<AnexoListado[]> {
  return sequelize.query<AnexoListado>(
    `SELECT nu_ane                        AS "nuAne",
            NULLIF(TRIM(de_det), '')      AS titulo,
            NULLIF(TRIM(de_rut_ori), '')  AS "nombreArchivo",
            (bl_doc IS NOT NULL)          AS "enBd"
       FROM ${S}.tdtv_anexos
      WHERE nu_ann = $1 AND nu_emi = $2
      ORDER BY nu_ane ASC`,
    { bind: [nuAnn, padEmi(nuEmi)], type: QueryTypes.SELECT },
  );
}

/** Un anexo concreto, con su binario. `nuAne` es el valor literal, no un índice. */
export async function getArchivoAnexo(
  nuAnn: string,
  nuEmi: string,
  nuAne: number,
): Promise<FilaAnexoBd | null> {
  const filas = await sequelize.query<FilaAnexoBd>(
    `SELECT bl_doc, de_rut_ori
       FROM ${S}.tdtv_anexos
      WHERE nu_ann = $1 AND nu_emi = $2 AND nu_ane = $3
      LIMIT 1`,
    { bind: [nuAnn, padEmi(nuEmi), nuAne], type: QueryTypes.SELECT },
  );

  return filas[0] ?? null;
}

export interface DocumentoExpediente {
  nuAnn: string;
  nuEmi: string;
  /** El identificador que ve el usuario (`OGAUL020260000058`), no la clave `nu_ann_exp/nu_sec_exp`. */
  numeroExpediente: string | null;
  coTipDoc: string | null;
  tipoDocumento: string | null;
  numeroDocumento: string | null;
  titulo: string;
  asunto: string | null;
  fechaEmision: string | null;
  dependenciaEmisora: string | null;
  dependenciaDestino: string | null;
  estado: string | null;
  tieneArchivo: boolean;
  numAnexos: number;
}

/**
 * TODOS los documentos de un expediente, en orden cronológico — la base del PDF unificado.
 *
 * El alcance es `(nu_ann_exp, nu_sec_exp)` y NO el árbol recursivo de `tdtr_arbol_seg` que usa el
 * proyecto hermano. Verificado sobre esta BD: seguir la cadena `pk_ref → pk_emi` arrastra 182
 * documentos que pertenecen a OTROS expedientes (un documento de B que respondió a uno de A), y
 * meterlos aquí mezclaría expedientes en el PDF. La clave del expediente es 1:1 con el
 * `nu_expediente` del SGD (1.043 ↔ 1.043, sin discrepancias), así que no se pierde nada.
 *
 * ⚠️ `nu_ann_exp` NUNCA es NULL en esta BD: los 306 documentos sin expediente lo tienen como
 * cadena VACÍA. Un filtro `IS NOT NULL` los agrupa a todos en un expediente fantasma.
 */
export async function getDocumentosExpediente(
  nuAnnExp: string,
  nuSecExp: string,
): Promise<DocumentoExpediente[]> {
  return sequelize.query<DocumentoExpediente>(
    `
    SELECT
      r.nu_ann AS "nuAnn",
      r.nu_emi AS "nuEmi",
      NULLIF(TRIM(res.nu_expediente), '') AS "numeroExpediente",
      r.co_tip_doc_adm AS "coTipDoc",
      COALESCE(td.cdoc_desdoc, r.co_tip_doc_adm) AS "tipoDocumento",
      res.nu_doc::text AS "numeroDocumento",
      TRIM(CONCAT_WS(' N° ',
        COALESCE(td.cdoc_desdoc, r.co_tip_doc_adm, 'DOCUMENTO'),
        res.nu_doc::text)) AS titulo,
      NULLIF(TRIM(r.de_asu), '') AS asunto,
      to_char(r.fe_emi, 'DD/MM/YYYY HH24:MI') AS "fechaEmision",
      COALESCE(dep.de_sigla, r.co_dep_emi) AS "dependenciaEmisora",
      d1.de_dep_des AS "dependenciaDestino",
      est.de_est AS estado,
      (ad.nu_emi IS NOT NULL) AS "tieneArchivo",
      COALESCE(ax.n, 0)::int AS "numAnexos"
    FROM ${S}.tdtv_remitos r
    LEFT JOIN ${S}.tdtx_remitos_resumen res
      ON res.nu_ann = r.nu_ann AND res.nu_emi = r.nu_emi
    LEFT JOIN ${S}.si_mae_tipo_doc td ON td.cdoc_tipdoc = r.co_tip_doc_adm
    LEFT JOIN ${S}.rhtm_dependencia dep ON dep.co_dependencia = r.co_dep_emi
    LEFT JOIN ${S}.tdtr_estados est
      ON est.co_est = r.es_doc_emi AND est.de_tab = 'TDTV_REMITOS'
    LEFT JOIN ${S}.tdtv_archivo_doc ad
      ON ad.nu_ann = r.nu_ann AND ad.nu_emi = r.nu_emi
    LEFT JOIN LATERAL (
      SELECT COALESCE(dd.de_sigla, dest.co_dep_des) AS de_dep_des
        FROM ${S}.tdtv_destinos dest
        LEFT JOIN ${S}.rhtm_dependencia dd ON dd.co_dependencia = dest.co_dep_des
       WHERE dest.nu_ann = r.nu_ann AND dest.nu_emi = r.nu_emi AND dest.es_eli = '0'
       ORDER BY dest.nu_des ASC
       LIMIT 1
    ) d1 ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*) AS n
        FROM ${S}.tdtv_anexos an
       WHERE an.nu_ann = r.nu_ann AND an.nu_emi = r.nu_emi
    ) ax ON TRUE
    WHERE r.nu_ann_exp = $1
      AND r.nu_sec_exp = $2
      AND r.es_eli = '0'
    ORDER BY r.fe_emi ASC, r.nu_emi ASC
    `,
    { bind: [nuAnnExp, nuSecExp], type: QueryTypes.SELECT },
  );
}

export interface DestinoGenerado {
  nuDes: number;
  dependencia: string | null;
  persona: string | null;
  tramite: string | null;
  prioridad: string | null;
  indicaciones: string | null;
}

export interface ReferenciaGenerada {
  documento: string | null;
  asunto: string | null;
}

export interface DatosDocumentoGenerado {
  coTipDoc: string | null;
  tipoDocumento: string | null;
  numeroDocumento: string | null;
  numeroExpediente: string | null;
  asunto: string | null;
  fechaEmision: string | null;
  diasAtencion: number | null;
  dependenciaEmisora: string | null;
  empleadoEmisor: string | null;
  siglaInstitucion: string | null;
  destinos: DestinoGenerado[];
  referencias: ReferenciaGenerada[];
}

/**
 * Datos para dibujar un PROVEÍDO (232) u HOJA DE ENVÍO (304) al vuelo.
 *
 * El SGD legado NO guarda archivo para estos tipos: los renderiza on-demand con JasperReports.
 * No es un caso marginal — verificado en esta BD: **el 86 % de los documentos sin fila en
 * `tdtv_archivo_doc` son de estos dos tipos** (991 de 1.152), y los PROVEÍDOS son el 64 % del
 * corpus. Sin generarlos, cada PDF unificado marcaría como "no incluido" ~12 % del expediente.
 */
export async function getDatosDocumentoGenerado(
  nuAnn: string,
  nuEmi: string,
): Promise<DatosDocumentoGenerado | null> {
  const emi = padEmi(nuEmi);

  const cabeceras = await sequelize.query<DatosDocumentoGenerado>(
    `
    SELECT
      r.co_tip_doc_adm AS "coTipDoc",
      COALESCE(td.cdoc_desdoc, r.co_tip_doc_adm) AS "tipoDocumento",
      res.nu_doc::text AS "numeroDocumento",
      res.nu_expediente AS "numeroExpediente",
      NULLIF(TRIM(UPPER(r.de_asu)), '') AS asunto,
      to_char(r.fe_emi, 'DD/MM/YYYY') AS "fechaEmision",
      r.nu_dia_ate::int AS "diasAtencion",
      COALESCE(dep.de_dependencia, r.co_dep_emi) AS "dependenciaEmisora",
      NULLIF(TRIM(CONCAT_WS(' ', emp.cemp_apepat, emp.cemp_apemat, emp.cemp_denom)), '')
        AS "empleadoEmisor",
      (SELECT NULLIF(TRIM(de_par), '') FROM ${S}.tdtr_parametros
        WHERE co_par = 'DE_INSTITUCION' LIMIT 1) AS "siglaInstitucion"
    FROM ${S}.tdtv_remitos r
    LEFT JOIN ${S}.tdtx_remitos_resumen res
      ON res.nu_ann = r.nu_ann AND res.nu_emi = r.nu_emi
    LEFT JOIN ${S}.si_mae_tipo_doc td ON td.cdoc_tipdoc = r.co_tip_doc_adm
    LEFT JOIN ${S}.rhtm_dependencia dep ON dep.co_dependencia = r.co_dep_emi
    LEFT JOIN ${S}.rhtm_per_empleados emp ON emp.cemp_codemp = r.co_emp_emi
    WHERE r.nu_ann = $1 AND r.nu_emi = $2
    LIMIT 1
    `,
    { bind: [nuAnn, emi], type: QueryTypes.SELECT },
  );

  const cabecera = cabeceras[0];
  if (!cabecera) return null;

  const destinos = await sequelize.query<DestinoGenerado>(
    `
    SELECT
      dest.nu_des::int AS "nuDes",
      COALESCE(dd.de_dependencia, dest.co_dep_des) AS dependencia,
      CASE dest.ti_des
        WHEN '01' THEN NULLIF(TRIM(CONCAT_WS(' ', ed.cemp_apepat, ed.cemp_apemat, ed.cemp_denom)), '')
        WHEN '02' THEN 'RUC: ' || COALESCE(dest.nu_ruc_des, '')
        WHEN '03' THEN 'DNI: ' || COALESCE(dest.nu_dni_des, '')
        WHEN '04' THEN NULLIF(TRIM(COALESCE(dest.co_otr_ori_des, '')), '')
      END AS persona,
      mot.de_mot AS tramite,
      pri.de_pri AS prioridad,
      NULLIF(TRIM(COALESCE(dest.de_pro, dest.de_asu_nue, '')), '') AS indicaciones
    FROM ${S}.tdtv_destinos dest
    LEFT JOIN ${S}.rhtm_dependencia dd ON dd.co_dependencia = dest.co_dep_des
    LEFT JOIN ${S}.rhtm_per_empleados ed ON ed.cemp_codemp = dest.co_emp_des
    LEFT JOIN ${S}.tdtr_motivo mot ON mot.co_mot = dest.co_mot
    LEFT JOIN ${S}.tdtr_prioridad pri ON pri.co_pri = dest.co_pri
    WHERE dest.nu_ann = $1 AND dest.nu_emi = $2 AND dest.es_eli = '0'
    ORDER BY dest.nu_des ASC
    `,
    { bind: [nuAnn, emi], type: QueryTypes.SELECT },
  );

  const referencias = await sequelize.query<ReferenciaGenerada>(
    `
    SELECT
      TRIM(CONCAT_WS(' N° ',
        COALESCE(td.cdoc_desdoc, b.co_tip_doc_adm),
        res.nu_doc::text)) AS documento,
      NULLIF(TRIM(b.de_asu), '') AS asunto
    FROM ${S}.tdtr_referencia a
    JOIN ${S}.tdtv_remitos b
      ON b.nu_ann = a.nu_ann_ref AND b.nu_emi = a.nu_emi_ref
    LEFT JOIN ${S}.tdtx_remitos_resumen res
      ON res.nu_ann = b.nu_ann AND res.nu_emi = b.nu_emi
    LEFT JOIN ${S}.si_mae_tipo_doc td ON td.cdoc_tipdoc = b.co_tip_doc_adm
    WHERE a.nu_ann = $1 AND a.nu_emi = $2
    `,
    { bind: [nuAnn, emi], type: QueryTypes.SELECT },
  );

  return { ...cabecera, destinos, referencias };
}

export interface InteraccionExpediente {
  nuAnn: string;
  nuEmi: string;
  nuDes: string;
  orden: number;
  documento: {
    nombre: string | null;
    tipo: string | null;
    numero: string | null;
  };
  asunto: string | null;
  estado: { codigo: string | null; descripcion: string | null };
  fechaRecepcion: string | null;
  fechaApertura: string | null;
  fechaEmision: string | null;
  documentoRespuesta: string | null;
  segundosCorridos: number | null;
  tieneArchivo: boolean;
  numAnexos: number;
}

export interface InteraccionExpedienteCompleta extends InteraccionExpediente {
  recibidoPor: {
    coEmpleado: string | null;
    nombre: string | null;
    coDependencia: string | null;
    nombreDependencia: string | null;
  };
}

/**
 * TODAS las veces que un usuario participó en un expediente, de la más reciente a la más antigua.
 *
 * Es el mismo emparejamiento recepción→respuesta de `seguimientoService.getExpedientesPorUsuario`
 * (ver docs/PLAN-SEGUIMIENTO-USUARIO.md §3), pero SIN el `row_number() = 1` que allí deja una
 * sola fila por expediente. La vista principal muestra el resumen; esto es el detalle al expandir.
 */
export async function getInteraccionesUsuario(
  nuAnnExp: string,
  nuSecExp: string,
  coDependencia: string,
  coEmpleado: string,
): Promise<InteraccionExpediente[]> {
  return sequelize.query<InteraccionExpediente>(
    `
    WITH recepciones AS (
      SELECT a.nu_ann, a.nu_emi, d.nu_des,
             res.nu_doc, a.de_asu, td.cdoc_desdoc AS tipo_documento,
             d.es_doc_rec,
             a.fe_emi     AS fe_envio,
             d.fe_rec_doc AS fe_apertura,
             res.in_existe_doc,
             a.nu_ann_exp, a.nu_sec_exp
        FROM ${S}.tdtv_destinos d
        JOIN ${S}.tdtv_remitos a
          ON a.nu_ann = d.nu_ann AND a.nu_emi = d.nu_emi
        LEFT JOIN ${S}.tdtx_remitos_resumen res
          ON res.nu_ann = a.nu_ann AND res.nu_emi = a.nu_emi
        LEFT JOIN ${S}.si_mae_tipo_doc td
          ON td.cdoc_tipdoc = a.co_tip_doc_adm
       WHERE d.co_emp_des = $1
         AND d.co_dep_des = $2
         AND a.nu_ann_exp = $3
         AND a.nu_sec_exp = $4
         AND d.es_eli = '0'
         AND a.es_eli = '0'
         AND a.es_doc_emi NOT IN ('5','7','8','9')
    ),
    emisiones AS (
      SELECT a.nu_ann_exp, a.nu_sec_exp, a.fe_emi, res.nu_doc
        FROM ${S}.tdtv_remitos a
        LEFT JOIN ${S}.tdtx_remitos_resumen res
          ON res.nu_ann = a.nu_ann AND res.nu_emi = a.nu_emi
       WHERE a.co_emp_emi = $1
         AND a.nu_ann_exp = $3
         AND a.nu_sec_exp = $4
         AND a.es_eli = '0'
         AND a.es_doc_emi NOT IN ('5','9')
    ),
    pareado AS (
      SELECT r.*, e.fe_emi AS fe_respuesta, e.nu_doc AS doc_respuesta
        FROM recepciones r
        LEFT JOIN LATERAL (
          SELECT e.fe_emi, e.nu_doc
            FROM emisiones e
           WHERE e.fe_emi >= r.fe_envio
           ORDER BY e.fe_emi
           LIMIT 1
        ) e ON TRUE
    )
    SELECT
      p.nu_ann AS "nuAnn",
      p.nu_emi AS "nuEmi",
      p.nu_des::text AS "nuDes",
      row_number() OVER (ORDER BY p.fe_envio ASC, p.nu_emi ASC, p.nu_des ASC)::int AS orden,
      json_build_object(
        'nombre', NULLIF(TRIM(CONCAT_WS(' ', p.tipo_documento, p.nu_doc)), ''),
        'tipo',   p.tipo_documento,
        'numero', p.nu_doc
      ) AS documento,
      NULLIF(TRIM(p.de_asu), '') AS asunto,
      json_build_object('codigo', p.es_doc_rec, 'descripcion', est.de_est) AS estado,
      to_char(p.fe_envio,     'YYYY-MM-DD HH24:MI:SS') AS "fechaRecepcion",
      to_char(p.fe_apertura,  'YYYY-MM-DD HH24:MI:SS') AS "fechaApertura",
      to_char(p.fe_respuesta, 'YYYY-MM-DD HH24:MI:SS') AS "fechaEmision",
      p.doc_respuesta AS "documentoRespuesta",
      CASE WHEN p.fe_respuesta IS NOT NULL
           THEN EXTRACT(EPOCH FROM (p.fe_respuesta - p.fe_envio))::int
      END AS "segundosCorridos",
      (ad.nu_emi IS NOT NULL) AS "tieneArchivo",
      COALESCE(ax.n, 0)::int  AS "numAnexos"
    FROM pareado p
    LEFT JOIN ${S}.tdtr_estados est
      ON est.co_est = p.es_doc_rec AND est.de_tab = 'TDTV_DESTINOS'
    LEFT JOIN ${S}.tdtv_archivo_doc ad
      ON ad.nu_ann = p.nu_ann AND ad.nu_emi = p.nu_emi
    LEFT JOIN LATERAL (
      SELECT count(*) AS n
        FROM ${S}.tdtv_anexos an
       WHERE an.nu_ann = p.nu_ann AND an.nu_emi = p.nu_emi
    ) ax ON TRUE
    ORDER BY p.fe_envio DESC, p.nu_emi DESC, p.nu_des DESC
    `,
    { bind: [coEmpleado, coDependencia, nuAnnExp, nuSecExp], type: QueryTypes.SELECT },
  );
}

/**
 * TODOS los movimientos de un expediente, sin importar quién los recibió — a diferencia de
 * `getInteraccionesUsuario`, no filtra por `co_emp_des`/`co_dep_des`, así que el emparejamiento
 * recepción→respuesta tampoco puede fijar un emisor: cada recepción se empareja con la respuesta
 * emitida por ESE MISMO receptor (`e.co_emp_emi = r.co_emp_des`), no por un `$1` fijo.
 */
export async function getInteraccionesExpediente(
  nuAnnExp: string,
  nuSecExp: string,
): Promise<InteraccionExpedienteCompleta[]> {
  return sequelize.query<InteraccionExpedienteCompleta>(
    `
    WITH recepciones AS (
      SELECT a.nu_ann, a.nu_emi, d.nu_des,
             d.co_emp_des, d.co_dep_des,
             res.nu_doc, a.de_asu, td.cdoc_desdoc AS tipo_documento,
             d.es_doc_rec,
             a.fe_emi     AS fe_envio,
             d.fe_rec_doc AS fe_apertura,
             res.in_existe_doc,
             a.nu_ann_exp, a.nu_sec_exp
        FROM ${S}.tdtv_destinos d
        JOIN ${S}.tdtv_remitos a
          ON a.nu_ann = d.nu_ann AND a.nu_emi = d.nu_emi
        LEFT JOIN ${S}.tdtx_remitos_resumen res
          ON res.nu_ann = a.nu_ann AND res.nu_emi = a.nu_emi
        LEFT JOIN ${S}.si_mae_tipo_doc td
          ON td.cdoc_tipdoc = a.co_tip_doc_adm
       WHERE a.nu_ann_exp = $1
         AND a.nu_sec_exp = $2
         AND d.es_eli = '0'
         AND a.es_eli = '0'
         AND a.es_doc_emi NOT IN ('5','7','8','9')
    ),
    emisiones AS (
      SELECT a.nu_ann_exp, a.nu_sec_exp, a.co_emp_emi, a.fe_emi, res.nu_doc
        FROM ${S}.tdtv_remitos a
        LEFT JOIN ${S}.tdtx_remitos_resumen res
          ON res.nu_ann = a.nu_ann AND res.nu_emi = a.nu_emi
       WHERE a.nu_ann_exp = $1
         AND a.nu_sec_exp = $2
         AND a.es_eli = '0'
         AND a.es_doc_emi NOT IN ('5','9')
    ),
    pareado AS (
      SELECT r.*, e.fe_emi AS fe_respuesta, e.nu_doc AS doc_respuesta
        FROM recepciones r
        LEFT JOIN LATERAL (
          SELECT e.fe_emi, e.nu_doc
            FROM emisiones e
           WHERE e.co_emp_emi = r.co_emp_des
             AND e.fe_emi >= r.fe_envio
           ORDER BY e.fe_emi
           LIMIT 1
        ) e ON TRUE
    )
    SELECT
      p.nu_ann AS "nuAnn",
      p.nu_emi AS "nuEmi",
      p.nu_des::text AS "nuDes",
      row_number() OVER (ORDER BY p.fe_envio ASC, p.nu_emi ASC, p.nu_des ASC)::int AS orden,
      json_build_object(
        'nombre', NULLIF(TRIM(CONCAT_WS(' ', p.tipo_documento, p.nu_doc)), ''),
        'tipo',   p.tipo_documento,
        'numero', p.nu_doc
      ) AS documento,
      NULLIF(TRIM(p.de_asu), '') AS asunto,
      json_build_object('codigo', p.es_doc_rec, 'descripcion', est.de_est) AS estado,
      to_char(p.fe_envio,     'YYYY-MM-DD HH24:MI:SS') AS "fechaRecepcion",
      to_char(p.fe_apertura,  'YYYY-MM-DD HH24:MI:SS') AS "fechaApertura",
      to_char(p.fe_respuesta, 'YYYY-MM-DD HH24:MI:SS') AS "fechaEmision",
      p.doc_respuesta AS "documentoRespuesta",
      CASE WHEN p.fe_respuesta IS NOT NULL
           THEN EXTRACT(EPOCH FROM (p.fe_respuesta - p.fe_envio))::int
      END AS "segundosCorridos",
      (ad.nu_emi IS NOT NULL) AS "tieneArchivo",
      COALESCE(ax.n, 0)::int  AS "numAnexos",
      json_build_object(
        'coEmpleado', p.co_emp_des,
        'nombre', NULLIF(TRIM(CONCAT_WS(' ', emp.cemp_apepat, emp.cemp_apemat, emp.cemp_denom)), ''),
        'coDependencia', p.co_dep_des,
        'nombreDependencia', COALESCE(dep.de_dependencia, p.co_dep_des)
      ) AS "recibidoPor"
    FROM pareado p
    LEFT JOIN ${S}.tdtr_estados est
      ON est.co_est = p.es_doc_rec AND est.de_tab = 'TDTV_DESTINOS'
    LEFT JOIN ${S}.tdtv_archivo_doc ad
      ON ad.nu_ann = p.nu_ann AND ad.nu_emi = p.nu_emi
    LEFT JOIN LATERAL (
      SELECT count(*) AS n
        FROM ${S}.tdtv_anexos an
       WHERE an.nu_ann = p.nu_ann AND an.nu_emi = p.nu_emi
    ) ax ON TRUE
    LEFT JOIN ${S}.rhtm_per_empleados emp ON emp.cemp_codemp = p.co_emp_des
    LEFT JOIN ${S}.rhtm_dependencia dep ON dep.co_dependencia = p.co_dep_des
    ORDER BY p.fe_envio DESC, p.nu_emi DESC, p.nu_des DESC
    `,
    { bind: [nuAnnExp, nuSecExp], type: QueryTypes.SELECT },
  );
}
