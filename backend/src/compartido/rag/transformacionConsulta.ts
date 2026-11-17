import type { Sequelize } from 'sequelize';
import type { ChatProvider, ResultadoChat } from '../ai/types';
import { appSequelize } from '../config/appDatabase';
import { leerBooleano } from './configService';
import type { PlanConsulta } from './planificadorService';
import { RE_FECHA } from './busquedaTerminos';
import { paso } from '../observabilidad/traza';

/**
 * Transformaciones de la consulta ANTES del retrieval (docs/PLAN-RAG-AVANZADO.md, Fase 4), comunes al
 * SGD y al STD:
 *
 * - Vocabulario de dominio: la consulta que se embebe se completa con las formas oficiales de la jerga
 *   que trae (`chat.sinonimos`: "alquiler" → "arrendamiento"). Hasta ahora el diccionario solo llegaba a
 *   la rama FTS y a los listados; la vectorial embebía la palabra del usuario tal cual.
 * - HyDE: un párrafo hipotético con el estilo de los documentos, embebido como TERCERA lista del RRF
 *   (no reemplaza a la consulta: si el modelo inventa en otra dirección, solo suma una lista débil).
 * - Fusión de varias búsquedas (decomposition): RRF sobre las listas ya ordenadas de cada subconsulta.
 */

/** Transformaciones que recibe la búsqueda híbrida (`buscarHibrido` del SGD / `buscarHibridoStd`). */
export interface OpcionesBusqueda {
  /** Texto que se EMBEBE si difiere de la consulta (expandida con el vocabulario de dominio). La FTS
   *  sigue con la consulta original: más palabras ahí harían más estricto `plainto_tsquery`. */
  consultaVectorial?: string;
  /** Párrafo hipotético (HyDE): se embebe y entra al RRF como tercera lista. */
  textoHyde?: string | null;
  /** Filtros del plan sobre los metadatos del documento (tipo, fechas, quién). Si con ellos no queda
   *  ningún fragmento, la búsqueda se repite sin ellos: un filtro mal extraído no deja sin respuesta. */
  filtrosDoc?: FiltrosDocumento | null;
}

/**
 * Filtros del planificador que también acotan la búsqueda de CONTENIDO (antes solo los usaban los
 * listados): "¿qué dice el informe de marzo sobre la penalidad?" debe buscar en informes de marzo.
 * Cada módulo los traduce a sus columnas (`retrievalService` / `retrievalStdService`).
 */
export interface FiltrosDocumento {
  remitente: string | null;
  emisor: string | null;
  dependencia: string | null;
  tipoDoc: string | null;
  /** AAAA-MM-DD, ya validadas. */
  desde: string | null;
  hasta: string | null;
}

/** Filtros del plan aplicables al contenido, o `null` si no trae ninguno (o no hay plan confiable). */
export function filtrosDocumentoDelPlan(plan: PlanConsulta | null): FiltrosDocumento | null {
  if (!plan) return null;
  const f = plan.filtros;
  const filtros: FiltrosDocumento = {
    remitente: f.remitente,
    emisor: f.emisor,
    dependencia: f.dependencia,
    tipoDoc: f.tipoDoc,
    desde: f.desde && RE_FECHA.test(f.desde) ? f.desde : null,
    hasta: f.hasta && RE_FECHA.test(f.hasta) ? f.hasta : null,
  };
  return Object.values(filtros).some(Boolean) ? filtros : null;
}

/**
 * Condiciones SQL de `filtros` a partir del bind `$inicio`, con las columnas de cada módulo. Devuelve
 * el fragmento (`AND …`, vacío si no hay filtros) y los valores a añadir AL FINAL del bind.
 */
export function sqlFiltrosDocumento(
  filtros: FiltrosDocumento | null | undefined,
  inicio: number,
  condiciones: { [K in keyof FiltrosDocumento]: (n: number) => string },
): { sql: string; binds: unknown[] } {
  if (!filtros) return { sql: '', binds: [] };
  const partes: string[] = [];
  const binds: unknown[] = [];
  for (const clave of Object.keys(condiciones) as (keyof FiltrosDocumento)[]) {
    const valor = filtros[clave];
    if (!valor) continue;
    binds.push(valor);
    partes.push(`(${condiciones[clave](inicio + binds.length - 1)})`);
  }
  return { sql: partes.map((p) => `AND ${p}`).join(' '), binds };
}

/** Hay algún filtro activo (para decidir escaneo exacto y el reintento sin filtros). */
export const hayFiltrosDocumento = (f: FiltrosDocumento | null | undefined): f is FiltrosDocumento =>
  Boolean(f && Object.values(f).some(Boolean));

const normal = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const escapar = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Tope de alternativas añadidas: más que esto diluye el embedding de la pregunta original. */
const MAX_ALTERNATIVAS = 6;

/**
 * Consulta para EMBEBER: la original más, entre paréntesis, las formas del diccionario de los términos
 * que contiene y que no aparecen ya. Coincidencia por palabra completa, sin tildes ni mayúsculas, las
 * claves más largas primero ("equipos de computo" antes que "computo"). `sinonimos` con claves ya
 * normalizadas, como las devuelve `leerParametros`. Sin coincidencias devuelve la consulta intacta.
 */
export function expandirConVocabulario(consulta: string, sinonimos: Record<string, string[]>): string {
  const texto = normal(consulta);
  const presentes = new Set<string>();
  const alternativas: string[] = [];
  const claves = Object.keys(sinonimos).filter((k) => k.trim()).sort((a, b) => b.length - a.length);

  for (const clave of claves) {
    if (alternativas.length >= MAX_ALTERNATIVAS) break;
    if (!new RegExp(`(^|[^a-z0-9ñ])${escapar(clave)}($|[^a-z0-9ñ])`).test(texto)) continue;
    for (const alt of sinonimos[clave]) {
      const n = normal(alt).trim();
      if (!n || presentes.has(n) || texto.includes(n)) continue;
      presentes.add(n);
      alternativas.push(alt.trim());
      if (alternativas.length >= MAX_ALTERNATIVAS) break;
    }
  }
  return alternativas.length > 0 ? `${consulta.trim()} (${alternativas.join('; ')})` : consulta;
}

const MAX_TOKENS_HYDE = 220;

const PROMPT_HYDE = 'Escribes UN párrafo (80 a 120 palabras) tal como aparecería dentro de un documento '
  + 'oficial de una entidad pública peruana (oficio, informe técnico, carta, resolución, contrato o acta) '
  + 'que respondiera la pregunta. Usa el vocabulario y el estilo formal de esos documentos (montos en '
  + 'soles, plazos en días calendario, cláusulas, numerales). Si no conoces los datos, inventa valores '
  + 'plausibles: el texto solo se usa para buscar documentos parecidos. Responde SOLO con el párrafo, sin '
  + 'títulos, sin aclarar que es hipotético.';

/**
 * Párrafo hipotético para HyDE con el modelo rápido. `null` si falla o devuelve algo inservible: HyDE
 * es un extra, nunca motivo para que el retrieval falle.
 */
export async function generarHyde(
  provider: ChatProvider,
  consulta: string,
): Promise<{ texto: string; uso: ResultadoChat['uso'] } | null> {
  return paso(
    'hyde',
    { consulta, modelo: provider.modelo },
    async () => {
      try {
        const r = await provider.responder(
          [{ rol: 'system', contenido: PROMPT_HYDE }, { rol: 'user', contenido: consulta }],
          { maxTokens: MAX_TOKENS_HYDE },
        );
        const texto = r.texto.replace(/\s+/g, ' ').trim();
        return texto.length >= 40 ? { texto: texto.slice(0, 1500), uso: r.uso } : null;
      } catch {
        // El proveedor caído ya alertó desde http.ts y su paso `llm` quedó en la traza con el error.
        return null;
      }
    },
    { resumir: (h) => ({ salida: h?.texto ?? null, nivel: h ? 'DEFAULT' : 'WARNING' }) },
  );
}

/** Lo que `recuperarContexto` del SGD/STD pide transformar. Todo opcional: sin nada, búsqueda simple. */
export interface Transformaciones {
  /** Del plan (decomposition). Cada una corre su propio retrieval en paralelo con la consulta completa. */
  subconsultas?: string[];
  /** Modelo para HyDE (el rápido). `null`/ausente = sin HyDE. */
  hyde?: ChatProvider | null;
  /** `chat.sinonimos` normalizado (`leerParametros`): expande lo que se embebe. */
  sinonimos?: Record<string, string[]>;
  /** Filtros del plan sobre metadatos del documento, aplicados también a la búsqueda de contenido. */
  filtrosDoc?: FiltrosDocumento | null;
}

/** Interruptores en `app.config` de cada módulo. Descomposición encendida por defecto (solo actúa si el
 *  planificador ve una pregunta compuesta); HyDE apagado hasta que la evaluación muestre que suma. */
export const CLAVE_HYDE = 'chat.hyde.activo';
export const CLAVE_DESCOMPOSICION = 'chat.descomposicion.activa';

/**
 * Transformaciones de la consulta de un turno del chat, según los interruptores de `app.config` del
 * módulo (`db`). Sin un plan confiable no hay subconsultas ni HyDE (no hay una consulta reescrita en la
 * que confiar); el vocabulario de dominio sí, porque no depende del modelo.
 */
export async function transformacionesDelTurno(
  plan: PlanConsulta | null,
  rapido: ChatProvider,
  sinonimos: Record<string, string[]>,
  db: Sequelize = appSequelize,
): Promise<Transformaciones> {
  const [hyde, descomposicion] = await Promise.all([
    leerBooleano(CLAVE_HYDE, false, db),
    leerBooleano(CLAVE_DESCOMPOSICION, true, db),
  ]);
  return {
    sinonimos,
    subconsultas: plan && descomposicion ? plan.subconsultas : [],
    hyde: plan && hyde ? rapido : null,
    filtrosDoc: filtrosDocumentoDelPlan(plan),
  };
}

interface ResultadoCombinable<T> {
  chunks: T[];
  candidatosVec: number;
  candidatosFts: number;
  escaneoExacto: boolean;
  degradacionVectorial?: string | null;
  candidatosHyde?: number;
}

/**
 * Une el retrieval de la consulta completa (primero) con el de cada subconsulta: chunks por RRF de
 * las listas (`fusionarListas`), cifras sumadas, y la degradación o el escaneo exacto de cualquiera.
 */
export function combinarBusquedas<T extends ChunkFusionable, R extends ResultadoCombinable<T>>(
  busquedas: R[],
  opciones: { limite: number; topePorDocumento: number },
): R & { subconsultas: number } {
  const [principal] = busquedas;
  if (busquedas.length === 1) return { ...principal, subconsultas: 0 };
  const suma = (f: (r: R) => number | undefined) => busquedas.reduce((n, r) => n + (f(r) ?? 0), 0);
  return {
    ...principal,
    chunks: fusionarListas(busquedas.map((b) => b.chunks), opciones),
    candidatosVec: suma((r) => r.candidatosVec),
    candidatosFts: suma((r) => r.candidatosFts),
    candidatosHyde: suma((r) => r.candidatosHyde),
    escaneoExacto: busquedas.some((r) => r.escaneoExacto),
    degradacionVectorial: busquedas.find((r) => r.degradacionVectorial)?.degradacionVectorial ?? null,
    subconsultas: busquedas.length - 1,
  };
}

/** Lo mínimo para fusionar: identidad del chunk y su documento de origen (para el tope por documento). */
export interface ChunkFusionable {
  chunkId: number;
  sha256: string;
  score: number;
}

/**
 * RRF (k = 60) sobre varias listas ya ordenadas — la de la consulta completa y la de cada subconsulta —
 * con el mismo tope por documento y el mismo límite que la búsqueda simple. Un chunk que aparece en
 * varias listas suma sus aportes: lo que responde a más de una parte de la pregunta sube.
 */
export function fusionarListas<T extends ChunkFusionable>(
  listas: T[][],
  opciones: { k?: number; limite: number; topePorDocumento: number },
): T[] {
  const k = opciones.k ?? 60;
  const puntaje = new Map<number, { chunk: T; score: number; primero: number }>();
  let orden = 0;
  for (const lista of listas) {
    lista.forEach((chunk, i) => {
      const previo = puntaje.get(chunk.chunkId);
      const aporte = 1 / (k + i + 1);
      if (previo) previo.score += aporte;
      else puntaje.set(chunk.chunkId, { chunk, score: aporte, primero: orden++ });
    });
  }

  const porSha = new Map<string, number>();
  const resultado: T[] = [];
  for (const p of [...puntaje.values()].sort((a, b) => b.score - a.score || a.primero - b.primero)) {
    const usados = porSha.get(p.chunk.sha256) ?? 0;
    if (usados >= opciones.topePorDocumento) continue;
    porSha.set(p.chunk.sha256, usados + 1);
    resultado.push({ ...p.chunk, score: p.score });
    if (resultado.length >= opciones.limite) break;
  }
  return resultado;
}
