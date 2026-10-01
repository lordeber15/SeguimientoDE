import { ErrorIA, type NombreProveedor, type TipoErrorIA } from './types';

/**
 * Cliente HTTP común a todos los proveedores: timeout propio, reintentos con espera creciente y
 * traducción del error a `ErrorIA`.
 *
 * El timeout es imprescindible: `fetch` no lleva ninguno por defecto y una petición colgada
 * bloquearía la ingesta entera, que por diseño es de concurrencia 1.
 */

const REINTENTOS = 2;

export interface OpcionesPeticion {
  url: string;
  cuerpo: unknown;
  cabeceras: Record<string, string>;
  proveedor: NombreProveedor;
  timeoutMs?: number;
}

export async function postJson<T>(opciones: OpcionesPeticion): Promise<T> {
  const timeout = opciones.timeoutMs ?? Number(process.env.IA_TIMEOUT_MS ?? 120_000);
  let ultimo: ErrorIA | null = null;

  for (let intento = 0; intento <= REINTENTOS; intento++) {
    const abortador = new AbortController();
    const temporizador = setTimeout(() => abortador.abort(), timeout);

    try {
      const respuesta = await fetch(opciones.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...opciones.cabeceras },
        body: JSON.stringify(opciones.cuerpo),
        signal: abortador.signal,
      });

      if (respuesta.ok) return (await respuesta.json()) as T;

      const texto = await respuesta.text().catch(() => '');
      ultimo = new ErrorIA(
        `${opciones.proveedor}: HTTP ${respuesta.status} ${texto.slice(0, 300)}`,
        clasificarPorEstado(respuesta.status, texto),
        opciones.proveedor,
        respuesta.status,
      );

      // Un 401/403 o un texto que no cabe no mejoran repitiendo la misma petición.
      if (ultimo.tipo === 'auth' || ultimo.tipo === 'context_length') throw ultimo;
    } catch (error) {
      if (error instanceof ErrorIA) {
        if (error.tipo === 'auth' || error.tipo === 'context_length') throw error;
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

    if (intento < REINTENTOS) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** intento));
    }
  }

  throw ultimo ?? new ErrorIA(`${opciones.proveedor}: error desconocido`, 'desconocido', opciones.proveedor);
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
