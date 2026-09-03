import { QueryTypes, type Transaction } from 'sequelize';
import { appSequelize } from '../config/appDatabase';
import { DB_SCHEMA, sequelize } from '../config/database';
import { leerBooleano, leerNumero } from '../rag/configService';
import {
  agruparAsuntos,
  esqueletoAsunto,
  normalizarAsunto,
  type EntradaAsunto,
} from './procesoAgrupamiento';

const S = DB_SCHEMA;

/** Distinto del de `barridoService.ts` (815_243_001) — son recursos independientes, cada uno con
 *  su propio candado, para que un refresco del dashboard nunca compita con un barrido del RAG. */
const LOCK_ID = 815_243_002;

/** Mismo criterio que `dashboardService.ts` — duplicado a propósito: esta consulta corre contra
 *  el SGD antes de que exista ninguna fila en `dashboard.participacion`, así que no puede
 *  depender de datos ya materializados. */
const ESTADOS_REMITO_EXCLUIDOS = "'5','7','8','9'";
const ESTADOS_RECEPCION_ATENDIDOS = "'2','3'";
const MOTIVOS_INFORMATIVOS = "'1','4','6','B','C'";

export class RefrescoOcupado extends Error {
  constructor() {
    super('Ya hay un refresco del resumen en curso');
    this.name = 'RefrescoOcupado';
  }
}

interface FilaParticipacionCruda {
  coEmpDes: string;
  nombreEmpleado: string | null;
  coDepDes: string;
  nombreDependencia: string | null;
  /** Oficina que EMITIÓ el documento recibido — Fase 8, ver migración 011. Distinta de `coDepDes`
   *  cuando la recepción viene de otra oficina; igual cuando es la respuesta que la propia oficina
   *  de destino se manda a sí misma dentro del mismo expediente. */
  coDepEmi: string | null;
  coTipDoc: string | null;
  esInformativo: boolean;
  feEnvio: string;
  atendido: boolean;
  segundosCorridos: string | null;
  segundosHabiles: string | null;
  nuAnnExp: string;
  nuSecExp: string;
  /** Asunto del documento recibido (`tdtv_remitos.de_asu`) — se guarda normalizado
   *  (`normalizarAsunto`) para que "Reproceso" solo cuente cuando el empleado vuelve sobre el
   *  MISMO asunto dentro del expediente, no cada vez que el expediente le pasa por delante con un
   *  asunto distinto (etapas normales del trámite). Ver migración 012. */
  asunto: string | null;
}

/** Se movió a `procesoAgrupamiento.ts` (junto al resto del tratamiento de asuntos) cuando la vista
 *  de calidad de procesos pasó a necesitarla también; se re-exporta para no romper a quien la
 *  importe desde aquí, incluida la migración 012 que la nombra por su ubicación anterior. */
export { normalizarAsunto };

/**
 * Trae, en una sola pasada, TODAS las participaciones históricas ya emparejadas con su respuesta
 * — exactamente la misma lógica de `dashboardService.construirParticipaciones`, pero:
 *   - sin acotar por fecha (el espejo debe servir cualquier rango que pida el filtro, y
 *     "Pendientes" necesita ver todo el backlog sin importar cuándo se recibió);
 *   - con los nombres de empleado/dependencia ya resueltos aquí (desnormalizados), porque la
 *     consulta local no puede hacer JOIN contra el SGD (servidores distintos).
 *
 * Este es el único lugar del sistema donde el LATERAL JOIN caro (§5 del plan, hallazgo de
 * rendimiento 2026-08-28) se ejecuta — una vez por refresco, no una vez por carga de página.
 */
async function leerParticipacionesSgd(): Promise<FilaParticipacionCruda[]> {
  return sequelize.query<FilaParticipacionCruda>(
    `
    WITH recepciones AS (
      SELECT
        a.nu_ann_exp, a.nu_sec_exp,
        d.co_emp_des, d.co_dep_des, d.es_doc_rec, d.co_mot,
        a.co_tip_doc_adm, a.co_dep_emi, a.de_asu,
        a.fe_emi AS fe_envio
      FROM ${S}.tdtv_destinos d
      JOIN ${S}.tdtv_remitos a ON a.nu_ann = d.nu_ann AND a.nu_emi = d.nu_emi
      WHERE a.es_doc_emi NOT IN (${ESTADOS_REMITO_EXCLUIDOS})
        AND a.es_eli = '0'
        AND d.es_eli = '0'
        AND COALESCE(a.nu_ann_exp, '') <> ''
        AND COALESCE(a.nu_sec_exp, '') <> ''
        AND COALESCE(d.co_emp_des, '') <> ''
    ),
    recepciones_ventana AS (
      SELECT r.*,
        LEAD(r.fe_envio) OVER (
          PARTITION BY r.co_emp_des, r.nu_ann_exp, r.nu_sec_exp
          ORDER BY r.fe_envio
        ) AS siguiente_recepcion
      FROM recepciones r
    ),
    emisiones AS (
      SELECT a.nu_ann_exp, a.nu_sec_exp, a.co_emp_emi, a.fe_emi
      FROM ${S}.tdtv_remitos a
      WHERE a.es_eli = '0'
        AND a.es_doc_emi NOT IN ('5','9')
        AND COALESCE(a.nu_ann_exp, '') <> ''
        AND COALESCE(a.nu_sec_exp, '') <> ''
    )
    SELECT
      r.co_emp_des AS "coEmpDes",
      NULLIF(TRIM(CONCAT_WS(' ', emp.cemp_apepat, emp.cemp_apemat, emp.cemp_denom)), '') AS "nombreEmpleado",
      r.co_dep_des AS "coDepDes",
      COALESCE(dep.de_dependencia, r.co_dep_des) AS "nombreDependencia",
      r.co_dep_emi AS "coDepEmi",
      r.co_tip_doc_adm AS "coTipDoc",
      (r.co_mot IN (${MOTIVOS_INFORMATIVOS})) AS "esInformativo",
      r.fe_envio AS "feEnvio",
      (e.fe_emi IS NOT NULL OR r.es_doc_rec IN (${ESTADOS_RECEPCION_ATENDIDOS})) AS atendido,
      CASE WHEN e.fe_emi IS NOT NULL
           THEN EXTRACT(EPOCH FROM (e.fe_emi - r.fe_envio))::text
      END AS "segundosCorridos",
      CASE WHEN e.fe_emi IS NOT NULL
           THEN (EXTRACT(EPOCH FROM (e.fe_emi - r.fe_envio)) - fds.segundos)::text
      END AS "segundosHabiles",
      r.nu_ann_exp AS "nuAnnExp",
      r.nu_sec_exp AS "nuSecExp",
      r.de_asu AS asunto
    FROM recepciones_ventana r
    LEFT JOIN LATERAL (
      SELECT em.fe_emi
      FROM emisiones em
      WHERE em.co_emp_emi = r.co_emp_des
        AND em.nu_ann_exp = r.nu_ann_exp
        AND em.nu_sec_exp = r.nu_sec_exp
        AND em.fe_emi >= r.fe_envio
        AND (r.siguiente_recepcion IS NULL OR em.fe_emi < r.siguiente_recepcion)
      ORDER BY em.fe_emi
      LIMIT 1
    ) e ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(
        EXTRACT(EPOCH FROM (
          LEAST(e.fe_emi, g.dia + interval '1 day') - GREATEST(r.fe_envio, g.dia)
        ))
      ), 0) AS segundos
      FROM generate_series(
        date_trunc('day', r.fe_envio),
        date_trunc('day', e.fe_emi),
        interval '1 day'
      ) AS g(dia)
      WHERE e.fe_emi IS NOT NULL
        AND EXTRACT(ISODOW FROM g.dia) IN (6, 7)
        AND LEAST(e.fe_emi, g.dia + interval '1 day') > GREATEST(r.fe_envio, g.dia)
    ) fds ON TRUE
    LEFT JOIN ${S}.rhtm_per_empleados emp ON emp.cemp_codemp = r.co_emp_des
    LEFT JOIN ${S}.rhtm_dependencia dep ON dep.co_dependencia = r.co_dep_des
    `,
    { type: QueryTypes.SELECT },
  );
}

interface FilaPasoCruda {
  nuAnnExp: string;
  nuSecExp: string;
  nuEmi: string;
  nuDes: string;
  coDepEmi: string | null;
  coDepDes: string;
  nombreDependencia: string | null;
  coMot: string | null;
  coTipDoc: string | null;
  esInformativo: boolean;
  esDocRec: string | null;
  feEnvio: string;
  feApertura: string | null;
  segundosTotal: string | null;
  segundosEspera: string | null;
  segundosTrabajo: string | null;
  asunto: string | null;
}

/**
 * El mismo emparejamiento recepción→respuesta de `leerParticipacionesSgd`, pero a nivel **OFICINA**
 * — la base del flujograma de la vista de calidad de procesos. Tres diferencias deliberadas:
 *
 *  1. **Sin** el filtro `COALESCE(d.co_emp_des,'') <> ''`. Ese filtro es correcto para un KPI por
 *     empleado, pero aquí descartaría 1 354 de 48 281 destinos (2,8%, verificado ✅ 2026-09-02) que
 *     son derivaciones a la oficina sin persona nombrada — agujeros en medio de la cadena.
 *  2. El `LATERAL` empareja por **`co_dep_emi = co_dep_des`**, no por empleado: el reloj de una
 *     oficina tiene que correr desde que el documento llega hasta que sale, aunque entre por el
 *     jefe y salga firmado por un especialista.
 *  3. La ventana `LEAD` particiona por `(co_dep_des, nu_ann_exp, nu_sec_exp)`, coherente con (2).
 *
 * Además trae `co_dep_des` NO vacío: los destinos externos (RUC/DNI/otro origen, `ti_des <> '01'`)
 * no son un paso del flujo entre oficinas y meterlos rompe la traza con un nodo sin nombre.
 *
 * `segundos_espera`/`segundos_trabajo` parten el tiempo del nodo usando `fe_rec_doc` (cuándo lo
 * abrieron). Verificado ✅ 2026-09-02: 91,9% de cobertura y el 100% con hora real — sirve, a
 * diferencia de `fe_ate_doc`, que solo tiene precisión de día.
 */
async function leerPasosSgd(): Promise<FilaPasoCruda[]> {
  return sequelize.query<FilaPasoCruda>(
    `
    WITH recepciones AS (
      SELECT
        a.nu_ann_exp, a.nu_sec_exp, a.nu_emi, d.nu_des,
        d.co_dep_des, d.es_doc_rec, d.co_mot, d.fe_rec_doc,
        a.co_tip_doc_adm, a.co_dep_emi, a.de_asu,
        a.fe_emi AS fe_envio
      FROM ${S}.tdtv_destinos d
      JOIN ${S}.tdtv_remitos a ON a.nu_ann = d.nu_ann AND a.nu_emi = d.nu_emi
      WHERE a.es_doc_emi NOT IN (${ESTADOS_REMITO_EXCLUIDOS})
        AND a.es_eli = '0'
        AND d.es_eli = '0'
        AND COALESCE(a.nu_ann_exp, '') <> ''
        AND COALESCE(a.nu_sec_exp, '') <> ''
        AND COALESCE(d.co_dep_des, '') <> ''
    ),
    recepciones_ventana AS (
      SELECT r.*,
        LEAD(r.fe_envio) OVER (
          PARTITION BY r.co_dep_des, r.nu_ann_exp, r.nu_sec_exp
          ORDER BY r.fe_envio, r.nu_emi, r.nu_des
        ) AS siguiente_recepcion
      FROM recepciones r
    ),
    emisiones AS (
      SELECT a.nu_ann_exp, a.nu_sec_exp, a.co_dep_emi, a.fe_emi
      FROM ${S}.tdtv_remitos a
      WHERE a.es_eli = '0'
        AND a.es_doc_emi NOT IN ('5','9')
        AND COALESCE(a.nu_ann_exp, '') <> ''
        AND COALESCE(a.nu_sec_exp, '') <> ''
    )
    SELECT
      r.nu_ann_exp AS "nuAnnExp",
      r.nu_sec_exp AS "nuSecExp",
      r.nu_emi AS "nuEmi",
      r.nu_des::text AS "nuDes",
      r.co_dep_emi AS "coDepEmi",
      r.co_dep_des AS "coDepDes",
      COALESCE(dep.de_dependencia, r.co_dep_des) AS "nombreDependencia",
      r.co_mot AS "coMot",
      r.co_tip_doc_adm AS "coTipDoc",
      (r.co_mot IN (${MOTIVOS_INFORMATIVOS})) AS "esInformativo",
      r.es_doc_rec AS "esDocRec",
      r.fe_envio AS "feEnvio",
      r.fe_rec_doc AS "feApertura",
      CASE WHEN e.fe_emi IS NOT NULL
           THEN EXTRACT(EPOCH FROM (e.fe_emi - r.fe_envio))::text
      END AS "segundosTotal",
      -- Espera: llegó → lo abrieron. Solo si la apertura cae DENTRO del tramo (hay filas con
      -- fe_rec_doc anterior al envío o posterior a la respuesta; ahí el reparto no tiene sentido
      -- y se deja en NULL en vez de inventar un número negativo).
      CASE WHEN r.fe_rec_doc IS NOT NULL AND r.fe_rec_doc >= r.fe_envio
                AND (e.fe_emi IS NULL OR r.fe_rec_doc <= e.fe_emi)
           THEN EXTRACT(EPOCH FROM (r.fe_rec_doc - r.fe_envio))::text
      END AS "segundosEspera",
      CASE WHEN e.fe_emi IS NOT NULL AND r.fe_rec_doc IS NOT NULL
                AND r.fe_rec_doc >= r.fe_envio AND r.fe_rec_doc <= e.fe_emi
           THEN EXTRACT(EPOCH FROM (e.fe_emi - r.fe_rec_doc))::text
      END AS "segundosTrabajo",
      r.de_asu AS asunto
    FROM recepciones_ventana r
    LEFT JOIN LATERAL (
      SELECT em.fe_emi
      FROM emisiones em
      WHERE em.co_dep_emi = r.co_dep_des
        AND em.nu_ann_exp = r.nu_ann_exp
        AND em.nu_sec_exp = r.nu_sec_exp
        AND em.fe_emi >= r.fe_envio
        AND (r.siguiente_recepcion IS NULL OR em.fe_emi < r.siguiente_recepcion)
      ORDER BY em.fe_emi
      LIMIT 1
    ) e ON TRUE
    LEFT JOIN ${S}.rhtm_dependencia dep ON dep.co_dependencia = r.co_dep_des
    `,
    { type: QueryTypes.SELECT },
  );
}

interface FilaEmisionCruda {
  coDepEmi: string | null;
  coEmpEmi: string | null;
  coTipDoc: string | null;
  esDocEmi: string;
  feEmi: string;
}

/** Todo lo emitido, sin filtrar por estado — a diferencia de `recepciones`, aquí interesa contar
 *  también lo anulado ('9'), que es justo lo que mide la tasa de anulación (Fase 2). */
async function leerEmisionesSgd(): Promise<FilaEmisionCruda[]> {
  return sequelize.query<FilaEmisionCruda>(
    `SELECT a.co_dep_emi AS "coDepEmi", a.co_emp_emi AS "coEmpEmi", a.co_tip_doc_adm AS "coTipDoc",
            a.es_doc_emi AS "esDocEmi", a.fe_emi AS "feEmi"
       FROM ${S}.tdtv_remitos a
      WHERE a.es_eli = '0'
        AND COALESCE(a.nu_ann_exp, '') <> ''`,
    { type: QueryTypes.SELECT },
  );
}

/** Inserta en lotes para no exceder el límite de binds por consulta (65 535) ni construir una
 *  sola sentencia gigante — 2 000 filas por lote es conservador para cualquiera de las dos tablas. */
async function insertarEnLotes(
  tabla: string,
  columnas: string[],
  filas: unknown[][],
  tx: Transaction,
): Promise<void> {
  const LOTE = 2000;
  for (let i = 0; i < filas.length; i += LOTE) {
    const lote = filas.slice(i, i + LOTE);
    const binds: unknown[] = [];
    const placeholders = lote
      .map((fila) => {
        const marcas = fila.map((valor) => {
          binds.push(valor);
          return `$${binds.length}`;
        });
        return `(${marcas.join(',')})`;
      })
      .join(',');

    await appSequelize.query(
      `INSERT INTO ${tabla} (${columnas.join(',')}) VALUES ${placeholders}`,
      { bind: binds, transaction: tx, type: QueryTypes.INSERT },
    );
  }
}

export interface ResultadoRefresco {
  id: number;
  participaciones: number;
  emisiones: number;
  pasos: number;
  procesos: number;
  msSgd: number;
  msTotal: number;
}

/** Asignación de cada expediente a su familia de proceso, lista para insertar. */
interface FamiliasDescubiertas {
  procesos: unknown[][];
  asignaciones: unknown[][];
}

/**
 * Descubre las familias de proceso agrupando el asunto de ORIGEN de cada expediente — el del primer
 * paso, no un asunto cualquiera: `de_asu` es por documento y cambia en cada salto del trámite (la
 * validación de Fase N ya lo mostró: un mismo expediente pasa por la misma persona con asuntos
 * distintos en cada etapa). El de origen es el único que dice de qué se trata el expediente.
 *
 * Corre en el refresco y no en la consulta porque el agrupamiento es caro y su resultado no depende
 * del filtro que pida cada carga de la vista — mismo criterio que `es_informativo`/`asunto_norm`.
 */
function descubrirProcesos(pasos: FilaPasoCruda[], umbral: number): FamiliasDescubiertas {
  // Primer paso de cada expediente. `pasos` no viene ordenado (la consulta no lleva ORDER BY: el
  // orden no importa para insertar, y pedirlo costaría una ordenación de ~48 000 filas en el SGD),
  // así que el mínimo se toma comparando explícitamente.
  const origen = new Map<string, FilaPasoCruda>();
  for (const paso of pasos) {
    if (paso.esInformativo) continue;
    const clave = `${paso.nuAnnExp}|${paso.nuSecExp}`;
    const actual = origen.get(clave);
    if (!actual || comparaOrden(paso, actual) < 0) origen.set(clave, paso);
  }

  const frecuencias = new Map<string, number>();
  const esqueletoPorExpediente = new Map<string, string>();
  for (const [clave, paso] of origen) {
    const esqueleto = esqueletoAsunto(paso.asunto);
    if (!esqueleto) continue; // sin texto útil: queda sin familia, no en una familia basura
    esqueletoPorExpediente.set(clave, esqueleto);
    frecuencias.set(esqueleto, (frecuencias.get(esqueleto) ?? 0) + 1);
  }

  const entradas: EntradaAsunto[] = [...frecuencias].map(([esqueleto, frecuencia]) => ({
    esqueleto,
    frecuencia,
  }));
  const familias = agruparAsuntos(entradas, umbral);

  const procesos = new Map<string, unknown[]>();
  const asignaciones: unknown[][] = [];
  for (const [clave, esqueleto] of esqueletoPorExpediente) {
    const familia = familias.get(esqueleto);
    if (!familia) continue;
    procesos.set(familia.clave, [familia.clave, familia.nombre, familia.expedientes]);
    const [nuAnnExp, nuSecExp] = clave.split('|');
    asignaciones.push([nuAnnExp, nuSecExp, familia.clave, origen.get(clave)?.asunto ?? null]);
  }

  return { procesos: [...procesos.values()], asignaciones };
}

/** Orden canónico de los pasos dentro de un expediente, igual que `getInteraccionesExpediente`:
 *  fecha de envío y, para desempatar dos remitos del mismo segundo, `nu_emi` y `nu_des`. */
function comparaOrden(a: FilaPasoCruda, b: FilaPasoCruda): number {
  if (a.feEnvio !== b.feEnvio) return a.feEnvio < b.feEnvio ? -1 : 1;
  if (a.nuEmi !== b.nuEmi) return a.nuEmi < b.nuEmi ? -1 : 1;
  return a.nuDes < b.nuDes ? -1 : a.nuDes > b.nuDes ? 1 : 0;
}

/**
 * Refresca el espejo local completo: trae TODO de nuevo desde el SGD y reemplaza el contenido de
 * `dashboard.participacion`/`dashboard.emision` dentro de una transacción.
 *
 * **Reemplazo completo, no incremental.** Una recepción "pendiente" puede pasar a "atendida" sin
 * que la propia fila de recepción cambie (la respuesta es un documento distinto) — detectar eso
 * de forma incremental exigiría vigilar cambios en dos tablas del SGD a la vez. Con el volumen
 * actual (~42 000 remitos, todos dentro de los últimos ~4 meses), una pasada completa cuesta lo
 * mismo que ya costaba CADA carga del dashboard antes de esta mejora (8-10 s, medido ✅
 * 2026-08-28) — pagarlo una vez cada `dashboard.resumen.cadencia_min` en vez de en cada página es
 * la mejora en sí.
 *
 * `DELETE` + `INSERT` en la MISMA transacción, no `TRUNCATE`: `TRUNCATE` toma un lock que bloquea
 * lecturas concurrentes durante todo el refresco; `DELETE` no — quien esté leyendo mientras esto
 * corre sigue viendo la versión anterior completa hasta que la transacción confirma, y después ve
 * la nueva completa. Nunca hay una ventana con la tabla a medias ni vacía.
 */
export async function refrescarResumen(disparo: 'automatico' | 'manual' = 'manual'): Promise<ResultadoRefresco> {
  const inicio = Date.now();

  const bloqueo = await appSequelize.query<{ ok: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS ok',
    { bind: [LOCK_ID], type: QueryTypes.SELECT },
  );
  if (!bloqueo[0]?.ok) throw new RefrescoOcupado();

  const [{ id }] = await appSequelize.query<{ id: number }>(
    'INSERT INTO dashboard.resumen_refresco (disparo) VALUES ($1) RETURNING id',
    { bind: [disparo], type: QueryTypes.SELECT },
  );

  try {
    const inicioSgd = Date.now();
    const [participaciones, emisiones, pasos] = await Promise.all([
      leerParticipacionesSgd(),
      leerEmisionesSgd(),
      leerPasosSgd(),
    ]);
    const msSgd = Date.now() - inicioSgd;

    const umbralSimilitud = await leerNumero('calidad.proceso.similitud_min', 0.55);
    const { procesos, asignaciones } = descubrirProcesos(pasos, umbralSimilitud);

    await appSequelize.transaction(async (tx) => {
      await appSequelize.query('DELETE FROM dashboard.participacion', { transaction: tx });
      await insertarEnLotes(
        'dashboard.participacion',
        [
          'co_emp_des', 'nombre_empleado', 'co_dep_des', 'nombre_dependencia', 'co_dep_emi', 'co_tip_doc',
          'es_informativo', 'fe_envio', 'atendido', 'segundos_corridos', 'segundos_habiles',
          'nu_ann_exp', 'nu_sec_exp', 'asunto_norm',
        ],
        participaciones.map((p) => [
          p.coEmpDes, p.nombreEmpleado, p.coDepDes, p.nombreDependencia, p.coDepEmi, p.coTipDoc,
          p.esInformativo, p.feEnvio, p.atendido, p.segundosCorridos, p.segundosHabiles,
          p.nuAnnExp, p.nuSecExp, normalizarAsunto(p.asunto),
        ]),
        tx,
      );

      await appSequelize.query('DELETE FROM dashboard.emision', { transaction: tx });
      await insertarEnLotes(
        'dashboard.emision',
        ['co_dep_emi', 'co_emp_emi', 'co_tip_doc', 'es_doc_emi', 'fe_emi'],
        emisiones.map((e) => [e.coDepEmi, e.coEmpEmi, e.coTipDoc, e.esDocEmi, e.feEmi]),
        tx,
      );

      // Vista de calidad de procesos. Va en la MISMA transacción que el resto del espejo a
      // propósito: así "Datos actualizados hace X min" vale para las dos vistas y nunca se ve un
      // flujograma calculado sobre pasos de un refresco y familias de otro.
      await appSequelize.query('DELETE FROM dashboard.paso', { transaction: tx });
      await insertarEnLotes(
        'dashboard.paso',
        [
          'nu_ann_exp', 'nu_sec_exp', 'nu_emi', 'nu_des', 'co_dep_emi', 'co_dep_des',
          'nombre_dependencia', 'co_mot', 'co_tip_doc', 'es_informativo', 'es_doc_rec',
          'fe_envio', 'fe_apertura', 'segundos_total', 'segundos_espera', 'segundos_trabajo',
          'asunto_norm',
        ],
        pasos.map((p) => [
          p.nuAnnExp, p.nuSecExp, p.nuEmi, p.nuDes, p.coDepEmi, p.coDepDes,
          p.nombreDependencia, p.coMot, p.coTipDoc, p.esInformativo, p.esDocRec,
          p.feEnvio, p.feApertura, p.segundosTotal, p.segundosEspera, p.segundosTrabajo,
          normalizarAsunto(p.asunto),
        ]),
        tx,
      );

      await appSequelize.query('DELETE FROM dashboard.proceso_expediente', { transaction: tx });
      await appSequelize.query('DELETE FROM dashboard.proceso', { transaction: tx });
      await insertarEnLotes(
        'dashboard.proceso',
        ['clave', 'nombre_auto', 'expedientes'],
        procesos,
        tx,
      );
      await insertarEnLotes(
        'dashboard.proceso_expediente',
        ['nu_ann_exp', 'nu_sec_exp', 'proceso_clave', 'asunto_origen'],
        asignaciones,
        tx,
      );
    });

    const msTotal = Date.now() - inicio;
    await appSequelize.query(
      `UPDATE dashboard.resumen_refresco
          SET fe_fin = now(), participaciones = $2, emisiones = $3, ms_sgd = $4, ms_total = $5
        WHERE id = $1`,
      { bind: [id, participaciones.length, emisiones.length, msSgd, msTotal], type: QueryTypes.UPDATE },
    );

    return {
      id,
      participaciones: participaciones.length,
      emisiones: emisiones.length,
      pasos: pasos.length,
      procesos: procesos.length,
      msSgd,
      msTotal,
    };
  } catch (error) {
    await appSequelize.query(
      'UPDATE dashboard.resumen_refresco SET fe_fin = now(), error = $2 WHERE id = $1',
      { bind: [id, error instanceof Error ? error.message : 'error desconocido'], type: QueryTypes.UPDATE },
    );
    throw error;
  } finally {
    await appSequelize.query('SELECT pg_advisory_unlock($1)', { bind: [LOCK_ID], type: QueryTypes.SELECT });
  }
}

export interface EstadoResumen {
  ultimoRefresco: string | null;
  minutosDesde: number | null;
  participaciones: number;
  ultimoError: string | null;
}

/** Para la nota "Datos actualizados hace X min" de la UI, y para que el planificador sepa si ya
 *  toca correr de nuevo. */
export async function estadoResumen(): Promise<EstadoResumen> {
  const [ultimo] = await appSequelize.query<{
    feFin: string | null;
    minutos: number | null;
    error: string | null;
  }>(
    `SELECT fe_fin::text AS "feFin",
            EXTRACT(EPOCH FROM (now() - fe_fin)) / 60 AS minutos,
            error
       FROM dashboard.resumen_refresco
      WHERE fe_fin IS NOT NULL OR error IS NOT NULL
      ORDER BY fe_inicio DESC
      LIMIT 1`,
    { type: QueryTypes.SELECT },
  );

  const [{ n }] = await appSequelize.query<{ n: string }>(
    'SELECT count(*) AS n FROM dashboard.participacion',
    { type: QueryTypes.SELECT },
  );

  return {
    ultimoRefresco: ultimo?.feFin ?? null,
    minutosDesde: ultimo?.minutos ?? null,
    participaciones: Number(n),
    ultimoError: ultimo?.error ?? null,
  };
}

let temporizador: NodeJS.Timeout | null = null;

/**
 * Igual patrón que `iniciarPlanificadorBarrido`: el planificador siempre corre, el interruptor
 * `dashboard.resumen.activo` se consulta en cada tick — activarlo/desactivarlo surte efecto sin
 * reiniciar el contenedor. A diferencia del barrido del RAG (que arranca desactivado porque puede
 * derivar en gasto de LLM), este arranca ACTIVADO por defecto: sin refresco periódico el
 * dashboard mostraría el espejo vacío o desactualizado para siempre, y no tiene ningún costo
 * externo — es una consulta SQL en background.
 */
export function iniciarPlanificadorResumen(): void {
  if (temporizador) return;

  const tick = async () => {
    try {
      if (!(await leerBooleano('dashboard.resumen.activo', true))) return;

      const cadencia = await leerNumero('dashboard.resumen.cadencia_min', 15);
      const estado = await estadoResumen();

      if (estado.minutosDesde !== null && estado.minutosDesde < cadencia) return;

      const resultado = await refrescarResumen('automatico');
      console.log(
        `Resumen del dashboard refrescado: ${resultado.participaciones} participaciones, `
          + `${resultado.emisiones} emisiones, ${resultado.msTotal} ms`,
      );
    } catch (error) {
      if (error instanceof RefrescoOcupado) return; // otro refresco en curso: normal
      console.error('Refresco automático del dashboard falló:', error);
    }
  };

  // Se comprueba cada minuto; la cadencia real la decide `dashboard.resumen.cadencia_min`.
  temporizador = setInterval(() => void tick(), 60_000);
  temporizador.unref();
}
