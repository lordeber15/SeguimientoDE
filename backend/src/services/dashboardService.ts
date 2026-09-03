import { QueryTypes } from 'sequelize';
import { appSequelize } from '../config/appDatabase';
import { DB_SCHEMA, sequelize } from '../config/database';

const S = DB_SCHEMA;

export interface FiltroResumen {
  /** Rango sobre `fe_envio` de la recepción — "recibido en el período", formato `YYYY-MM-DD`.
   *  Cada extremo es OPCIONAL e independiente del otro (Fase 9): sin ninguno de los dos, la
   *  consulta es sobre todo el histórico; con uno solo, el rango queda abierto de ese lado. */
  desde?: string;
  hasta?: string;
  coDependencia?: string;
  /** `SI_MAE_TIPO_DOC.cdoc_tipdoc`. */
  tipoDocumento?: string;
}

/** Campos de calidad y carga (Fase 2) comunes a la fila de oficina y a la de empleado. */
interface KpiCalidad {
  /** Motivos donde no se espera devolución (COPIA, INFORMAR, PARA CONOCIMIENTO…) — mismas
   *  columnas que `recibidos`/`atendidos`/`pendientes`/`tasaAtencion`, pero fuera de esos totales. */
  recibidosInformativos: number;
  atendidosInformativos: number;
  pendientesInformativos: number;
  tasaAtencionInformativos: number;
  /** Expedientes distintos tocados en el rango (cuenta acción + informativos). */
  expedientesDistintos: number;
  /** Total de participaciones (recepciones) en el rango — acción + informativos. */
  movimientos: number;
  /** `movimientos / expedientesDistintos` — cuántas veces en promedio circula cada expediente. */
  movimientosPromedioPorExpediente: number | null;
  /** Pares (empleado, expediente) distintos — a nivel oficina, suma los de todos sus empleados. */
  gruposEmpleadoExpediente: number;
  /** De esos pares, cuántos tuvieron más de una recepción del mismo empleado **con el mismo
   *  asunto** en el rango — proxy de reproceso: "el mismo empleado volvió sobre lo mismo", no un
   *  "devuelto" real. El asunto es parte del criterio porque un expediente pasa varias veces por
   *  la misma persona con asuntos DISTINTOS (etapas normales del trámite): eso es circulación, no
   *  retroceso. Se compara contra `asunto_norm` (normalizado en el refresco, ver migración 012);
   *  una recepción sin asunto nunca marca reproceso. */
  gruposReprocesados: number;
  tasaReproceso: number | null;
  /** Documentos EMITIDOS en el rango por esta oficina/empleado (`co_dep_emi`/`co_emp_emi`, no
   *  `_des`) — dimensión distinta a todo lo anterior: mide calidad de lo que esta oficina emite,
   *  no lo que recibe. `es_doc_emi='8'` (OBSERVADO) no tiene ninguna fila en la BD real, así que
   *  solo `'9'` ANULADO es medible hoy. */
  emitidos: number;
  anulados: number;
  tasaAnulacion: number | null;
}

export interface KpiEmpleado extends KpiCalidad {
  coEmpleado: string;
  nombreCompleto: string | null;
  coDependencia: string;
  nombreDependencia: string | null;
  /** Fase 6 — `RHTM_DEPENDENCIA.TI_DEPENDENCIA = '1'`. Ver `KpiOficina`. */
  esComite: boolean;
  recibidos: number;
  /** Fase 8 — de `recibidos`, cuánto vino de OTRA oficina (`co_dep_emi <> co_dep_des`, o el
   *  origen no se pudo determinar). Ver `recibidosMismaOficina`. */
  recibidosExternos: number;
  /** Recibido cuyo emisor es la MISMA oficina de destino — típicamente la respuesta que la propia
   *  oficina se manda a sí misma dentro de un expediente que ella misma impulsó, no carga nueva
   *  que le llegó de afuera. */
  recibidosMismaOficina: number;
  atendidos: number;
  pendientes: number;
  tasaAtencion: number;
  tiempoPromedioHoras: number | null;
  tiempoMedianoHoras: number | null;
  tiempoPromedioHabilHoras: number | null;
  /** Fase 3 — ver `productividadPonderada` en `KpiOficina`. */
  productividadPonderada: number;
  cargaPonderada: number;
}

export interface KpiOficina extends KpiCalidad {
  coDependencia: string;
  nombreDependencia: string | null;
  /** Fase 6 — `RHTM_DEPENDENCIA.TI_DEPENDENCIA = '1'` (comité de evaluación) vs. `'0'` (oficina/
   *  unidad institucional). Verificado contra la BD real 2026-08-31: separación limpia, sin
   *  ambigüedad, entre 20 dependencias institucionales y 47 comités — no hay una tercera
   *  categoría hoy. El SGD no expone una etiqueta oficial para este dominio
   *  (`pk_sgd_descripcion_de_dominios('TI_DEPENDENCIA', ...)` no tiene entrada), así que la
   *  interpretación institución/comité es propia, no tomada de un catálogo. */
  esComite: boolean;
  recibidos: number;
  /** Fase 8 — ver `KpiEmpleado`. */
  recibidosExternos: number;
  recibidosMismaOficina: number;
  atendidos: number;
  pendientes: number;
  tasaAtencion: number;
  tiempoPromedioHoras: number | null;
  tiempoMedianoHoras: number | null;
  tiempoPromedioHabilHoras: number | null;
  /** `Σ peso(tipo) de cada recepción de acción atendida` — mismo espíritu que `atendidos`, pero
   *  pesando cada una por su complejidad (`dashboard.tipo_documento_peso`, Fase 3) en vez de
   *  contar 1 por documento. Con todos los pesos en 1 (valor por defecto), coincide con `atendidos`. */
  productividadPonderada: number;
  /** Igual idea que `productividadPonderada` pero sobre `recibidos` en vez de `atendidos` — "cuánto
   *  entró, pesado por complejidad", no "cuánto se resolvió". Con todos los pesos en 1, coincide
   *  con `recibidos`. */
  cargaPonderada: number;
}

export interface TipoDocumento {
  codigo: string;
  descripcion: string | null;
}

function redondear(valor: number | null, decimales = 2): number | null {
  if (valor === null) return null;
  const factor = 10 ** decimales;
  return Math.round(valor * factor) / factor;
}

/**
 * Filtro común de `desempenoPorOficina`/`desempenoPorEmpleado`, contra el espejo local
 * `dashboard.participacion` (ver `dashboardResumenService.ts`) — NO contra el SGD.
 *
 * Hasta 2026-08-28 esto armaba, en cada carga del dashboard, un CTE con un `LATERAL JOIN` que
 * emparejaba cada recepción del SGD con su respuesta: correcto, pero un bucle anidado que a
 * ~42 000 remitos tardaba 8-10 s (medido ✅, ver PLAN-DASHBOARD-DESEMPENO.md §5, "hallazgo de
 * rendimiento"). Ese emparejamiento ahora se hace UNA vez por refresco periódico
 * (`dashboardResumenService.refrescarResumen`), no una vez por página — aquí solo queda agregar
 * (`GROUP BY`, percentiles, ventanas) sobre una tabla local ya emparejada e indexada, que es
 * rápido sin importar el volumen del SGD.
 *
 * `desde`/`hasta`/`tipoDocIdx` son las posiciones de esos binds (si el filtro los trajo) — los
 * reutiliza la agregación de anulación (`dashboard.emision`, `construirCteAnulacion`) sin duplicar
 * la lógica de binds ni asumir posiciones fijas.
 *
 * Fase 9: `desde`/`hasta` pasaron a ser condiciones OPCIONALES e independientes, mismo patrón que
 * `coDependencia`/`tipoDocumento` — antes se sembraban siempre en `binds[0]`/`binds[1]` (`$1`/
 * `$2` fijos); ahora cada una se agrega solo si el filtro la trae, en la posición que le toque.
 * Sin ningún filtro puesto, `condiciones` queda vacío — `'true'` como base evita un `WHERE` vacío
 * (SQL inválido).
 */
function construirFiltroParticipacion(
  filtro: FiltroResumen,
): { whereSql: string; binds: unknown[]; desdeIdx: number | null; hastaIdx: number | null; tipoDocIdx: number | null } {
  const binds: unknown[] = [];
  const condiciones: string[] = [];

  let desdeIdx: number | null = null;
  let hastaIdx: number | null = null;
  let tipoDocIdx: number | null = null;

  if (filtro.desde) {
    binds.push(filtro.desde);
    desdeIdx = binds.length;
    condiciones.push(`fe_envio >= $${desdeIdx}`);
  }
  if (filtro.hasta) {
    binds.push(filtro.hasta);
    hastaIdx = binds.length;
    condiciones.push(`fe_envio < $${hastaIdx}::date + interval '1 day'`);
  }
  if (filtro.coDependencia) {
    binds.push(filtro.coDependencia);
    condiciones.push(`co_dep_des = $${binds.length}`);
  }
  if (filtro.tipoDocumento) {
    binds.push(filtro.tipoDocumento);
    tipoDocIdx = binds.length;
    condiciones.push(`co_tip_doc = $${tipoDocIdx}`);
  }

  return { whereSql: condiciones.length > 0 ? condiciones.join(' AND ') : 'true', binds, desdeIdx, hastaIdx, tipoDocIdx };
}

/** Documentos EMITIDOS en el rango (dimensión distinta a `participacion`: mide lo que esa
 *  oficina/empleado emitió, `co_dep_emi`/`co_emp_emi`, no lo que recibió) — base de la tasa de
 *  anulación (Fase 2). Reutiliza los MISMOS binds (y sus posiciones) que ya armó
 *  `construirFiltroParticipacion`, en vez de bindear su propia copia de `desde`/`hasta`. */
function construirCteAnulacion(
  agrupador: 'co_dep_emi' | 'co_emp_emi',
  desdeIdx: number | null,
  hastaIdx: number | null,
  tipoDocIdx: number | null,
): string {
  const condiciones: string[] = [];
  if (desdeIdx) condiciones.push(`fe_emi >= $${desdeIdx}`);
  if (hastaIdx) condiciones.push(`fe_emi < $${hastaIdx}::date + interval '1 day'`);
  if (tipoDocIdx) condiciones.push(`co_tip_doc = $${tipoDocIdx}`);

  return `
    anulacion AS (
      SELECT ${agrupador},
        count(*) AS emitidos,
        count(*) FILTER (WHERE es_doc_emi = '9') AS anulados
      FROM dashboard.emision
      ${condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : ''}
      GROUP BY ${agrupador}
    )
  `;
}

interface FilaKpi {
  coEmpleado?: string;
  nombreCompleto?: string | null;
  coDependencia: string;
  nombreDependencia: string | null;
  recibidos: string;
  recibidosExternos: string;
  atendidos: string;
  recibidosInformativos: string;
  atendidosInformativos: string;
  expedientesDistintos: string;
  gruposEmpleadoExpediente: string;
  gruposReprocesados: string;
  emitidos: string;
  anulados: string;
  tiempoPromedioHoras: number | null;
  tiempoMedianoHoras: number | null;
  tiempoPromedioHabilHoras: number | null;
  productividadPonderada: string;
  cargaPonderada: string;
}

/** `recibidos`/`atendidos` (y sus tiempos) — el bloque "acción" ya excluye los motivos
 *  informativos; ver `MOTIVOS_INFORMATIVOS` en `dashboardResumenService.ts`. */
function mapearFila(f: FilaKpi) {
  const recibidos = Number(f.recibidos);
  const recibidosExternos = Number(f.recibidosExternos);
  const atendidos = Number(f.atendidos);
  const recibidosInformativos = Number(f.recibidosInformativos);
  const atendidosInformativos = Number(f.atendidosInformativos);
  const expedientesDistintos = Number(f.expedientesDistintos);
  const gruposEmpleadoExpediente = Number(f.gruposEmpleadoExpediente);
  const gruposReprocesados = Number(f.gruposReprocesados);
  const emitidos = Number(f.emitidos);
  const anulados = Number(f.anulados);
  const movimientos = recibidos + recibidosInformativos;

  return {
    coDependencia: f.coDependencia,
    nombreDependencia: f.nombreDependencia,
    recibidos,
    recibidosExternos,
    recibidosMismaOficina: recibidos - recibidosExternos,
    atendidos,
    pendientes: recibidos - atendidos,
    tasaAtencion: recibidos > 0 ? redondear(atendidos / recibidos, 4)! : 0,
    tiempoPromedioHoras: redondear(f.tiempoPromedioHoras !== null ? f.tiempoPromedioHoras / 3600 : null),
    tiempoMedianoHoras: redondear(f.tiempoMedianoHoras !== null ? f.tiempoMedianoHoras / 3600 : null),
    tiempoPromedioHabilHoras: redondear(
      f.tiempoPromedioHabilHoras !== null ? f.tiempoPromedioHabilHoras / 3600 : null,
    ),
    recibidosInformativos,
    atendidosInformativos,
    pendientesInformativos: recibidosInformativos - atendidosInformativos,
    tasaAtencionInformativos:
      recibidosInformativos > 0 ? redondear(atendidosInformativos / recibidosInformativos, 4)! : 0,
    expedientesDistintos,
    movimientos,
    movimientosPromedioPorExpediente:
      expedientesDistintos > 0 ? redondear(movimientos / expedientesDistintos) : null,
    gruposEmpleadoExpediente,
    gruposReprocesados,
    tasaReproceso: gruposEmpleadoExpediente > 0 ? redondear(gruposReprocesados / gruposEmpleadoExpediente, 4) : null,
    emitidos,
    anulados,
    tasaAnulacion: emitidos > 0 ? redondear(anulados / emitidos, 4) : null,
    productividadPonderada: redondear(Number(f.productividadPonderada))!,
    cargaPonderada: redondear(Number(f.cargaPonderada))!,
  };
}

interface FilaTipoDependencia {
  coDependencia: string;
  esComite: boolean;
}

const TIPOS_DEPENDENCIA_TTL_MS = 15 * 60 * 1000;
let tiposDependenciaCache: { mapa: Map<string, boolean>; expira: number } | null = null;

/**
 * Fase 6 — `co_dependencia → esComite`, desde `RHTM_DEPENDENCIA.TI_DEPENDENCIA` ('1' = comité de
 * evaluación, '0' = oficina/unidad institucional; ver nota en `KpiOficina`). Solo 67 filas con PK
 * en `co_dependencia`: es una lectura liviana del SGD, igual que `tiposDocumento()` — no el patrón
 * que justificó el espejo local (el JOIN LATERAL contra ~42 000 remitos).
 *
 * Cacheada en memoria con TTL: `desempenoPorOficina`/`desempenoPorEmpleado` se piden en cada carga
 * del dashboard, y este dato casi no cambia — sin cache, cada carga sumaría un round-trip al SGD
 * remoto que no aporta nada nuevo la enorme mayoría de las veces.
 */
async function obtenerTiposDependencia(): Promise<Map<string, boolean>> {
  if (tiposDependenciaCache && tiposDependenciaCache.expira > Date.now()) {
    return tiposDependenciaCache.mapa;
  }

  const filas = await sequelize.query<FilaTipoDependencia>(
    `SELECT co_dependencia AS "coDependencia", (ti_dependencia = '1') AS "esComite"
       FROM ${S}.rhtm_dependencia`,
    { type: QueryTypes.SELECT },
  );

  const mapa = new Map(filas.map((f) => [f.coDependencia, f.esComite]));
  tiposDependenciaCache = { mapa, expira: Date.now() + TIPOS_DEPENDENCIA_TTL_MS };
  return mapa;
}

/** Solo para tests: `obtenerTiposDependencia` cachea en una variable de módulo, así que sin esto
 *  el resultado de una prueba se filtraría a la siguiente. */
export function reiniciarCacheTiposDependenciaParaTests(): void {
  tiposDependenciaCache = null;
}

/**
 * Productividad, oportunidad y calidad (Fase 1 + Fase 2) **por oficina** — contra el espejo local
 * (ver arriba). Se pide en cada carga del dashboard: alimenta las tarjetas de resumen, los
 * gráficos y la tabla por oficina, y además da la referencia contra la que se comparan los badges
 * de cada empleado.
 */
export async function desempenoPorOficina(filtro: FiltroResumen): Promise<KpiOficina[]> {
  const { whereSql, binds, desdeIdx, hastaIdx, tipoDocIdx } = construirFiltroParticipacion(filtro);

  const [filas, tipos] = await Promise.all([
    appSequelize.query<FilaKpi>(
    `WITH filtro AS (
      SELECT * FROM dashboard.participacion WHERE ${whereSql}
    ),
    con_visitas AS (
      SELECT *,
        count(*) OVER (PARTITION BY co_emp_des, nu_ann_exp, nu_sec_exp, asunto_norm) AS visitas_asunto
      FROM filtro
    ),
    ${construirCteAnulacion('co_dep_emi', desdeIdx, hastaIdx, tipoDocIdx)}
    SELECT
      p.co_dep_des AS "coDependencia",
      MAX(p.nombre_dependencia) AS "nombreDependencia",
      count(*) FILTER (WHERE NOT p.es_informativo)::text AS recibidos,
      count(*) FILTER (
        WHERE NOT p.es_informativo AND p.co_dep_emi IS DISTINCT FROM p.co_dep_des
      )::text AS "recibidosExternos",
      count(*) FILTER (WHERE NOT p.es_informativo AND p.atendido)::text AS atendidos,
      count(*) FILTER (WHERE p.es_informativo)::text AS "recibidosInformativos",
      count(*) FILTER (WHERE p.es_informativo AND p.atendido)::text AS "atendidosInformativos",
      AVG(p.segundos_corridos) FILTER (WHERE NOT p.es_informativo) AS "tiempoPromedioHoras",
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.segundos_corridos)
        FILTER (WHERE NOT p.es_informativo) AS "tiempoMedianoHoras",
      AVG(p.segundos_habiles) FILTER (WHERE NOT p.es_informativo) AS "tiempoPromedioHabilHoras",
      count(DISTINCT (p.nu_ann_exp, p.nu_sec_exp))::text AS "expedientesDistintos",
      count(DISTINCT (p.co_emp_des, p.nu_ann_exp, p.nu_sec_exp))::text AS "gruposEmpleadoExpediente",
      count(DISTINCT (p.co_emp_des, p.nu_ann_exp, p.nu_sec_exp))
        FILTER (WHERE p.visitas_asunto > 1 AND p.asunto_norm IS NOT NULL)::text AS "gruposReprocesados",
      COALESCE(MAX(anu.emitidos), 0)::text AS emitidos,
      COALESCE(MAX(anu.anulados), 0)::text AS anulados,
      COALESCE(SUM(COALESCE(peso.peso, 1)) FILTER (WHERE NOT p.es_informativo AND p.atendido), 0)::text AS "productividadPonderada",
      COALESCE(SUM(COALESCE(peso.peso, 1)) FILTER (WHERE NOT p.es_informativo), 0)::text AS "cargaPonderada"
    FROM con_visitas p
    LEFT JOIN anulacion anu ON anu.co_dep_emi = p.co_dep_des
    LEFT JOIN dashboard.tipo_documento_peso peso ON peso.co_tip_doc = p.co_tip_doc
    GROUP BY p.co_dep_des
    ORDER BY recibidos DESC`,
      { bind: binds, type: QueryTypes.SELECT },
    ),
    obtenerTiposDependencia(),
  ]);

  return filas.map((f) => ({ ...mapearFila(f), esComite: tipos.get(f.coDependencia) ?? false }));
}

/**
 * Productividad, oportunidad y calidad (Fase 1 + Fase 2) **por empleado** — contra el espejo
 * local. Solo se pide cuando se abre esa pestaña (carga perezosa, ver `DashboardPage.tsx`); ya no
 * hace falta separarla de `desempenoPorOficina` por costo — ambas son baratas contra el espejo —
 * pero se mantiene la separación porque el frontend ya depende de dos endpoints independientes.
 */
export async function desempenoPorEmpleado(filtro: FiltroResumen): Promise<KpiEmpleado[]> {
  const { whereSql, binds, desdeIdx, hastaIdx, tipoDocIdx } = construirFiltroParticipacion(filtro);

  const [filas, tipos] = await Promise.all([
    appSequelize.query<FilaKpi>(
      `WITH filtro AS (
      SELECT * FROM dashboard.participacion WHERE ${whereSql}
    ),
    con_visitas AS (
      SELECT *,
        count(*) OVER (PARTITION BY co_emp_des, nu_ann_exp, nu_sec_exp, asunto_norm) AS visitas_asunto
      FROM filtro
    ),
    ${construirCteAnulacion('co_emp_emi', desdeIdx, hastaIdx, tipoDocIdx)}
    SELECT
      p.co_emp_des AS "coEmpleado",
      MAX(p.nombre_empleado) AS "nombreCompleto",
      p.co_dep_des AS "coDependencia",
      MAX(p.nombre_dependencia) AS "nombreDependencia",
      count(*) FILTER (WHERE NOT p.es_informativo)::text AS recibidos,
      count(*) FILTER (
        WHERE NOT p.es_informativo AND p.co_dep_emi IS DISTINCT FROM p.co_dep_des
      )::text AS "recibidosExternos",
      count(*) FILTER (WHERE NOT p.es_informativo AND p.atendido)::text AS atendidos,
      count(*) FILTER (WHERE p.es_informativo)::text AS "recibidosInformativos",
      count(*) FILTER (WHERE p.es_informativo AND p.atendido)::text AS "atendidosInformativos",
      AVG(p.segundos_corridos) FILTER (WHERE NOT p.es_informativo) AS "tiempoPromedioHoras",
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.segundos_corridos)
        FILTER (WHERE NOT p.es_informativo) AS "tiempoMedianoHoras",
      AVG(p.segundos_habiles) FILTER (WHERE NOT p.es_informativo) AS "tiempoPromedioHabilHoras",
      count(DISTINCT (p.nu_ann_exp, p.nu_sec_exp))::text AS "expedientesDistintos",
      count(DISTINCT (p.co_emp_des, p.nu_ann_exp, p.nu_sec_exp))::text AS "gruposEmpleadoExpediente",
      count(DISTINCT (p.co_emp_des, p.nu_ann_exp, p.nu_sec_exp))
        FILTER (WHERE p.visitas_asunto > 1 AND p.asunto_norm IS NOT NULL)::text AS "gruposReprocesados",
      COALESCE(MAX(anu.emitidos), 0)::text AS emitidos,
      COALESCE(MAX(anu.anulados), 0)::text AS anulados,
      COALESCE(SUM(COALESCE(peso.peso, 1)) FILTER (WHERE NOT p.es_informativo AND p.atendido), 0)::text AS "productividadPonderada",
      COALESCE(SUM(COALESCE(peso.peso, 1)) FILTER (WHERE NOT p.es_informativo), 0)::text AS "cargaPonderada"
    FROM con_visitas p
    LEFT JOIN anulacion anu ON anu.co_emp_emi = p.co_emp_des
    LEFT JOIN dashboard.tipo_documento_peso peso ON peso.co_tip_doc = p.co_tip_doc
    GROUP BY p.co_emp_des, p.co_dep_des
    ORDER BY recibidos DESC`,
      { bind: binds, type: QueryTypes.SELECT },
    ),
    obtenerTiposDependencia(),
  ]);

  return filas.map((f) => ({
    coEmpleado: f.coEmpleado!,
    nombreCompleto: f.nombreCompleto ?? null,
    ...mapearFila(f),
    esComite: tipos.get(f.coDependencia) ?? false,
  }));
}

/** Catálogo de tipos de documento — se sigue leyendo en vivo del SGD (no del espejo): es
 *  referencia liviana, no participaciones, y nunca fue el cuello de botella medido en §5. */
export async function tiposDocumento(): Promise<TipoDocumento[]> {
  return sequelize.query<TipoDocumento>(
    `SELECT cdoc_tipdoc AS codigo, cdoc_desdoc AS descripcion
       FROM ${S}.si_mae_tipo_doc
      ORDER BY cdoc_desdoc`,
    { type: QueryTypes.SELECT },
  );
}

// ───────────────────────── Fase 2 — Carga laboral: pendientes antiguos ─────────────────────────

export interface FiltroPendientes {
  coDependencia?: string;
  tipoDocumento?: string;
}

export interface PendientesAntiguos {
  coDependencia: string;
  nombreDependencia: string | null;
  pendientes: number;
  pendientes0a7: number;
  pendientes8a30: number;
  pendientes31Mas: number;
  /** Antigüedad del más viejo, en días — `null` si no hay ninguno pendiente. */
  diasPendienteMasAntiguo: number | null;
}

/**
 * Qué cuenta como "pendiente" HOY — una sola definición, compartida por el agregado
 * (`pendientesAntiguosPorOficina`) y el detalle (`pendientesDetalleOficina`), para que nunca
 * puedan divergir en cuántos hay.
 *
 * Dos exclusiones se suman a `NOT atendido` (Fase 1/migración 014):
 *  - `NOT es_informativo`: un documento informativo (copia, para conocimiento y fines, circular)
 *    no espera respuesta por definición — el resto del dashboard ya lo separa con este mismo
 *    filtro (ver `construirFiltroParticipacion` más abajo); esta pestaña era la única que no.
 *  - `fe_archivo_expediente IS NULL OR fe_archivo_expediente < fe_envio`: si el expediente se
 *    archivó DESPUÉS de que este documento llegara, el trámite ya se cerró y nadie va a
 *    responderlo — contarlo como pendiente es lo que antes inflaba el backlog medido (2.847) a
 *    más del doble del real (1.076 tras esta y la exclusión de informativos).
 */
const CONDICIONES_BACKLOG = [
  'NOT atendido',
  'NOT es_informativo',
  '(fe_archivo_expediente IS NULL OR fe_archivo_expediente < fe_envio)',
];

/** Antigüedad en buckets, medida contra `now()` — compartida por agregado y detalle. */
const BUCKETS_PENDIENTES = {
  '0a7': "antiguedad < interval '8 days'",
  '8a30': "antiguedad >= interval '8 days' AND antiguedad < interval '31 days'",
  '31mas': "antiguedad >= interval '31 days'",
} as const;

export type BucketPendientes = keyof typeof BUCKETS_PENDIENTES | 'todos';

/** Tope de filas devueltas por el detalle — con las reglas nuevas la oficina más cargada ronda
 *  las 230, pero el tope evita que un dato anómalo tire el modal del frontend. */
const LIMITE_DETALLE_PENDIENTES = 500;

interface FilaPendientes {
  coDependencia: string;
  nombreDependencia: string | null;
  pendientes: string;
  pendientes0a7: string;
  pendientes8a30: string;
  pendientes31mas: string;
  diasPendienteMasAntiguo: string | null;
}

function mapearPendientes(f: FilaPendientes): PendientesAntiguos {
  return {
    coDependencia: f.coDependencia,
    nombreDependencia: f.nombreDependencia,
    pendientes: Number(f.pendientes),
    pendientes0a7: Number(f.pendientes0a7),
    pendientes8a30: Number(f.pendientes8a30),
    pendientes31Mas: Number(f.pendientes31mas),
    diasPendienteMasAntiguo: f.diasPendienteMasAntiguo !== null ? Number(f.diasPendienteMasAntiguo) : null,
  };
}

/**
 * Backlog vigente HOY, agrupado por oficina — a diferencia de `desempenoPorOficina` (recibidos
 * EN el rango elegido), esto ignora `desde`/`hasta` a propósito: mira TODO lo recibido, sin
 * límite de fecha, que sigue sin atenderse, bucketizado por antigüedad contra `now()`.
 *
 * "Pendiente" = `atendido` de `dashboard.participacion` MÁS las dos exclusiones de
 * `CONDICIONES_BACKLOG` (informativos y expedientes ya archivados) — ver el comentario ahí para
 * el detalle de por qué. El detalle por documento (`pendientesDetalleOficina`) usa exactamente
 * la misma condición y los mismos buckets, así que agregado y detalle nunca pueden divergir.
 */
export async function pendientesAntiguosPorOficina(filtro: FiltroPendientes): Promise<PendientesAntiguos[]> {
  const binds: unknown[] = [];
  const condiciones = [...CONDICIONES_BACKLOG];
  if (filtro.coDependencia) {
    binds.push(filtro.coDependencia);
    condiciones.push(`co_dep_des = $${binds.length}`);
  }
  if (filtro.tipoDocumento) {
    binds.push(filtro.tipoDocumento);
    condiciones.push(`co_tip_doc = $${binds.length}`);
  }

  const filas = await appSequelize.query<FilaPendientes>(
    `WITH pendientes AS (
      SELECT *, (now() - fe_envio) AS antiguedad
      FROM dashboard.participacion
      WHERE ${condiciones.join(' AND ')}
    )
    SELECT
      co_dep_des AS "coDependencia",
      MAX(nombre_dependencia) AS "nombreDependencia",
      count(*)::text AS pendientes,
      count(*) FILTER (WHERE ${BUCKETS_PENDIENTES['0a7']})::text AS pendientes0a7,
      count(*) FILTER (WHERE ${BUCKETS_PENDIENTES['8a30']})::text AS pendientes8a30,
      count(*) FILTER (WHERE ${BUCKETS_PENDIENTES['31mas']})::text AS pendientes31mas,
      round(EXTRACT(EPOCH FROM max(antiguedad)) / 86400)::text AS "diasPendienteMasAntiguo"
    FROM pendientes
    GROUP BY co_dep_des
    ORDER BY pendientes DESC`,
    { bind: binds, type: QueryTypes.SELECT },
  );

  return filas.map(mapearPendientes);
}

export interface PendienteDetalle {
  nuAnnExp: string;
  nuSecExp: string;
  numeroExpediente: string | null;
  nuAnn: string;
  nuEmi: string;
  nuDes: string;
  numeroDocumento: string | null;
  coTipDoc: string | null;
  asunto: string | null;
  coEmpleado: string;
  nombreEmpleado: string | null;
  esDocRec: string | null;
  fechaRecepcion: string;
  dias: number;
}

interface FilaPendienteDetalle {
  nuAnnExp: string;
  nuSecExp: string;
  numeroExpediente: string | null;
  nuAnn: string;
  nuEmi: string;
  nuDes: string;
  numeroDocumento: string | null;
  coTipDoc: string | null;
  asunto: string | null;
  coEmpleado: string;
  nombreEmpleado: string | null;
  esDocRec: string | null;
  fechaRecepcion: string;
  dias: string;
}

/**
 * Los documentos concretos detrás de un número de la pestaña Pendientes — mismo filtro de
 * backlog y mismos buckets que `pendientesAntiguosPorOficina` (`CONDICIONES_BACKLOG`,
 * `BUCKETS_PENDIENTES`), acotado además a una oficina y, opcionalmente, a un bucket de
 * antigüedad. Ordenado por antigüedad descendente: lo más viejo primero, que es lo que se busca
 * al abrir el detalle (y coincide con lo que muestra la columna "Más antiguo").
 */
export async function pendientesDetalleOficina(
  coDependencia: string,
  bucket: BucketPendientes,
  tipoDocumento?: string,
): Promise<{ total: number; items: PendienteDetalle[] }> {
  const binds: unknown[] = [coDependencia];
  const condiciones = [...CONDICIONES_BACKLOG, 'co_dep_des = $1'];
  if (tipoDocumento) {
    binds.push(tipoDocumento);
    condiciones.push(`co_tip_doc = $${binds.length}`);
  }

  /**
   * `antiguedad` es un alias calculado en el SELECT del CTE (`(now() - fe_envio) AS antiguedad`):
   * no existe todavía dentro del WHERE de ESE MISMO CTE, así que el bucket no puede sumarse a
   * `condiciones` de arriba (ahí adentro, Postgres lo rechaza con "column antiguedad does not
   * exist" — el bug real que reportó el usuario). Tiene que filtrar la consulta EXTERIOR, que
   * selecciona DESDE `pendientes`, donde `antiguedad` ya es una columna real de salida.
   */
  const condicionBucket = bucket === 'todos' ? 'true' : BUCKETS_PENDIENTES[bucket];
  const cte = `WITH pendientes AS (
      SELECT *, (now() - fe_envio) AS antiguedad
      FROM dashboard.participacion
      WHERE ${condiciones.join(' AND ')}
    )`;

  const filas = await appSequelize.query<FilaPendienteDetalle>(
    `${cte}
    SELECT
      nu_ann_exp AS "nuAnnExp",
      nu_sec_exp AS "nuSecExp",
      nu_expediente AS "numeroExpediente",
      nu_ann AS "nuAnn",
      nu_emi AS "nuEmi",
      nu_des AS "nuDes",
      nu_doc AS "numeroDocumento",
      co_tip_doc AS "coTipDoc",
      asunto,
      co_emp_des AS "coEmpleado",
      nombre_empleado AS "nombreEmpleado",
      es_doc_rec AS "esDocRec",
      to_char(fe_envio, 'YYYY-MM-DD HH24:MI:SS') AS "fechaRecepcion",
      round(EXTRACT(EPOCH FROM antiguedad) / 86400)::text AS dias
    FROM pendientes
    WHERE ${condicionBucket}
    ORDER BY antiguedad DESC
    LIMIT ${LIMITE_DETALLE_PENDIENTES}`,
    { bind: binds, type: QueryTypes.SELECT },
  );

  const totalFilas = await appSequelize.query<{ total: string }>(
    `${cte}
    SELECT count(*)::text AS total FROM pendientes WHERE ${condicionBucket}`,
    { bind: binds, type: QueryTypes.SELECT },
  );

  return {
    total: Number(totalFilas[0]?.total ?? 0),
    items: filas.map((f) => ({ ...f, dias: Number(f.dias) })),
  };
}
