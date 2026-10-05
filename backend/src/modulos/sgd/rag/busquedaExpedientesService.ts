import { QueryTypes } from 'sequelize';
import { appSequelize } from '../../../compartido/config/appDatabase';
import {
  combinarCandidatos as combinarComun,
  condicionContiene as contiene,
  etiquetaCoincidencia,
  prepararTerminos,
  RE_FECHA,
  terminosDelPlan,
  type CandidatoBusqueda,
  type FilaHit,
  type ParametrosBusqueda,
  type ResumenBusqueda,
} from '../../../compartido/rag/busquedaTerminos';
import type { PlanConsulta } from '../../../compartido/rag/planificadorService';
import { clave, estadoVivoExpedientes } from './enriquecimientoSgdService';
import type { FiltroAcceso } from './retrievalService';

/**
 * Búsqueda de EXPEDIENTES (no de fragmentos) para listar / contar en el chat
 * (docs/PLAN-CHAT-CONSULTAS.md, Fase 3). Reglas medidas contra la BD real:
 *
 * - Cada término se evalúa POR EXPEDIENTE y puede cumplirse en metadatos (`tsv_meta`: asunto,
 *   remitente, emisor, título) o en contenido (`rag.chunk.tsv`). Los asuntos casi nunca nombran la
 *   obra — "controversia" + "huancavelica" exigidos en el mismo documento dan 0; por expediente sí
 *   aparecen (6 con la obra en el asunto y el tema en el contenido, 58 con ambos en el contenido).
 * - Dos niveles por el ruido del contenido (×3 a ×36 según el término): nivel 1 = todos los términos
 *   están en metadatos; nivel 2 = alguno solo aparece dentro de los documentos.
 * - Ranking por rareza (IDF): una coincidencia del término que aparece en pocos expedientes pesa
 *   más que la del término frecuente. Sin esto, "controversia + Huancavelica" ponía arriba informes
 *   con la obra en el asunto y la cláusula estándar de "solución de controversias" en el contrato.
 * - Calibración (Fase 6): cada término se busca con sus sinónimos (`chat.sinonimos`: "alquiler" ↔
 *   "arrendamiento") y un fragmento con una frase de cláusula estándar (`chat.frases_estandar`:
 *   "solución de controversias") no cuenta como coincidencia del término que la frase contiene.
 * - Dentro del nivel 2, primero los expedientes con algún fragmento que contiene TODOS los términos
 *   juntos: "controversia" y "Junín" en el mismo párrafo es evidencia; en documentos distintos de un
 *   informe que repasa diez obras, no (medido: 33 de 96 en Junín los tienen juntos).
 * - Los filtros del plan (remitente, emisor, dependencia, tipo, fechas) se exigen a nivel de
 *   expediente: basta un documento que los cumpla.
 * - Permisos: el mismo `FiltroAcceso` del chat, siempre sobre `rag.documento`.
 *
 * La parte pura (términos, sinónimos, combinación, etiquetas) vive en
 * `compartido/rag/busquedaTerminos.ts` desde la Fase 7 (la usa también el STD); aquí queda el SQL
 * del SGD y se reexporta lo demás para no cambiar a quienes ya lo importaban.
 */

export {
  etiquetaCoincidencia,
  leerParametros,
  limpiarTermino,
  planConFiltros,
  prepararTerminos,
  terminosDeConsulta,
  terminosDelPlan,
  terminosExplicitos,
  type ModoTerminos,
  type ParametrosBusqueda,
  type TerminosPreparados,
} from '../../../compartido/rag/busquedaTerminos';

export type CandidatoExpediente = CandidatoBusqueda;

export interface ResultadoBusquedaExpedientes extends ResumenBusqueda {
  candidatos: CandidatoExpediente[];
}

interface FilaTermino { i: string; ann: string | null; sec: string | null; docs: number }

async function hitsMetadatos(consultas: string[], filtro: FiltroAcceso): Promise<FilaTermino[]> {
  return appSequelize.query<FilaTermino>(
    `SELECT t.i::text AS i, d.nu_ann_exp AS ann, d.nu_sec_exp AS sec, count(*)::int AS docs
       FROM unnest($1::text[]) WITH ORDINALITY AS t(termino, i)
      CROSS JOIN LATERAL rag.tsq_alternativas(t.termino) AS q
       JOIN rag.documento d ON d.tsv_meta @@ q
      WHERE d.vigente AND ($2::text IS NULL OR d.co_dep_emi = $2)
      GROUP BY 1, 2, 3`,
    { bind: [consultas, filtro.coDependencia], type: QueryTypes.SELECT },
  );
}

async function hitsContenido(consultas: string[], exclusiones: string[], filtro: FiltroAcceso): Promise<FilaTermino[]> {
  // Cuenta FRAGMENTOS, no documentos: un contrato con la cláusula estándar de "solución de
  // controversias" la menciona una vez por documento; un expediente que trata una controversia, en
  // muchos fragmentos. Con documentos, ambos empataban. Desde la Fase 6 los fragmentos con esa
  // cláusula ni siquiera cuentan para "controversia" (`z.x` = frases estándar del término).
  return appSequelize.query<FilaTermino>(
    `SELECT t.i::text AS i, d.nu_ann_exp AS ann, d.nu_sec_exp AS sec, count(*)::int AS docs
       FROM unnest($1::text[], $3::text[]) WITH ORDINALITY AS t(termino, excl, i)
      CROSS JOIN LATERAL (SELECT rag.tsq_alternativas(t.termino) AS q,
                                 rag.tsq_frases(NULLIF(t.excl, '')) AS x) z
       JOIN rag.chunk c ON c.tsv @@ z.q
       JOIN rag.documento d ON d.contenido_sha256 = c.sha256 AND d.vigente
      WHERE d.nu_ann_exp IS NOT NULL AND ($2::text IS NULL OR d.co_dep_emi = $2)
        AND NOT coalesce(c.tsv @@ z.x, false)
      GROUP BY 1, 2, 3`,
    { bind: [consultas, filtro.coDependencia, exclusiones], type: QueryTypes.SELECT },
  );
}

/** Fragmentos por expediente que contienen TODOS los términos (con 2 o más). Las frases estándar de
 *  cualquier término excluyen el fragmento, igual que en `hitsContenido`. */
async function hitsJuntos(consultas: string[], exclusiones: string[], filtro: FiltroAcceso): Promise<Map<string, number>> {
  const resultado = new Map<string, number>();
  if (consultas.length < 2) return resultado;
  const filas = await appSequelize.query<{ ann: string; sec: string; n: number }>(
    `WITH t AS (SELECT rag.tsq_alternativas(x) AS q FROM unnest($1::text[]) AS x),
          todos AS (SELECT string_agg('(' || q::text || ')', ' & ')::tsquery AS q, bool_and(q IS NOT NULL) AS ok FROM t)
     SELECT d.nu_ann_exp AS ann, d.nu_sec_exp AS sec, count(*)::int AS n
       FROM todos
      CROSS JOIN LATERAL (SELECT rag.tsq_frases(NULLIF($3, '')) AS x) z
       JOIN rag.chunk c ON c.tsv @@ todos.q
       JOIN rag.documento d ON d.contenido_sha256 = c.sha256 AND d.vigente
      WHERE todos.ok AND d.nu_ann_exp IS NOT NULL AND ($2::text IS NULL OR d.co_dep_emi = $2)
        AND NOT coalesce(c.tsv @@ z.x, false)
      GROUP BY 1, 2`,
    { bind: [consultas, filtro.coDependencia, exclusiones.filter(Boolean).join('|')], type: QueryTypes.SELECT },
  );
  for (const f of filas) resultado.set(clave(f.ann, f.sec), Number(f.n));
  return resultado;
}

/**
 * Expedientes que cumplen UN filtro del plan (algún documento lo cumple). `null` = filtro ausente.
 * Cada condición va en su propia consulta y se intersecan en JS: rara vez hay más de dos activos.
 */
async function expedientesConFiltro(condicionSql: string, binds: unknown[], filtro: FiltroAcceso): Promise<Set<string>> {
  const filas = await appSequelize.query<{ ann: string; sec: string }>(
    `SELECT DISTINCT d.nu_ann_exp AS ann, d.nu_sec_exp AS sec
       FROM rag.documento d
      WHERE d.vigente AND d.nu_ann_exp IS NOT NULL
        AND ($1::text IS NULL OR d.co_dep_emi = $1)
        AND (${condicionSql})`,
    { bind: [filtro.coDependencia, ...binds], type: QueryTypes.SELECT },
  );
  return new Set(filas.map((f) => clave(f.ann, f.sec)));
}

async function aplicarFiltros(plan: PlanConsulta, filtro: FiltroAcceso): Promise<{
  permitidos: Set<string> | null;
  remitentes: Set<string> | null;
}> {
  const f = plan.filtros;
  const conjuntos: Set<string>[] = [];
  let remitentes: Set<string> | null = null;

  if (f.remitente) {
    remitentes = await expedientesConFiltro(
      `${contiene('d.remitente_externo', 2)} OR d.remitente_doc = $2`, [f.remitente], filtro,
    );
    conjuntos.push(remitentes);
  }
  if (f.emisor) {
    conjuntos.push(await expedientesConFiltro(
      `${contiene('d.emisor_empleado', 2)} OR ${contiene('d.de_dep_emi', 2)}`, [f.emisor], filtro,
    ));
  }
  if (f.dependencia) {
    conjuntos.push(await expedientesConFiltro(
      `${contiene('d.de_dep_emi', 2)} OR d.co_dep_emi = $2`, [f.dependencia], filtro,
    ));
  }
  if (f.tipoDoc) {
    conjuntos.push(await expedientesConFiltro(contiene('d.tipo_doc', 2), [f.tipoDoc], filtro));
  }
  const desde = f.desde && RE_FECHA.test(f.desde) ? f.desde : null;
  const hasta = f.hasta && RE_FECHA.test(f.hasta) ? f.hasta : null;
  if (desde || hasta) {
    conjuntos.push(await expedientesConFiltro(
      `($2::date IS NULL OR d.fe_emi >= $2::date) AND ($3::date IS NULL OR d.fe_emi < $3::date + 1)`,
      [desde, hasta], filtro,
    ));
  }

  if (conjuntos.length === 0) return { permitidos: null, remitentes };
  const [primero, ...resto] = conjuntos;
  const permitidos = new Set([...primero].filter((k) => resto.every((c) => c.has(k))));
  return { permitidos, remitentes };
}

/** `combinarCandidatos` con las filas del SGD (año y secuencia sueltos). Se conserva con esta forma
 *  para que el SGD y sus pruebas no cambien; la lógica vive en `compartido/rag/busquedaTerminos`. */
export function combinarCandidatos(
  nTerminos: number,
  meta: FilaTermino[],
  contenido: FilaTermino[],
  ...resto: Parameters<typeof combinarComun> extends [unknown, unknown, unknown, ...infer R] ? R : never
): ReturnType<typeof combinarComun> {
  const aHit = (f: FilaTermino): FilaHit => ({ i: f.i, k: f.ann && f.sec ? clave(f.ann, f.sec) : null, docs: f.docs });
  return combinarComun(nTerminos, meta.map(aHit), contenido.map(aHit), ...resto);
}

export async function buscarExpedientesPorPlan(
  plan: PlanConsulta,
  filtro: FiltroAcceso,
  parametros: ParametrosBusqueda,
  opciones: { dentroDe?: { nuAnnExp: string; nuSecExp: string }[]; soloActuales?: boolean } = {},
): Promise<ResultadoBusquedaExpedientes> {
  const terminos = terminosDelPlan(plan);
  const preparados = prepararTerminos(terminos, plan, parametros);
  const hayFiltros = Boolean(plan.filtros.remitente || plan.filtros.emisor || plan.filtros.dependencia
    || plan.filtros.tipoDoc || plan.filtros.desde || plan.filtros.hasta);

  const vacio: ResultadoBusquedaExpedientes = {
    candidatos: [], total: 0, nivel1: 0, nivel2: 0, modoTerminos: 'todos', terminos,
    consultas: preparados.consultas, sinExpediente: 0, truncado: false,
  };
  if (terminos.length === 0 && !hayFiltros) return vacio;

  const [meta, contenido, juntos, filtros, universo] = await Promise.all([
    terminos.length > 0 ? hitsMetadatos(preparados.consultas, filtro) : Promise.resolve([]),
    terminos.length > 0 ? hitsContenido(preparados.consultas, preparados.exclusiones, filtro) : Promise.resolve([]),
    hitsJuntos(preparados.consultas, preparados.exclusiones, filtro),
    aplicarFiltros(plan, filtro),
    appSequelize.query<{ n: number }>('SELECT count(*)::int AS n FROM rag.expediente', { type: QueryTypes.SELECT }),
  ]);

  const dentroDe = opciones.dentroDe ? new Set(opciones.dentroDe.map((d) => clave(d.nuAnnExp, d.nuSecExp))) : null;
  const combinados = combinarCandidatos(
    terminos.length, meta, contenido, filtros.permitidos, filtros.remitentes, parametros, dentroDe,
    Number(universo[0]?.n ?? 0), juntos,
  );
  let candidatos = combinados.candidatos;

  // "Actualmente" (D5): movimiento en los últimos N meses, aunque esté archivado. Necesita el estado
  // en vivo de cada candidato, así que se acota al tope antes de consultar el SGD.
  if (opciones.soloActuales && candidatos.length > 0) {
    candidatos = candidatos.slice(0, parametros.maxCandidatos);
    const estados = await estadoVivoExpedientes(
      candidatos.map((c) => ({ nuAnnExp: c.a, nuSecExp: c.s })), parametros.mesesActual,
    );
    candidatos = candidatos.filter((c) => estados.get(clave(c.a, c.s))?.actual);
  }

  const nivel1 = candidatos.filter((c) => c.n === 1).length;
  return {
    candidatos: candidatos.slice(0, parametros.maxCandidatos),
    total: candidatos.length,
    nivel1,
    nivel2: candidatos.length - nivel1,
    modoTerminos: combinados.modo,
    terminos,
    consultas: preparados.consultas,
    sinExpediente: combinados.sinExpediente,
    truncado: candidatos.length > parametros.maxCandidatos,
  };
}

// ── Detalle de una página de resultados ─────────────────────────────────────────────────────────

export interface FilaExpedienteChat {
  nuAnnExp: string;
  nuSecExp: string;
  numeroExpediente: string | null;
  /** Asunto del documento con mejor coincidencia en metadatos; si no hay, el del primer documento. */
  asunto: string | null;
  /** Quién originó el expediente: remitente externo, o dependencia · empleado del primer documento. */
  origen: string | null;
  remitentes: string[];
  documentos: number;
  ultimoMovimiento: string | null;
  dependenciaActual: string | null;
  archivado: boolean;
  feArchivo: string | null;
  nivel: 1 | 2;
  coincidencia: string;
}


/** `consultas` = lo que se buscó por término (con alternativas); por defecto, las etiquetas. */
export async function detallePagina(
  candidatos: CandidatoExpediente[],
  terminos: string[],
  filtro: FiltroAcceso,
  mesesActual: number,
  consultas: string[] = terminos,
): Promise<FilaExpedienteChat[]> {
  if (candidatos.length === 0) return [];
  const pares = candidatos.map((c) => ({ nuAnnExp: c.a, nuSecExp: c.s }));

  const [filas, estados] = await Promise.all([
    appSequelize.query<{
      ann: string; sec: string; numero: string | null; asunto: string | null; origen: string | null;
      remitentes: string[] | null; documentos: number;
    }>(
      `WITH pares AS (SELECT unnest($1::text[]) AS ann, unnest($2::text[]) AS sec),
            q AS (
              SELECT NULLIF(string_agg(NULLIF(rag.tsq_alternativas(t)::text, ''), ' | '), '')::tsquery AS q
                FROM unnest($3::text[]) AS t
            )
       SELECT d.nu_ann_exp AS ann, d.nu_sec_exp AS sec, e.numero_sgd AS numero,
              (array_agg(d.asunto ORDER BY
                 CASE WHEN q.q IS NOT NULL AND d.tsv_meta @@ q.q THEN ts_rank(d.tsv_meta, q.q) ELSE -1 END DESC,
                 d.fe_emi ASC NULLS LAST) FILTER (WHERE d.asunto IS NOT NULL))[1] AS asunto,
              (array_agg(COALESCE(d.remitente_externo, NULLIF(concat_ws(' · ', d.de_dep_emi, d.emisor_empleado), ''))
                 ORDER BY d.fe_emi ASC NULLS LAST))[1] AS origen,
              array_remove(array_agg(DISTINCT d.remitente_externo), NULL) AS remitentes,
              count(*)::int AS documentos
         FROM rag.documento d
         JOIN pares p ON p.ann = d.nu_ann_exp AND p.sec = d.nu_sec_exp
         CROSS JOIN q
         LEFT JOIN rag.expediente e ON e.nu_ann_exp = d.nu_ann_exp AND e.nu_sec_exp = d.nu_sec_exp
        WHERE d.vigente AND ($4::text IS NULL OR d.co_dep_emi = $4)
        GROUP BY d.nu_ann_exp, d.nu_sec_exp, e.numero_sgd`,
      {
        bind: [pares.map((p) => p.nuAnnExp), pares.map((p) => p.nuSecExp), consultas, filtro.coDependencia],
        type: QueryTypes.SELECT,
      },
    ),
    estadoVivoExpedientes(pares, mesesActual).catch(() => new Map()),
  ]);

  const porClave = new Map(filas.map((f) => [clave(f.ann, f.sec), f]));
  return candidatos.map((c) => {
    const k = clave(c.a, c.s);
    const f = porClave.get(k);
    const e = estados.get(k);
    return {
      nuAnnExp: c.a,
      nuSecExp: c.s,
      numeroExpediente: f?.numero ?? null,
      asunto: f?.asunto?.replace(/\s+/g, ' ').trim() ?? null,
      origen: f?.origen ?? null,
      remitentes: (f?.remitentes ?? []).slice(0, 3),
      documentos: Number(f?.documentos ?? 0),
      ultimoMovimiento: e?.ultimoMovimiento ?? null,
      dependenciaActual: e?.dependenciaActual ?? null,
      archivado: e?.archivado ?? false,
      feArchivo: e?.feArchivo ?? null,
      nivel: c.n,
      coincidencia: etiquetaCoincidencia(c, terminos),
    };
  });
}
