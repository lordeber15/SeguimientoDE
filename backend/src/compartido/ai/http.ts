import { alertar } from '../observabilidad/alertas';
import { evento, reintentosDelContexto } from '../observabilidad/traza';
import { ErrorIA, type NombreProveedor, type TipoErrorIA } from './types';

/**
 * Cliente HTTP común a todos los proveedores: timeout propio, reintentos con espera exponencial y
 * jitter, y traducción del error a `ErrorIA`.
 *
 * El timeout es imprescindible: `fetch` no lleva ninguno por defecto y una petición colgada
 * bloquearía la ingesta entera, que por diseño es de concurrencia 1.
 *
 * Reintentos (docs/PLAN-RAG-AVANZADO.md, Fase 2): `opciones.reintentos`, o el del contexto
 * (`conReintentos`, p. ej. 1 en el planificador y en el embedding de la consulta del chat, donde
 * conviene degradar rápido), o `IA_REINTENTOS` (2). La espera respeta `Retry-After` si el proveedor
 * lo manda; si no, 1 s · 2^intento con jitter (×0,5–1,5) para que varios procesos no reintenten a la
 * vez. Cada reintento queda como evento en la traza en curso, y el fallo final dispara una alerta.
 */

const REINTENTOS_POR_DEFECTO = 2;
const ESPERA_BASE_MS = 1000;
/** Tope de espera aunque `Retry-After` pida más: el usuario del chat está esperando. */
const ESPERA_MAX_MS = 30_000;

export interface OpcionesPeticion {
  url: string;
  cuerpo: unknown;
  cabeceras: Record<string, string>;
  proveedor: NombreProveedor;
  timeoutMs?: number;
  reintentos?: number;
}

function reintentosEfectivos(opciones: OpcionesPeticion): number {
  const n = opciones.reintentos ?? reintentosDelContexto() ?? Number(process.env.IA_REINTENTOS ?? REINTENTOS_POR_DEFECTO);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : REINTENTOS_POR_DEFECTO;
}

/** `Retry-After` en segundos o como fecha HTTP. `null` si no viene o no se entiende. */
export function esperaDeRetryAfter(valor: string | null, ahora = Date.now()): number | null {
  if (!valor) return null;
  const segundos = Number(valor);
  if (Number.isFinite(segundos) && segundos >= 0) return Math.min(segundos * 1000, ESPERA_MAX_MS);
  const fecha = Date.parse(valor);
  return Number.isNaN(fecha) ? null : Math.min(Math.max(0, fecha - ahora), ESPERA_MAX_MS);
}

export function esperaExponencial(intento: number, azar = Math.random()): number {
  return Math.min(ESPERA_BASE_MS * 2 ** intento * (0.5 + azar), ESPERA_MAX_MS);
}

function fallar(error: ErrorIA): never {
  // context_length lo resuelve quien llama (recortando); no es un incidente operativo.
  if (error.tipo !== 'context_length') {
    alertar('proveedor_ia', error.message, { proveedor: error.proveedor, tipo: error.tipo, status: error.status ?? null },
      `${error.proveedor}|${error.tipo}`);
  }
  throw error;
}

export async function postJson<T>(opciones: OpcionesPeticion): Promise<T> {
  const timeout = opciones.timeoutMs ?? Number(process.env.IA_TIMEOUT_MS ?? 120_000);
  const reintentos = reintentosEfectivos(opciones);
  let ultimo: ErrorIA | null = null;

  for (let intento = 0; intento <= reintentos; intento++) {
    const abortador = new AbortController();
    const temporizador = setTimeout(() => abortador.abort(), timeout);
    let retryAfter: string | null = null;

    try {
      const respuesta = await fetch(opciones.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...opciones.cabeceras },
        body: JSON.stringify(opciones.cuerpo),
        signal: abortador.signal,
      });

      if (respuesta.ok) return (await respuesta.json()) as T;

      retryAfter = respuesta.headers?.get?.('retry-after') ?? null;
      const texto = await respuesta.text().catch(() => '');
      ultimo = new ErrorIA(
        `${opciones.proveedor}: HTTP ${respuesta.status} ${texto.slice(0, 300)}`,
        clasificarPorEstado(respuesta.status, texto),
        opciones.proveedor,
        respuesta.status,
      );

      // Un 401/403, un texto que no cabe o el crédito agotado no mejoran repitiendo la misma petición.
      if (ultimo.tipo === 'auth' || ultimo.tipo === 'context_length' || ultimo.tipo === 'quota') fallar(ultimo);
    } catch (error) {
      if (error instanceof ErrorIA) {
        if (error.tipo === 'auth' || error.tipo === 'context_length' || error.tipo === 'quota') throw error;
        ultimo = error;
      } else if (error instanceof Error && error.name === 'AbortError') {
        ultimo = new ErrorIA(
          `${opciones.proveedor}: la petición superó ${timeout} ms`,
          'unavailable',
          opciones.proveedor,
        );
      } else {
        ultimo = new ErrorIA(
          `${opciones.proveedor}: ${error instanceof Error ? error.message : 'error de red'}`,
          'unavailable',
          opciones.proveedor,
        );
      }
    } finally {
      clearTimeout(temporizador);
    }

    if (intento < reintentos) {
      const espera = esperaDeRetryAfter(retryAfter) ?? esperaExponencial(intento);
      evento('reintento_ia', {
        proveedor: opciones.proveedor, intento: intento + 1, de: reintentos, tipo: ultimo?.tipo,
        status: ultimo?.status ?? null, esperaMs: Math.round(espera),
      }, 'WARNING');
      await new Promise((r) => setTimeout(r, espera));
    }
  }

  fallar(ultimo ?? new ErrorIA(`${opciones.proveedor}: error desconocido`, 'desconocido', opciones.proveedor));
}

function clasificarPorEstado(status: number, cuerpo: string): TipoErrorIA {
  const texto = cuerpo.toLowerCase();

  if (status === 401 || status === 403) return 'auth';
  if (status === 429) {
    // OpenAI y Anthropic usan 429 tanto para "vas muy rápido" como para "se acabó el crédito".
    // La diferencia importa: lo primero se reintenta, lo segundo obliga a cambiar de proveedor.
    return texto.includes('quota') || texto.includes('billing') || texto.includes('credit')
      ? 'quota'
      : 'rate_limit';
  }
  if (status === 402) return 'quota';
  if (status === 413 || texto.includes('context length') || texto.includes('too many tokens')) {
    return 'context_length';
  }
  if (status >= 500) return 'unavailable';

  return 'desconocido';
}

/** Estimación por caracteres cuando el proveedor no devuelve `usage`. */
export function estimarTokens(textos: string[]): number {
  // ~4 caracteres por token en inglés; el español gasta 15-20 % más con BPE, de ahí el 3,5.
  return Math.ceil(textos.reduce((n, t) => n + t.length, 0) / 3.5);
}
