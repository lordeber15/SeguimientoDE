import { QueryTypes } from 'sequelize';
import { DB_SCHEMA, sequelize } from '../config/database';

// DB_SCHEMA viene de configuración (.env), no de entrada del usuario, así que interpolarlo en
// el SQL es seguro. Todo lo que llega por HTTP va como parámetro `bind` ($1, $2...).
const S = DB_SCHEMA;

/**
 * Estados de TDTV_REMITOS que se excluyen del seguimiento, igual que hace el SGD legado en
 * SeguiEstRecibidoDaoImp.java: '5' EN PROYECTO, '7' PARA DESPACHO, '8' OBSERVADO, '9' ANULADO.
 * Son documentos que todavía no circularon o que quedaron sin efecto.
 */
const ESTADOS_REMITO_EXCLUIDOS = "'5','7','8','9'";

export interface UsuarioDependencia {
  coEmpleado: string;
  nombreCompleto: string | null;
  recibidos: number;
  emitidos: number;
}

export interface ExpedienteEncontrado {
  nuAnnExp: string;
  nuSecExp: string;
  numeroExpediente: string | null;
  coDependencia: string;
  coEmpleado: string;
  nombreCompleto: string | null;
  nombreDependencia: string | null;
}

export interface ExpedienteSeguimiento {
  nuAnnExp: string;
  nuSecExp: string;
  numeroExpediente: string | null;
  documento: {
    nombre: string | null;
    tipo: string | null;
    numero: string | null;
    nuAnn: string;
    nuEmi: string;
    nuDes: string;
  };
  asunto: string | null;
  estado: { codigo: string | null; descripcion: string | null };
  fechaRecepcion: string | null;
  fechaApertura: string | null;
  fechaEmision: string | null;
  documentoRespuesta: string | null;
  segundosCorridos: number | null;
  segundosHabiles: number | null;
  participaciones: number;
}

/**
 * Usuarios con movimiento real en una dependencia: los que recibieron algún documento allí
 * (TDTV_DESTINOS.CO_DEP_DES) o emitieron alguno desde allí (TDTV_REMITOS.CO_DEP_EMI).
 *
 * No se usa RHTM_PER_EMPLEADOS.CEMP_CO_DEPEND (la dependencia de la ficha) porque un empleado
 * puede recibir documentos bajo dos dependencias distintas cuando tiene una encargatura —
 * verificado en la BD real: 10+ empleados con documentos en 2 dependencias. Armar el combo desde
 * el movimiento real garantiza además que ninguna opción devuelva una tabla vacía.
 */
export async function getUsuariosPorDependencia(coDependencia: string): Promise<UsuarioDependencia[]> {
  return sequelize.query<UsuarioDependencia>(
    `
    WITH recibidos AS (
      SELECT d.co_emp_des AS co_emp, count(*)::int AS n
      FROM ${S}.tdtv_destinos d
      WHERE d.co_dep_des = $1 AND d.es_eli = '0' AND COALESCE(d.co_emp_des, '') <> ''
      GROUP BY d.co_emp_des
    ),
    emitidos AS (
      SELECT a.co_emp_emi AS co_emp, count(*)::int AS n
      FROM ${S}.tdtv_remitos a
      WHERE a.co_dep_emi = $1 AND a.es_eli = '0' AND COALESCE(a.co_emp_emi, '') <> ''
      GROUP BY a.co_emp_emi
    ),
    activos AS (
      SELECT co_emp FROM recibidos
      UNION
      SELECT co_emp FROM emitidos
    )
    SELECT
      v.co_emp AS "coEmpleado",
      NULLIF(TRIM(CONCAT_WS(' ', e.cemp_apepat, e.cemp_apemat, e.cemp_denom)), '') AS "nombreCompleto",
      COALESCE(r.n, 0) AS recibidos,
      COALESCE(m.n, 0) AS emitidos
    FROM activos v
    LEFT JOIN ${S}.rhtm_per_empleados e ON e.cemp_codemp = v.co_emp
    LEFT JOIN recibidos r ON r.co_emp = v.co_emp
    LEFT JOIN emitidos  m ON m.co_emp = v.co_emp
    ORDER BY 2 NULLS LAST
    `,
    { bind: [coDependencia], type: QueryTypes.SELECT },
  );
}

/**
 * Expedientes que pasaron por un usuario dentro de una dependencia, uno por expediente.
 *
 * Cómo se arma (ver docs/PLAN-SEGUIMIENTO-USUARIO.md §3):
 *
 *  1. RECEPCIONES — los destinos dirigidos a ese empleado en esa dependencia.
 *  2. EMISIONES   — los documentos que ese mismo empleado emitió.
 *  3. EMPAREJADO  — a cada recepción se le asigna la PRIMERA emisión del usuario en el MISMO
 *     expediente que ocurrió después. Hay que hacerlo por expediente + cronología porque el
 *     vínculo explícito respuesta→origen no existe en esta instalación: TDTV_DESTINOS.NU_ANN_REF
 *     está NULL en las 6.682 filas de la tabla.
 *  4. DEDUPLICADO — row_number() por expediente deja solo la última participación del usuario.
 *
 * El cronómetro arranca en A.FE_EMI (cuándo se lo enviaron) y no en D.FE_REC_DOC (cuándo lo
 * abrió); FE_REC_DOC igual se devuelve aparte como dato informativo. Tampoco se usan FE_DES ni
 * FE_DER_DOC: están NULL en el 100% de la tabla.
 */
export async function getExpedientesPorUsuario(
  coDependencia: string,
  coEmpleado: string,
): Promise<ExpedienteSeguimiento[]> {
  return sequelize.query<ExpedienteSeguimiento>(
    `
    WITH recepciones AS (
      SELECT
        a.nu_ann_exp, a.nu_sec_exp,
        a.nu_ann, a.nu_emi, d.nu_des,
        res.nu_expediente,
        res.nu_doc,
        a.de_asu,
        td.cdoc_desdoc AS tipo_documento,
        d.es_doc_rec,
        a.fe_emi      AS fe_envio,
        d.fe_rec_doc  AS fe_apertura
      FROM ${S}.tdtv_destinos d
      JOIN ${S}.tdtv_remitos a
        ON a.nu_ann = d.nu_ann AND a.nu_emi = d.nu_emi
      LEFT JOIN ${S}.tdtx_remitos_resumen res
        ON res.nu_ann = a.nu_ann AND res.nu_emi = a.nu_emi
      LEFT JOIN ${S}.si_mae_tipo_doc td
        ON td.cdoc_tipdoc = a.co_tip_doc_adm
      WHERE d.co_emp_des = $1
        AND d.co_dep_des = $2
        AND d.es_eli = '0'
        AND a.es_eli = '0'
        AND a.es_doc_emi NOT IN (${ESTADOS_REMITO_EXCLUIDOS})
        AND COALESCE(a.nu_ann_exp, '') <> ''
        AND COALESCE(a.nu_sec_exp, '') <> ''
    ),
    emisiones AS (
      SELECT a.nu_ann_exp, a.nu_sec_exp, a.fe_emi, res.nu_doc
      FROM ${S}.tdtv_remitos a
      LEFT JOIN ${S}.tdtx_remitos_resumen res
        ON res.nu_ann = a.nu_ann AND res.nu_emi = a.nu_emi
      WHERE a.co_emp_emi = $1
        AND a.es_eli = '0'
        AND a.es_doc_emi NOT IN ('5','9')
        AND COALESCE(a.nu_ann_exp, '') <> ''
        AND COALESCE(a.nu_sec_exp, '') <> ''
    ),
    pareado AS (
      SELECT r.*, e.fe_emi AS fe_respuesta, e.nu_doc AS doc_respuesta
      FROM recepciones r
      LEFT JOIN LATERAL (
        SELECT e.fe_emi, e.nu_doc
        FROM emisiones e
        WHERE e.nu_ann_exp = r.nu_ann_exp
          AND e.nu_sec_exp = r.nu_sec_exp
          AND e.fe_emi >= r.fe_envio
        ORDER BY e.fe_emi
        LIMIT 1
      ) e ON TRUE
    ),
    ranked AS (
      SELECT p.*,
        row_number() OVER (
          PARTITION BY p.nu_ann_exp, p.nu_sec_exp
          ORDER BY p.fe_envio DESC, p.nu_emi DESC, p.nu_des DESC
        ) AS rn,
        count(*) OVER (PARTITION BY p.nu_ann_exp, p.nu_sec_exp)::int AS participaciones
      FROM pareado p
    ),
    ultima AS (
      SELECT * FROM ranked WHERE rn = 1
    )
    SELECT
      u.nu_ann_exp AS "nuAnnExp",
      u.nu_sec_exp AS "nuSecExp",
      u.nu_expediente AS "numeroExpediente",
      json_build_object(
        'nombre', NULLIF(TRIM(CONCAT_WS(' ', u.tipo_documento, u.nu_doc)), ''),
        'tipo',   u.tipo_documento,
        'numero', u.nu_doc,
        'nuAnn',  u.nu_ann,
        'nuEmi',  u.nu_emi,
        'nuDes',  u.nu_des::text
      ) AS documento,
      NULLIF(TRIM(u.de_asu), '') AS asunto,
      json_build_object('codigo', u.es_doc_rec, 'descripcion', est.de_est) AS estado,
      to_char(u.fe_envio,     'YYYY-MM-DD HH24:MI:SS') AS "fechaRecepcion",
      to_char(u.fe_apertura,  'YYYY-MM-DD HH24:MI:SS') AS "fechaApertura",
      to_char(u.fe_respuesta, 'YYYY-MM-DD HH24:MI:SS') AS "fechaEmision",
      u.doc_respuesta AS "documentoRespuesta",
      CASE WHEN u.fe_respuesta IS NOT NULL
           THEN EXTRACT(EPOCH FROM (u.fe_respuesta - u.fe_envio))::int
      END AS "segundosCorridos",
      CASE WHEN u.fe_respuesta IS NOT NULL
           THEN (EXTRACT(EPOCH FROM (u.fe_respuesta - u.fe_envio)) - fds.segundos)::int
      END AS "segundosHabiles",
      u.participaciones AS participaciones
    FROM ultima u
    LEFT JOIN ${S}.tdtr_estados est
      ON est.co_est = u.es_doc_rec AND est.de_tab = 'TDTV_DESTINOS'
    -- Segundos del lapso que caen en sábado o domingo, para descontarlos del tiempo corrido.
    -- No se usa idosgd.pk_sgd_descripcion_fu_dia_tra (la función de días hábiles del legado)
    -- porque se apoya en idosgd.sitm_calendario, que en esta BD está VACÍA: devuelve 0 días
    -- hábiles incluso para un lapso de 30 días. Al no haber calendario tampoco hay feriados,
    -- así que "hábiles" aquí significa "sin fines de semana".
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(
        EXTRACT(EPOCH FROM (
          LEAST(u.fe_respuesta, g.dia + interval '1 day') - GREATEST(u.fe_envio, g.dia)
        ))
      ), 0) AS segundos
      FROM generate_series(
        date_trunc('day', u.fe_envio),
        date_trunc('day', u.fe_respuesta),
        interval '1 day'
      ) AS g(dia)
      WHERE EXTRACT(ISODOW FROM g.dia) IN (6, 7)
        AND LEAST(u.fe_respuesta, g.dia + interval '1 day') > GREATEST(u.fe_envio, g.dia)
    ) fds ON TRUE
    ORDER BY u.fe_envio DESC
    `,
    { bind: [coEmpleado, coDependencia], type: QueryTypes.SELECT },
  );
}

/**
 * Busca expedientes por su número visible (`TDTX_REMITOS_RESUMEN.NU_EXPEDIENTE`, ej.
 * "OGAUL02026000058") sin necesidad de elegir antes una dependencia y un usuario — esta página
 * está armada enteramente desde la perspectiva de UN usuario (ver `getExpedientesPorUsuario`), así
 * que "buscar un expediente" solo tiene sentido si además se resuelve QUIÉN lo tiene: el
 * participante más reciente (el destino con el `FE_EMI` más alto entre los documentos vigentes del
 * expediente), igual que el resto del sistema define "última participación".
 *
 * Un expediente sin ningún destino válido (raro, pero posible) queda fuera del resultado: no hay
 * a quién saltar.
 */
export async function buscarExpedientePorNumero(termino: string): Promise<ExpedienteEncontrado[]> {
  // Los comodines de LIKE que el usuario haya tecleado se escapan para que se busquen literales,
  // no patrones — el bind ya cubre la inyección, esto es solo semántica de búsqueda.
  const escapado = termino.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

  return sequelize.query<ExpedienteEncontrado>(
    `
    WITH coincidencias AS (
      SELECT a.nu_ann_exp, a.nu_sec_exp, res.nu_expediente, a.fe_emi
      FROM ${S}.tdtv_remitos a
      JOIN ${S}.tdtx_remitos_resumen res ON res.nu_ann = a.nu_ann AND res.nu_emi = a.nu_emi
      WHERE a.es_eli = '0'
        AND COALESCE(a.nu_ann_exp, '') <> ''
        AND COALESCE(a.nu_sec_exp, '') <> ''
        AND res.nu_expediente ILIKE '%' || $1 || '%' ESCAPE '\\'
    ),
    expedientes AS (
      SELECT DISTINCT ON (nu_ann_exp, nu_sec_exp) nu_ann_exp, nu_sec_exp, nu_expediente
      FROM coincidencias
      ORDER BY nu_ann_exp, nu_sec_exp, fe_emi DESC
      LIMIT 20
    ),
    ultimo AS (
      SELECT ex.nu_ann_exp, ex.nu_sec_exp, ex.nu_expediente,
             d.co_dep_des, d.co_emp_des, a.fe_emi,
             row_number() OVER (
               PARTITION BY ex.nu_ann_exp, ex.nu_sec_exp
               ORDER BY a.fe_emi DESC, d.nu_des DESC
             ) AS rn
      FROM expedientes ex
      JOIN ${S}.tdtv_remitos a ON a.nu_ann_exp = ex.nu_ann_exp AND a.nu_sec_exp = ex.nu_sec_exp
      JOIN ${S}.tdtv_destinos d ON d.nu_ann = a.nu_ann AND d.nu_emi = a.nu_emi
      WHERE a.es_eli = '0' AND d.es_eli = '0'
        AND a.es_doc_emi NOT IN (${ESTADOS_REMITO_EXCLUIDOS})
        AND COALESCE(d.co_emp_des, '') <> ''
    )
    SELECT
      u.nu_ann_exp AS "nuAnnExp",
      u.nu_sec_exp AS "nuSecExp",
      u.nu_expediente AS "numeroExpediente",
      u.co_dep_des AS "coDependencia",
      u.co_emp_des AS "coEmpleado",
      NULLIF(TRIM(CONCAT_WS(' ', e.cemp_apepat, e.cemp_apemat, e.cemp_denom)), '') AS "nombreCompleto",
      COALESCE(dep.de_dependencia, u.co_dep_des) AS "nombreDependencia"
    FROM ultimo u
    LEFT JOIN ${S}.rhtm_per_empleados e ON e.cemp_codemp = u.co_emp_des
    LEFT JOIN ${S}.rhtm_dependencia dep ON dep.co_dependencia = u.co_dep_des
    WHERE u.rn = 1
    ORDER BY u.fe_emi DESC
    `,
    { bind: [escapado], type: QueryTypes.SELECT },
  );
}
