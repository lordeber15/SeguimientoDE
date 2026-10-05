import { QueryTypes } from 'sequelize';
import { appSequelize } from '../../../compartido/config/appDatabase';
import { leerNumero } from '../../../compartido/rag/configService';
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
 * - Los filtros del plan (remitente, emisor, dependencia, tipo, fechas) se exigen a nivel de
 *   expediente: basta un documento que los cumpla.
 * - Permisos: el mismo `FiltroAcceso` del chat, siempre sobre `rag.documento`.
 */

export interface CandidatoExpediente {
  a: string;
  s: string;
  /** 1 = coincidencia directa (metadatos), 2 = solo en contenido. */
  n: 1 | 2;
  /** Documentos con coincidencia en metadatos / FRAGMENTOS con coincidencia en contenido. */
  dm: number;
  dc: number;
  /** El expediente cumple el filtro de remitente. */
  r: boolean;
  /** Términos cumplidos (para el modo "alguno"). */
  t: number;
  /** Máscaras de bits: qué términos (por índice) coinciden en metadatos / en contenido. */
  bm: number;
  bc: number;
}

export type ModoTerminos = 'todos' | 'alguno' | 'sin_terminos';

export interface ResultadoBusquedaExpedientes {
  candidatos: CandidatoExpediente[];
  total: number;
  nivel1: number;
  nivel2: number;
  modoTerminos: ModoTerminos;
  terminos: string[];
  /** Documentos sin expediente que también coinciden en metadatos (no se listan). */
  sinExpediente: number;
  /** El total superó el tope y la lista guardada está truncada. */
  truncado: boolean;
}

export interface ParametrosBusqueda {
  pesoAsunto: number;
  pesoContenido: number;
  topeDocsPorTermino: number;
  mesesActual: number;
  maxCandidatos: number;
}

export async function leerParametros(): Promise<ParametrosBusqueda> {
  const [pesoAsunto, pesoContenido, topeDocsPorTermino, mesesActual, maxCandidatos] = await Promise.all([
    leerNumero('chat.peso_asunto', 3),
    leerNumero('chat.peso_contenido', 1),
    leerNumero('chat.tope_docs_por_termino', 5),
    leerNumero('chat.meses_actual', 3),
    leerNumero('chat.max_candidatos', 1000),
  ]);
  return { pesoAsunto, pesoContenido, topeDocsPorTermino, mesesActual, maxCandidatos };
}

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

const normal = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Palabras que nunca discriminan en este corpus (más los artículos y preposiciones). */
const PALABRAS_VACIAS = new Set([
  'dame', 'dale', 'dime', 'lista', 'listame', 'busca', 'buscar', 'muestra', 'muestrame', 'quiero', 'todos',
  'todas', 'cuales', 'cual', 'cuantos', 'cuantas', 'que', 'quien', 'quienes', 'donde', 'como', 'expediente',
  'expedientes', 'documento', 'documentos', 'relacionado', 'relacionados', 'relacionadas', 'sobre', 'obra',
  'obras', 'proyecto', 'proyectos', 'para', 'por', 'con', 'del', 'los', 'las', 'una', 'uno', 'unos', 'unas',
  'esta', 'estan', 'este', 'estos', 'hay', 'tiene', 'tienen', 'contengan', 'contenga', 'hablan', 'habla',
  'ultimo', 'ultima', 'actual', 'actualmente', 'base', 'datos', 'favor',
]);

/**
 * Respaldo cuando el planificador no devolvió términos (su salida no es determinista): las palabras
 * con contenido de la consulta. Peor que los términos del modelo (no junta "in house"), mejor que
 * responder "no encontré" a una pregunta que sí tiene respuesta.
 */
export function terminosDeConsulta(consulta: string): string[] {
  return normal(consulta)
    .replace(/[^a-z0-9ñ\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !PALABRAS_VACIAS.has(w));
}

/**
 * Términos únicos (sin distinguir mayúsculas/tildes): los obligatorios; si no hay, los opcionales;
 * si tampoco, las palabras de la consulta.
 */
export function terminosDelPlan(plan: PlanConsulta): string[] {
  const fuente = plan.terminos.obligatorios.length > 0
    ? plan.terminos.obligatorios
    : plan.terminos.opcionales.length > 0 ? plan.terminos.opcionales : terminosDeConsulta(plan.consulta);
  const vistos = new Set<string>();
  const unicos: string[] = [];
  for (const t of fuente) {
    const n = normal(t);
    if (n.length >= 2 && !vistos.has(n)) {
      vistos.add(n);
      unicos.push(t);
    }
  }
  return unicos.slice(0, 6);
}

interface FilaTermino { i: string; ann: string | null; sec: string | null; docs: number }

async function hitsMetadatos(terminos: string[], filtro: FiltroAcceso): Promise<FilaTermino[]> {
  return appSequelize.query<FilaTermino>(
    `SELECT t.i::text AS i, d.nu_ann_exp AS ann, d.nu_sec_exp AS sec, count(*)::int AS docs
       FROM unnest($1::text[]) WITH ORDINALITY AS t(termino, i)
      CROSS JOIN LATERAL phraseto_tsquery('es_unaccent', t.termino) AS q
       JOIN rag.documento d ON d.tsv_meta @@ q
      WHERE d.vigente AND ($2::text IS NULL OR d.co_dep_emi = $2)
      GROUP BY 1, 2, 3`,
    { bind: [terminos, filtro.coDependencia], type: QueryTypes.SELECT },
  );
}

async function hitsContenido(terminos: string[], filtro: FiltroAcceso): Promise<FilaTermino[]> {
  // Cuenta FRAGMENTOS, no documentos: un contrato con la cláusula estándar de "solución de
  // controversias" la menciona una vez por documento; un expediente que trata una controversia, en
  // muchos fragmentos. Con documentos, ambos empataban.
  return appSequelize.query<FilaTermino>(
    `SELECT t.i::text AS i, d.nu_ann_exp AS ann, d.nu_sec_exp AS sec, count(*)::int AS docs
       FROM unnest($1::text[]) WITH ORDINALITY AS t(termino, i)
      CROSS JOIN LATERAL phraseto_tsquery('es_unaccent', t.termino) AS q
       JOIN rag.chunk c ON c.tsv @@ q
       JOIN rag.documento d ON d.contenido_sha256 = c.sha256 AND d.vigente
      WHERE d.nu_ann_exp IS NOT NULL AND ($2::text IS NULL OR d.co_dep_emi = $2)
      GROUP BY 1, 2, 3`,
    { bind: [terminos, filtro.coDependencia], type: QueryTypes.SELECT },
  );
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

const contiene = (columna: string, n: number) =>
  `unaccent(lower(coalesce(${columna}, ''))) LIKE '%' || unaccent(lower($${n})) || '%'`;

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

/**
 * Combina los hits por término en candidatos ordenados. Pura: se prueba sin BD.
 * `permitidos` = intersección de filtros (null = sin filtros); `remitentes` marca la columna `r`.
 */
export function combinarCandidatos(
  nTerminos: number,
  meta: FilaTermino[],
  contenido: FilaTermino[],
  permitidos: Set<string> | null,
  remitentes: Set<string> | null,
  p: Pick<ParametrosBusqueda, 'pesoAsunto' | 'pesoContenido' | 'topeDocsPorTermino'>,
  dentroDe: Set<string> | null,
  totalExpedientes = 0,
): { candidatos: CandidatoExpediente[]; modo: ModoTerminos; sinExpediente: number } {
  // Sin términos: los candidatos son exactamente los que cumplen los filtros.
  if (nTerminos === 0) {
    const base = [...(permitidos ?? [])].filter((k) => !dentroDe || dentroDe.has(k));
    const candidatos = base.map((k) => {
      const [a, s] = k.split('|');
      return { a, s, n: 1 as const, dm: 0, dc: 0, r: remitentes?.has(k) ?? false, t: 0, bm: 0, bc: 0 };
    });
    candidatos.sort((x, y) => (y.a + y.s).localeCompare(x.a + x.s));
    return { candidatos, modo: 'sin_terminos', sinExpediente: 0 };
  }

  interface Acum { meta: number[]; cont: number[] }
  const porClave = new Map<string, Acum>();
  const acum = (k: string) => {
    let v = porClave.get(k);
    if (!v) {
      v = { meta: Array(nTerminos).fill(0), cont: Array(nTerminos).fill(0) };
      porClave.set(k, v);
    }
    return v;
  };

  let sinExpediente = 0;
  for (const f of meta) {
    if (!f.ann || !f.sec) {
      sinExpediente = Math.max(sinExpediente, f.docs);
      continue;
    }
    acum(clave(f.ann, f.sec)).meta[Number(f.i) - 1] += f.docs;
  }
  for (const f of contenido) {
    if (!f.ann || !f.sec) continue;
    acum(clave(f.ann, f.sec)).cont[Number(f.i) - 1] += f.docs;
  }

  const tope = (n: number) => Math.min(n, p.topeDocsPorTermino);
  // Amortiguación logarítmica: 40 fragmentos pesan más que 2, pero no 20 veces más.
  const amortiguar = (n: number) => Math.log1p(n);

  // IDF por término sobre los expedientes donde aparece (en metadatos o contenido).
  const df = Array(nTerminos).fill(0);
  for (const v of porClave.values()) {
    for (let i = 0; i < nTerminos; i++) if (v.meta[i] > 0 || v.cont[i] > 0) df[i]++;
  }
  const universo = Math.max(totalExpedientes, porClave.size, 1);
  const idf = df.map((d) => Math.log(1 + universo / Math.max(d, 1)));
  const puntajes = new Map<string, number>();

  const evaluados = [...porClave.entries()]
    .filter(([k]) => (!permitidos || permitidos.has(k)) && (!dentroDe || dentroDe.has(k)))
    .map(([k, v]) => {
      const [a, s] = k.split('|');
      let enMeta = 0;
      let cumplidos = 0;
      let bm = 0;
      let bc = 0;
      let puntaje = 0;
      for (let i = 0; i < nTerminos; i++) {
        if (v.meta[i] > 0) { enMeta++; bm |= 1 << i; }
        if (v.cont[i] > 0) bc |= 1 << i;
        if (v.meta[i] > 0 || v.cont[i] > 0) cumplidos++;
        puntaje += idf[i] * (p.pesoAsunto * amortiguar(v.meta[i]) + p.pesoContenido * amortiguar(v.cont[i]));
      }
      puntajes.set(k, puntaje);
      return {
        a, s,
        n: (enMeta === nTerminos ? 1 : 2) as 1 | 2,
        dm: v.meta.reduce((x, y) => x + tope(y), 0),
        dc: v.cont.reduce((x, y) => x + y, 0),
        r: remitentes?.has(k) ?? false,
        t: cumplidos,
        bm,
        bc,
      };
    });

  const puntaje = (c: CandidatoExpediente) => puntajes.get(clave(c.a, c.s)) ?? 0;
  const orden = (x: CandidatoExpediente, y: CandidatoExpediente) =>
    x.n - y.n || puntaje(y) - puntaje(x) || (y.a + y.s).localeCompare(x.a + x.s);

  const todos = evaluados.filter((c) => c.t === nTerminos).sort(orden);
  if (todos.length > 0 || nTerminos === 1) return { candidatos: todos, modo: 'todos', sinExpediente };

  // Ninguno cumple todos los términos: se ofrecen los que cumplen alguno, primero los que más.
  const alguno = evaluados.filter((c) => c.t > 0).sort((x, y) => y.t - x.t || orden(x, y));
  return { candidatos: alguno, modo: 'alguno', sinExpediente };
}

export async function buscarExpedientesPorPlan(
  plan: PlanConsulta,
  filtro: FiltroAcceso,
  parametros: ParametrosBusqueda,
  opciones: { dentroDe?: { nuAnnExp: string; nuSecExp: string }[]; soloActuales?: boolean } = {},
): Promise<ResultadoBusquedaExpedientes> {
  const terminos = terminosDelPlan(plan);
  const hayFiltros = Boolean(plan.filtros.remitente || plan.filtros.emisor || plan.filtros.dependencia
    || plan.filtros.tipoDoc || plan.filtros.desde || plan.filtros.hasta);

  const vacio: ResultadoBusquedaExpedientes = {
    candidatos: [], total: 0, nivel1: 0, nivel2: 0, modoTerminos: 'todos', terminos,
    sinExpediente: 0, truncado: false,
  };
  if (terminos.length === 0 && !hayFiltros) return vacio;

  const [meta, contenido, filtros, universo] = await Promise.all([
    terminos.length > 0 ? hitsMetadatos(terminos, filtro) : Promise.resolve([]),
    terminos.length > 0 ? hitsContenido(terminos, filtro) : Promise.resolve([]),
    aplicarFiltros(plan, filtro),
    appSequelize.query<{ n: number }>('SELECT count(*)::int AS n FROM rag.expediente', { type: QueryTypes.SELECT }),
  ]);

  const dentroDe = opciones.dentroDe ? new Set(opciones.dentroDe.map((d) => clave(d.nuAnnExp, d.nuSecExp))) : null;
  const combinados = combinarCandidatos(
    terminos.length, meta, contenido, filtros.permitidos, filtros.remitentes, parametros, dentroDe,
    Number(universo[0]?.n ?? 0),
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

/**
 * Qué término coincidió dónde: "remitente · asunto: Huancavelica · contenido: controversia". Un
 * término que está en el asunto no se repite en "contenido" (lo que importa es la señal más fuerte).
 */
export function etiquetaCoincidencia(c: CandidatoExpediente, terminos: string[]): string {
  const enMeta = terminos.filter((_, i) => c.bm & (1 << i));
  const soloContenido = terminos.filter((_, i) => (c.bc & (1 << i)) && !(c.bm & (1 << i)));
  const partes: string[] = [];
  if (c.r) partes.push('remitente');
  if (enMeta.length > 0) partes.push(`asunto: ${enMeta.join(', ')}`);
  if (soloContenido.length > 0) partes.push(`contenido: ${soloContenido.join(', ')}`);
  return partes.join(' · ') || 'filtros';
}

export async function detallePagina(
  candidatos: CandidatoExpediente[],
  terminos: string[],
  filtro: FiltroAcceso,
  mesesActual: number,
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
              SELECT NULLIF(string_agg(NULLIF(phraseto_tsquery('es_unaccent', t)::text, ''), ' | '), '')::tsquery AS q
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
        bind: [pares.map((p) => p.nuAnnExp), pares.map((p) => p.nuSecExp), terminos, filtro.coDependencia],
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
