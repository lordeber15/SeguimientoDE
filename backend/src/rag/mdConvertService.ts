/**
 * Cliente del servicio markitdown (PDF/DOCX/XLSX → Markdown).
 *
 * Dos propiedades del servicio mandan en este diseño:
 *
 * 1. **Bloquea su propio event loop**: es síncrono por dentro, así que dos conversiones en
 *    paralelo no van el doble de rápido — se estorban. Por eso hay un semáforo de 1.
 * 2. **No tiene timeout propio**: un PDF corrupto puede colgarlo indefinidamente. El timeout lo
 *    pone este lado, o la ingesta entera se queda esperando para siempre.
 */

import type { ReportarFase } from './fasesConversion';

const URL_BASE = () => (process.env.MARKITDOWN_URL ?? 'http://localhost:8001').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.MARKITDOWN_TIMEOUT_MS ?? 180_000);
/** Margen extra del límite duro sobre el timeout normal — solo debería activarse si el abort falló. */
const MARGEN_LIMITE_DURO = 15_000;
/** 50 MB: el límite del propio servicio. */
const MAX_BYTES = Number(process.env.MARKITDOWN_MAX_BYTES ?? 50 * 1024 * 1024);

/**
 * Tope real de una conversión, para la barra de progreso: el `AbortController` de abajo corta a
 * `TIMEOUT_MS`, pero el límite duro (la segunda garantía del incidente de 2026-08-23) puede tardar
 * `MARGEN_LIMITE_DURO` más en resolver. Se publica ESTE número, no `TIMEOUT_MS` — una barra que se
 * llenara a los 180 s se quedaría 15 s clavada al 100 % antes de que el ítem pudiera siquiera fallar.
 */
export const TOPE_CONVERSION_MS = TIMEOUT_MS + MARGEN_LIMITE_DURO;

export class ConversionError extends Error {
  readonly motivo: string;
  readonly reintentable: boolean;

  constructor(motivo: string, reintentable = false) {
    super(motivo);
    this.name = 'ConversionError';
    this.motivo = motivo;
    this.reintentable = reintentable;
  }
}

export interface ResultadoConversion {
  markdown: string;
  ms: number;
}

// ── Semáforo de concurrencia 1 ───────────────────────────────────────────────
let enCurso: Promise<unknown> = Promise.resolve();

function enSerie<T>(tarea: () => Promise<T>): Promise<T> {
  const siguiente = enCurso.then(tarea, tarea);
  // La cola no debe romperse porque una conversión falle.
  enCurso = siguiente.catch(() => undefined);
  return siguiente;
}

// ── Cortacircuitos ───────────────────────────────────────────────────────────
// Si el servicio está caído, 3.000 documentos generarían 3.000 esperas de 180 s. Tras 3 fallos
// seguidos de conexión se deja de intentar durante un minuto.
const FALLOS_PARA_ABRIR = 3;
const REPOSO_MS = 60_000;
let fallosSeguidos = 0;
let abiertoHasta = 0;

export function estadoCircuito(): { abierto: boolean; segundosRestantes: number } {
  const restante = Math.max(0, abiertoHasta - Date.now());
  return { abierto: restante > 0, segundosRestantes: Math.ceil(restante / 1000) };
}

export async function convertirAMarkdown(
  buffer: Buffer,
  filename: string,
  onFase?: ReportarFase,
): Promise<ResultadoConversion> {
  if (buffer.length > MAX_BYTES) {
    throw new ConversionError(`El archivo supera los ${Math.round(MAX_BYTES / 1024 / 1024)} MB`);
  }

  const circuito = estadoCircuito();
  if (circuito.abierto) {
    // El único consumidor de esta función es el job de ingesta en segundo plano — nadie espera
    // esto en vivo. Por eso tiene más sentido ESPERAR a que el circuito cierre que rechazar al
    // instante: antes, un solo fallo real disparaba el circuito y de paso tumbaba como "error" a
    // cientos de documentos en cola que nunca llegaron a intentarse siquiera, inflando el contador
    // de errores del job sin motivo real. Si al reintentar vuelve a fallar, ESE ítem sí cuenta
    // como error genuino (uno por ventana de reposo, no todos a la vez), y el siguiente ítem
    // repite el mismo ciclo de espera.
    //
    // Esta espera es exactamente lo que hasta ahora la UI pintaba como "convirtiendo": hasta 60 s
    // en los que no se hace absolutamente nada. Se reporta aparte para que la barra lo diga.
    onFase?.({
      fase: 'esperando_circuito',
      proveedor: 'markitdown',
      limiteMs: circuito.segundosRestantes * 1000,
    });
    await new Promise((r) => setTimeout(r, circuito.segundosRestantes * 1000));
  }

  // `enSerie` difiere al menos un microtask: con la cola libre, esta fase y la de "convirtiendo"
  // se suceden dentro del mismo tick y el sondeo (cada 1500 ms) nunca llega a verla. Solo se hace
  // visible cuando la espera es real por otro documento delante — que es justo cuando hace falta
  // saberlo, en vez de que parezca que este documento lleva más tiempo convirtiendo del que lleva.
  onFase?.({ fase: 'en_cola_conversor', proveedor: 'markitdown', limiteMs: null });
  return enSerie(() => {
    onFase?.({ fase: 'convirtiendo', proveedor: 'markitdown', limiteMs: TOPE_CONVERSION_MS });
    return convertirUno(buffer, filename);
  });
}

/**
 * Se observó en producción (2026-08-23) un documento de 9,2 MB que dejó la cola entera
 * congelada: el `AbortController` de abajo debía cortar a los `TIMEOUT_MS`, y reproducciones
 * aisladas del mismo request SÍ abortaron a tiempo — pero en el proceso real, tras ~140
 * conversiones seguidas, la petición se quedó colgada más de 45 minutos sin que el abort surtiera
 * efecto ni se registrara ningún error. No se pudo aislar la causa exacta (¿degradación de
 * `fetch`/undici tras muchas peticiones? ¿el propio markitdown quedó sordo al socket?), así que
 * en vez de perseguir un repro que no vuelve a fallar en aislamiento, se añade una segunda
 * garantía independiente: una carrera contra un temporizador que **siempre** resuelve la promesa,
 * pase lo que pase con el `fetch` de abajo. Sin esto, un solo documento anómalo puede congelar
 * una ingesta de miles para siempre — ya pasó una vez.
 */
async function convertirUno(buffer: Buffer, filename: string): Promise<ResultadoConversion> {
  return Promise.race([intentarConversion(buffer, filename), limiteDuro()]);
}

function limiteDuro(): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => {
      registrarFallo();
      reject(new ConversionError(`La conversión no respondió en ${(TIMEOUT_MS + MARGEN_LIMITE_DURO) / 1000} s (límite duro)`, true));
    }, TIMEOUT_MS + MARGEN_LIMITE_DURO).unref();
  });
}

async function intentarConversion(buffer: Buffer, filename: string): Promise<ResultadoConversion> {
  const abortador = new AbortController();
  const temporizador = setTimeout(() => abortador.abort(), TIMEOUT_MS);
  const inicio = Date.now();

  try {
    const formulario = new FormData();
    formulario.append('file', new Blob([new Uint8Array(buffer)]), filename);

    const respuesta = await fetch(`${URL_BASE()}/api/convert`, {
      method: 'POST',
      body: formulario,
      signal: abortador.signal,
    });

    if (!respuesta.ok) {
      const detalle = await respuesta.text().catch(() => '');
      // 4xx es culpa del archivo (no reintentar); 5xx es del servicio (sí). Excepción: 404/405
      // significan "ese endpoint no existe aquí", que es el servicio mal desplegado, no el
      // archivo. Pasó de verdad (2026-09): 359 documentos acabaron en `error` terminal con
      // "markitdown HTTP 404" mientras otra imagen ocupaba el puerto 8001 — archivos perfectos
      // que, tratados como culpa suya, quedaban fuera de la reparación gratuita para siempre.
      const esServicioMalDesplegado = respuesta.status === 404 || respuesta.status === 405;
      const reintentable = respuesta.status >= 500 || esServicioMalDesplegado;
      if (reintentable) registrarFallo();
      else fallosSeguidos = 0;
      throw new ConversionError(
        `markitdown HTTP ${respuesta.status}: ${detalle.slice(0, 200)}`,
        reintentable,
      );
    }

    const cuerpo = (await respuesta.json()) as { markdown?: string };
    fallosSeguidos = 0;

    if (typeof cuerpo.markdown !== 'string') {
      throw new ConversionError('markitdown devolvió una respuesta sin markdown');
    }

    return { markdown: cuerpo.markdown, ms: Date.now() - inicio };
  } catch (error) {
    if (error instanceof ConversionError) throw error;

    if (error instanceof Error && error.name === 'AbortError') {
      registrarFallo();
      throw new ConversionError(`La conversión superó ${TIMEOUT_MS / 1000} s`, true);
    }

    registrarFallo();
    throw new ConversionError(
      `No se pudo contactar con markitdown: ${error instanceof Error ? error.message : 'error de red'}`,
      true,
    );
  } finally {
    clearTimeout(temporizador);
  }
}

function registrarFallo() {
  fallosSeguidos++;
  if (fallosSeguidos >= FALLOS_PARA_ABRIR) {
    abiertoHasta = Date.now() + REPOSO_MS;
    fallosSeguidos = 0;
  }
}

export async function markitdownDisponible(): Promise<boolean> {
  try {
    const abortador = new AbortController();
    const t = setTimeout(() => abortador.abort(), 5000);
    const r = await fetch(`${URL_BASE()}/api/health`, { signal: abortador.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}
