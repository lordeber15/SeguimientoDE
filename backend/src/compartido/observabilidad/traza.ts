import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import type { Sequelize } from 'sequelize';

/**
 * Trazas de ejecución del chat (docs/PLAN-RAG-AVANZADO.md, Fase 2): un turno = una traza con
 * `user_id`, sesión y mensaje; cada etapa (planificador, retrieval, rerank, generación…) = un paso
 * con su entrada, salida, latencia, tokens y error.
 *
 * Contexto implícito con AsyncLocalStorage, no un parámetro más en cada función: así los proveedores
 * de IA (envueltos en `providerFactory`) y el cliente HTTP (reintentos) registran sus pasos y eventos
 * en la traza en curso sin cambiar ninguna firma. Fuera de una traza — ingesta, scripts,
 * `eval:rag` — todo esto es un no-op y el comportamiento es idéntico al de antes.
 *
 * `paso()` corre su función en un contexto hijo: los pasos lanzados en paralelo (Promise.all) quedan
 * cada uno bajo su padre correcto.
 */

export type NivelPaso = 'DEFAULT' | 'WARNING' | 'ERROR';
/** `recuperacion` = búsqueda en el corpus (en Langfuse, tipo `retriever`). */
export type TipoPaso = 'paso' | 'recuperacion' | 'generacion' | 'embedding' | 'evento';
export type ModuloTraza = 'sgd' | 'std';

export interface PasoTraza {
  id: string;
  padreId: string;
  nombre: string;
  tipo: TipoPaso;
  inicio: number;
  fin: number | null;
  entrada?: unknown;
  salida?: unknown;
  modelo?: string;
  tokensIn?: number;
  tokensOut?: number;
  nivel: NivelPaso;
  error?: string;
}

export interface DatosTraza {
  nombre: string;
  modulo: ModuloTraza;
  /** BD del módulo: la traza se guarda junto al chat al que pertenece. */
  db: Sequelize;
  usuarioId: string;
  sesionId?: number | null;
  mensajeId?: number | null;
  entrada?: unknown;
  /** Continuar una traza existente (reintento de un turno fallido): mismo id, pasos nuevos. */
  id?: string;
}

/** Tope por campo de entrada/salida: las trazas guardan texto de documentos, no deben crecer sin límite. */
export const MAX_CHARS_CAMPO = 4000;

/** Reduce un valor a algo serializable y acotado (string recortado, u objeto cuyo JSON cabe). */
export function acotar(valor: unknown, max = MAX_CHARS_CAMPO): unknown {
  if (valor === undefined || valor === null) return valor;
  if (typeof valor === 'string') return valor.length > max ? `${valor.slice(0, max)}…[+${valor.length - max}]` : valor;
  if (typeof valor === 'number' || typeof valor === 'boolean') return valor;
  let json: string;
  try {
    json = JSON.stringify(valor);
  } catch {
    return '[no serializable]';
  }
  if (json === undefined) return null;
  return json.length > max ? { recortado: true, json: `${json.slice(0, max)}…[+${json.length - max}]` } : JSON.parse(json);
}

export const nuevoIdTraza = () => crypto.randomBytes(16).toString('hex');
export const nuevoIdPaso = () => crypto.randomBytes(8).toString('hex');

export class Traza {
  readonly id: string;
  /** Span raíz de ESTA ejecución (un reintento abre otro raíz dentro de la misma traza). */
  readonly raizId = nuevoIdPaso();
  readonly continuacion: boolean;
  readonly nombre: string;
  readonly modulo: ModuloTraza;
  readonly db: Sequelize;
  readonly usuarioId: string;
  readonly inicio = Date.now();
  readonly entrada: unknown;
  readonly pasos: PasoTraza[] = [];
  sesionId: number | null;
  mensajeId: number | null;
  salida: unknown = undefined;
  estado: 'ok' | 'error' = 'ok';
  error: string | null = null;
  fin: number | null = null;

  constructor(datos: DatosTraza) {
    this.id = datos.id ?? nuevoIdTraza();
    this.continuacion = datos.id !== undefined;
    this.nombre = datos.nombre;
    this.modulo = datos.modulo;
    this.db = datos.db;
    this.usuarioId = datos.usuarioId;
    this.sesionId = datos.sesionId ?? null;
    this.mensajeId = datos.mensajeId ?? null;
    this.entrada = acotar(datos.entrada);
  }

  get tokensIn(): number {
    return this.pasos.reduce((n, p) => n + (p.tokensIn ?? 0), 0);
  }

  get tokensOut(): number {
    return this.pasos.reduce((n, p) => n + (p.tokensOut ?? 0), 0);
  }

  cerrar(estado: 'ok' | 'error', error?: unknown): void {
    this.fin = Date.now();
    this.estado = estado;
    if (error !== undefined) this.error = mensajeDe(error);
  }
}

export function mensajeDe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

interface Contexto {
  traza?: Traza;
  pasoId?: string;
  /** Reintentos HTTP para las llamadas de IA anidadas (ver `conReintentos`). */
  reintentos?: number;
}

const als = new AsyncLocalStorage<Contexto>();

export function trazaActual(): Traza | undefined {
  return als.getStore()?.traza;
}

export function reintentosDelContexto(): number | undefined {
  return als.getStore()?.reintentos;
}

type Publicador = (traza: Traza) => Promise<void>;
let publicador: Publicador | null = null;

/** Lo registra `publicacion.ts` al importarse (BD + Langfuse); aquí no se importa para no acoplar. */
export function registrarPublicador(p: Publicador | null): void {
  publicador = p;
}

/**
 * Corre `fn` dentro de una traza nueva (o la continúa, con `datos.id`) y la publica al terminar,
 * haya ido bien o mal. La publicación NO se espera: un fallo al guardar la traza nunca demora ni
 * tumba la respuesta al usuario.
 */
export async function enTraza<T>(datos: DatosTraza, fn: (traza: Traza) => Promise<T>): Promise<T> {
  const traza = new Traza(datos);
  try {
    const resultado = await als.run({ traza, pasoId: traza.raizId }, () => fn(traza));
    traza.cerrar('ok');
    return resultado;
  } catch (error) {
    traza.cerrar('error', error);
    throw error;
  } finally {
    if (publicador) {
      publicador(traza).catch((e) => console.warn(`No se pudo publicar la traza ${traza.id}: ${mensajeDe(e)}`));
    }
  }
}

export interface ResumenPaso {
  salida?: unknown;
  modelo?: string;
  tokensIn?: number;
  tokensOut?: number;
  nivel?: NivelPaso;
}

/**
 * Registra `fn` como un paso de la traza en curso. Sin traza, solo ejecuta `fn`. `resumir` extrae de
 * su resultado lo que vale la pena guardar (no el resultado entero: puede traer texto de documentos).
 */
export async function paso<T>(
  nombre: string,
  entrada: unknown,
  fn: () => Promise<T>,
  opciones: { tipo?: TipoPaso; resumir?: (resultado: T) => ResumenPaso } = {},
): Promise<T> {
  const ctx = als.getStore();
  if (!ctx?.traza) return fn();

  const p: PasoTraza = {
    id: nuevoIdPaso(),
    padreId: ctx.pasoId ?? ctx.traza.raizId,
    nombre,
    tipo: opciones.tipo ?? 'paso',
    inicio: Date.now(),
    fin: null,
    entrada: acotar(entrada),
    nivel: 'DEFAULT',
  };
  ctx.traza.pasos.push(p);

  try {
    const resultado = await als.run({ ...ctx, pasoId: p.id }, fn);
    p.fin = Date.now();
    if (opciones.resumir) {
      try {
        const r = opciones.resumir(resultado);
        p.salida = acotar(r.salida);
        p.modelo = r.modelo;
        p.tokensIn = r.tokensIn;
        p.tokensOut = r.tokensOut;
        if (r.nivel) p.nivel = r.nivel;
      } catch {
        // Un resumen roto no debe convertir un paso exitoso en un fallo.
      }
    }
    return resultado;
  } catch (error) {
    p.fin = Date.now();
    p.nivel = 'ERROR';
    p.error = mensajeDe(error);
    throw error;
  }
}

/** Evento instantáneo bajo el paso en curso (reintento, degradación, aviso). Sin traza, no-op. */
export function evento(nombre: string, datos?: unknown, nivel: NivelPaso = 'DEFAULT'): void {
  const ctx = als.getStore();
  if (!ctx?.traza) return;
  const ahora = Date.now();
  ctx.traza.pasos.push({
    id: nuevoIdPaso(),
    padreId: ctx.pasoId ?? ctx.traza.raizId,
    nombre,
    tipo: 'evento',
    inicio: ahora,
    fin: ahora,
    entrada: acotar(datos),
    nivel,
  });
}

/** Marca el paso en curso con un nivel (p. ej. WARNING por marcadores alucinados). */
export function marcarPasoActual(nivel: NivelPaso, mensaje?: string): void {
  const ctx = als.getStore();
  const p = ctx?.traza?.pasos.find((x) => x.id === ctx.pasoId);
  if (!p) return;
  p.nivel = nivel;
  if (mensaje) p.error = mensaje;
}

/** Fija cuántos reintentos HTTP usan las llamadas de IA dentro de `fn` (p. ej. 1 en el planificador). */
export function conReintentos<T>(reintentos: number, fn: () => Promise<T>): Promise<T> {
  return als.run({ ...(als.getStore() ?? {}), reintentos }, fn);
}
