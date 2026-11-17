import type { Sequelize } from 'sequelize';
import { appSequelize } from '../config/appDatabase';
import { leerConfig, leerNumero } from './configService';
import type { PlanConsulta } from './planificadorService';

/**
 * Parte PURA de la búsqueda por términos del chat (docs/PLAN-CHAT-CONSULTAS.md, Fases 3 y 6),
 * común al SGD (unidad = expediente) y al STD (unidad = documento, Fase 7): de la pregunta a los
 * términos, sus sinónimos y frases estándar, y la combinación de hits por término en candidatos
 * ordenados (dos niveles, IDF, "juntos"). Cada módulo pone su SQL (dónde están los metadatos, el
 * contenido y los filtros) y su enriquecimiento en vivo.
 */

export interface CandidatoBusqueda {
  /** Clave de la unidad: SGD → año y secuencia del expediente; STD → `a` = N° STD, `s` = ''. */
  a: string;
  s: string;
  /** 1 = coincidencia directa (metadatos), 2 = solo en contenido. */
  n: 1 | 2;
  /** Documentos con coincidencia en metadatos / FRAGMENTOS con coincidencia en contenido. */
  dm: number;
  dc: number;
  /** La unidad cumple el filtro de remitente. */
  r: boolean;
  /** Términos cumplidos (para el modo "alguno"). */
  t: number;
  /** Máscaras de bits: qué términos (por índice) coinciden en metadatos / en contenido. */
  bm: number;
  bc: number;
  /** Fragmentos que contienen todos los términos juntos (solo con 2+ términos; ausente = 0). */
  j?: number;
}

export type ModoTerminos = 'todos' | 'alguno' | 'sin_terminos';

/** Lo que una búsqueda devuelve, sin los candidatos (va en la frase y en la meta guardada). */
export interface ResumenBusqueda {
  total: number;
  nivel1: number;
  nivel2: number;
  modoTerminos: ModoTerminos;
  /** Etiquetas de los términos (lo que se muestra). */
  terminos: string[];
  /** Lo que se buscó por término, con sus alternativas ("alquiler|arrendamiento"). Ausente en
   *  listados guardados antes de la Fase 6: ahí equivale a `terminos`. */
  consultas?: string[];
  /** Documentos sin unidad que también coinciden en metadatos (no se listan). */
  sinExpediente: number;
  /** El total superó el tope y la lista guardada está truncada. */
  truncado: boolean;
}

/** Hit de un término (`i`, desde 1) en una unidad (`k` = "a|s"; null = sin unidad). */
export interface FilaHit { i: string; k: string | null; docs: number }

export const claveCandidato = (a: string, s: string) => `${a}|${s}`;
const clave = claveCandidato;

export const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Condición SQL "la columna contiene el texto del bind $n", sin tildes ni mayúsculas. */
export const condicionContiene = (columna: string, n: number) =>
  `unaccent(lower(coalesce(${columna}, ''))) LIKE '%' || unaccent(lower($${n})) || '%'`;

export interface ParametrosBusqueda {
  pesoAsunto: number;
  pesoContenido: number;
  topeDocsPorTermino: number;
  mesesActual: number;
  maxCandidatos: number;
  /** Término (sin tildes, minúsculas) → alternativas. */
  sinonimos: Record<string, string[]>;
  frasesEstandar: string[];
}

/** JSON de `app.config`; ante una clave ausente o un JSON inválido, el valor por defecto (una
 *  coma de más al editar desde la BD no debe tumbar el chat). */
async function leerJson<T>(clave: string, valido: (v: unknown) => v is T, porDefecto: T, db: Sequelize): Promise<T> {
  try {
    const crudo = await leerConfig(clave, db);
    if (!crudo) return porDefecto;
    const valor: unknown = JSON.parse(crudo);
    return valido(valor) ? valor : porDefecto;
  } catch {
    return porDefecto;
  }
}

const esListaTextos = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const esMapaSinonimos = (v: unknown): v is Record<string, string[]> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(esListaTextos);

/** `db`: la BD cuyo `app.config` se lee — `appSequelize` (SGD) o `stdRagSequelize` (STD). */
export async function leerParametros(db: Sequelize = appSequelize): Promise<ParametrosBusqueda> {
  const [pesoAsunto, pesoContenido, topeDocsPorTermino, mesesActual, maxCandidatos, sinonimos, frasesEstandar] =
    await Promise.all([
      leerNumero('chat.peso_asunto', 3, db),
      leerNumero('chat.peso_contenido', 1, db),
      leerNumero('chat.tope_docs_por_termino', 5, db),
      leerNumero('chat.meses_actual', 3, db),
      leerNumero('chat.max_candidatos', 1000, db),
      leerJson('chat.sinonimos', esMapaSinonimos, {}, db),
      leerJson('chat.frases_estandar', esListaTextos, [], db),
    ]);
  const sinonimosNormalizados: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(sinonimos)) sinonimosNormalizados[normal(k).trim()] = v;
  return {
    pesoAsunto, pesoContenido, topeDocsPorTermino, mesesActual, maxCandidatos,
    sinonimos: sinonimosNormalizados, frasesEstandar,
  };
}

const normal = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Palabras que nunca discriminan en este corpus (más los artículos y preposiciones). */
const PALABRAS_VACIAS = new Set([
  'dame', 'dale', 'dime', 'lista', 'listame', 'busca', 'buscar', 'muestra', 'muestrame', 'quiero', 'todos',
  'todas', 'cuales', 'cual', 'cuantos', 'cuantas', 'que', 'quien', 'quienes', 'donde', 'como', 'expediente',
  'expedientes', 'documento', 'documentos', 'relacionado', 'relacionados', 'relacionadas', 'sobre', 'obra',
  'obras', 'proyecto', 'proyectos', 'para', 'por', 'con', 'del', 'los', 'las', 'una', 'uno', 'unos', 'unas',
  'esta', 'estan', 'este', 'estos', 'hay', 'tiene', 'tienen', 'contengan', 'contenga', 'hablan', 'habla',
  'ultimo', 'ultima', 'ultimos', 'ultimas', 'actual', 'actualmente', 'base', 'datos', 'favor', 'mas',
  'reciente', 'recientes', 'presento', 'presentaron', 'presentado', 'presentados', 'envio', 'enviaron',
  'enviado', 'remitio', 'remitieron', 'remitido', 'participo', 'participaron', 'empresa', 'entidad',
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

const soloLetras = (w: string) => normal(w).replace(/[^a-z0-9ñ]/g, '');
const esGenerica = (w: string) => soloLetras(w).length < 2 || PALABRAS_VACIAS.has(soloLetras(w));

/**
 * Quita las palabras genéricas de los extremos de un término: "proyectos in house" → "in house",
 * "obra Junín" → "Junín". Las del medio se conservan ("alquiler de computadoras"). `null` si no queda
 * nada. El planificador las conserva a veces aunque el prompt se lo prohíbe, y cuestan caro: medido,
 * "proyectos" + "in house" sumaba 186 expedientes de nivel 2 y 4,5 s de búsqueda.
 */
export function limpiarTermino(termino: string): string | null {
  const palabras = termino.trim().split(/\s+/).filter(Boolean);
  let inicio = 0;
  let fin = palabras.length;
  while (inicio < fin && esGenerica(palabras[inicio])) inicio++;
  while (fin > inicio && esGenerica(palabras[fin - 1])) fin--;
  return inicio < fin ? palabras.slice(inicio, fin).join(' ') : null;
}

/**
 * Términos que el planificador dio de verdad (obligatorios u opcionales, sin genéricos), SIN el
 * respaldo de las palabras de la consulta. Con un listado anterior en curso, "¿y el último?" sin
 * términos propios significa "el último DE ESOS": las palabras sueltas de la consulta reescrita
 * ("consulta", "contrato") lo acotaban a 10 de 962 documentos (medido en la Fase 7).
 */
export function terminosExplicitos(plan: PlanConsulta): string[] {
  const obligatorios = limpiarLista(plan.terminos.obligatorios);
  return obligatorios.length > 0 ? obligatorios : limpiarLista(plan.terminos.opcionales);
}

const RE_NUMERO_CONTRATO = /\d{1,4}\s*-\s*\d{4}\s*-\s*[a-z]+/i;
const ES_PALABRA_CONTRATO = /^contratos?$/i;

/**
 * Sin genéricos y, si hay un número de contrato ("227-2022-MCEBS"), sin la palabra "contrato": el
 * planificador la incluye unas veces sí y otras no, y exigirla además del número cambiaba el
 * resultado de 962 a 125 documentos para la misma pregunta (medido en la Fase 7).
 */
function limpiarLista(lista: string[]): string[] {
  const limpios = lista.map(limpiarTermino).filter((t): t is string => t !== null);
  return limpios.some((t) => RE_NUMERO_CONTRATO.test(t))
    ? limpios.filter((t) => !ES_PALABRA_CONTRATO.test(normal(t).trim()))
    : limpios;
}

/** El plan acota por algún filtro (remitente, emisor, dependencia, tipo o fechas). */
export function planConFiltros(plan: PlanConsulta): boolean {
  const f = plan.filtros;
  return Boolean(f.remitente || f.emisor || f.dependencia || f.tipoDoc || f.desde || f.hasta);
}

/**
 * Términos únicos (sin distinguir mayúsculas/tildes) y sin palabras genéricas: los obligatorios; si
 * no queda ninguno, los opcionales; si tampoco, las palabras de la consulta.
 */
export function terminosDelPlan(plan: PlanConsulta): string[] {
  const obligatorios = limpiarLista(plan.terminos.obligatorios);
  const opcionales = limpiarLista(plan.terminos.opcionales);
  const fuente = obligatorios.length > 0
    ? obligatorios
    : opcionales.length > 0 ? opcionales : terminosDeConsulta(plan.consulta);
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

export interface TerminosPreparados {
  /** Cómo se muestran: "alquiler". */
  etiquetas: string[];
  /** Qué se busca, para `rag.tsq_alternativas`: "alquiler|arrendamiento". */
  consultas: string[];
  /** Frases estándar que no cuentan como coincidencia de ese término, separadas por "|" ('' = ninguna). */
  exclusiones: string[];
}

const MAX_ALTERNATIVAS = 4;

/** Raíz aproximada de una palabra para saber si una frase estándar la contiene: "controversia" →
 *  "controvers" (cubre "controversias"). */
const raiz = (palabra: string) => palabra.slice(0, Math.max(4, palabra.length - 2));

/**
 * Alternativas (el término + sinónimos de `chat.sinonimos` + los que propuso el planificador) y
 * frases estándar de cada término. Pura: se prueba sin BD.
 */
export function prepararTerminos(
  terminos: string[],
  plan: PlanConsulta | null,
  p: Pick<ParametrosBusqueda, 'sinonimos' | 'frasesEstandar'>,
): TerminosPreparados {
  const delPlan = new Map<string, string[]>();
  for (const [k, v] of Object.entries(plan?.terminos.sinonimos ?? {})) delPlan.set(normal(k).trim(), v);
  const sinBarra = (t: string) => t.replace(/\|/g, ' ').trim();

  const consultas: string[] = [];
  const exclusiones: string[] = [];
  for (const t of terminos) {
    const n = normal(t).trim();
    const vistas = new Set<string>();
    const alternativas: string[] = [];
    for (const a of [t, ...(p.sinonimos[n] ?? []), ...(delPlan.get(n) ?? [])].map(sinBarra)) {
      const na = normal(a);
      if (na.length >= 2 && !vistas.has(na) && alternativas.length < MAX_ALTERNATIVAS) {
        vistas.add(na);
        alternativas.push(a);
      }
    }
    consultas.push(alternativas.join('|'));

    // Solo alternativas de una palabra: una frase estándar rara vez contiene un término compuesto.
    const raices = [...vistas].filter((a) => !a.includes(' ')).map(raiz);
    exclusiones.push(p.frasesEstandar
      .filter((f) => raices.some((r) => normal(f).includes(r)))
      .map(sinBarra)
      .join('|'));
  }
  return { etiquetas: terminos, consultas, exclusiones };
}

/**
 * Combina los hits por término en candidatos ordenados. Pura: se prueba sin BD. Cada fila trae la
 * clave de su unidad (`a|s`); `k = null` = documento sin unidad (en el SGD, sin expediente).
 * `permitidos` = intersección de filtros (null = sin filtros); `remitentes` marca la columna `r`.
 */
export function combinarCandidatos(
  nTerminos: number,
  meta: FilaHit[],
  contenido: FilaHit[],
  permitidos: Set<string> | null,
  remitentes: Set<string> | null,
  p: Pick<ParametrosBusqueda, 'pesoAsunto' | 'pesoContenido' | 'topeDocsPorTermino'>,
  dentroDe: Set<string> | null,
  totalUnidades = 0,
  juntos: Map<string, number> = new Map(),
): { candidatos: CandidatoBusqueda[]; modo: ModoTerminos; sinExpediente: number } {
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
    if (!f.k) {
      sinExpediente = Math.max(sinExpediente, f.docs);
      continue;
    }
    acum(f.k).meta[Number(f.i) - 1] += f.docs;
  }
  for (const f of contenido) {
    if (!f.k) continue;
    acum(f.k).cont[Number(f.i) - 1] += f.docs;
  }

  const tope = (n: number) => Math.min(n, p.topeDocsPorTermino);
  // Amortiguación logarítmica: 40 fragmentos pesan más que 2, pero no 20 veces más.
  const amortiguar = (n: number) => Math.log1p(n);

  // IDF por término sobre las unidades donde aparece (en metadatos o contenido).
  const df = Array(nTerminos).fill(0);
  for (const v of porClave.values()) {
    for (let i = 0; i < nTerminos; i++) if (v.meta[i] > 0 || v.cont[i] > 0) df[i]++;
  }
  const universo = Math.max(totalUnidades, porClave.size, 1);
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
      const candidato: CandidatoBusqueda = {
        a, s,
        n: (enMeta === nTerminos ? 1 : 2) as 1 | 2,
        dm: v.meta.reduce((x, y) => x + tope(y), 0),
        dc: v.cont.reduce((x, y) => x + y, 0),
        r: remitentes?.has(k) ?? false,
        t: cumplidos,
        bm,
        bc,
      };
      const j = juntos.get(k) ?? 0;
      if (j > 0) candidato.j = j;
      return candidato;
    });

  const puntaje = (c: CandidatoBusqueda) => puntajes.get(clave(c.a, c.s)) ?? 0;
  // En el nivel 2, los que tienen los términos juntos en un fragmento van antes (sin importar el puntaje).
  const sinJuntos = (c: CandidatoBusqueda) => (c.n === 2 && !c.j ? 1 : 0);
  const orden = (x: CandidatoBusqueda, y: CandidatoBusqueda) =>
    x.n - y.n || sinJuntos(x) - sinJuntos(y) || puntaje(y) - puntaje(x) || (y.a + y.s).localeCompare(x.a + x.s);

  const todos = evaluados.filter((c) => c.t === nTerminos).sort(orden);
  if (todos.length > 0 || nTerminos === 1) return { candidatos: todos, modo: 'todos', sinExpediente };

  // Ninguno cumple todos los términos: se ofrecen los que cumplen alguno, primero los que más.
  const alguno = evaluados.filter((c) => c.t > 0).sort((x, y) => y.t - x.t || orden(x, y));
  return { candidatos: alguno, modo: 'alguno', sinExpediente };
}

/**
 * Qué término coincidió dónde: "remitente · asunto: Huancavelica · contenido: controversia". Un
 * término que está en el asunto no se repite en "contenido" (lo que importa es la señal más fuerte).
 */
export function etiquetaCoincidencia(c: CandidatoBusqueda, terminos: string[]): string {
  const enMeta = terminos.filter((_, i) => c.bm & (1 << i));
  const soloContenido = terminos.filter((_, i) => (c.bc & (1 << i)) && !(c.bm & (1 << i)));
  const partes: string[] = [];
  if (c.r) partes.push('remitente');
  if (enMeta.length > 0) partes.push(`asunto: ${enMeta.join(', ')}`);
  if (soloContenido.length > 0) partes.push(`contenido: ${soloContenido.join(', ')}`);
  if (c.j) partes.push(`juntos en ${c.j} ${c.j === 1 ? 'fragmento' : 'fragmentos'}`);
  return partes.join(' · ') || 'filtros';
}
