/**
 * Cliente del servicio MinerU (PDF/DOCX/XLSX/PPTX/imagen → Markdown, con OCR real en el propio
 * pipeline de parseo). Alternativa a markitdown — ver conversionProviderService.ts para el
 * interruptor entre ambos.
 *
 * Se usa siempre `backend=pipeline` (fijo, nunca configurable): es la única variante de MinerU que
 * no requiere GPU/cómputo dedicado y soporta el set de idiomas más amplio.
 *
 * Mismo esqueleto de resiliencia que mdConvertService.ts (semáforo de concurrencia 1, cortacircuito,
 * doble guardia de timeout) — MinerU sí soporta peticiones concurrentes (ver `/health` ->
 * `max_concurrent_requests`), pero se parte en 1 por simplicidad hasta validar estabilidad en
 * producción.
 */

import { ConversionError, type ResultadoConversion } from './mdConvertService';
import type { ReportarFase } from './fasesConversion';

const URL_BASE = () => (process.env.MINERU_URL ?? 'http://localhost:8013').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.MINERU_TIMEOUT_MS ?? 300_000);
const MARGEN_LIMITE_DURO = 15_000;
const MAX_BYTES = Number(process.env.MINERU_MAX_BYTES ?? 50 * 1024 * 1024);

/** Tope real de una conversión, para la barra de progreso — ver el mismo campo en mdConvertService. */
export const TOPE_CONVERSION_MINERU_MS = TIMEOUT_MS + MARGEN_LIMITE_DURO;
const PARSE_METHOD = process.env.MINERU_PARSE_METHOD ?? 'auto';
const LANG_LIST = (process.env.MINERU_LANG_LIST ?? 'ch')
  .split(',')
  .map((l) => l.trim())
  .filter(Boolean);

interface RespuestaFileParse {
  status?: string;
  file_names?: string[];
  error?: string | null;
  results?: Record<string, { md_content?: string }>;
}

// ── Semáforo de concurrencia 1 ───────────────────────────────────────────────
let enCurso: Promise<unknown> = Promise.resolve();

function enSerie<T>(tarea: () => Promise<T>): Promise<T> {
  const siguiente = enCurso.then(tarea, tarea);
  enCurso = siguiente.catch(() => undefined);
  return siguiente;
}

// ── Cortacircuitos ───────────────────────────────────────────────────────────
const FALLOS_PARA_ABRIR = 3;
const REPOSO_MS = 60_000;
let fallosSeguidos = 0;
let abiertoHasta = 0;

export function estadoCircuitoMinerU(): { abierto: boolean; segundosRestantes: number } {
  const restante = Math.max(0, abiertoHasta - Date.now());
  return { abierto: restante > 0, segundosRestantes: Math.ceil(restante / 1000) };
}

export async function convertirAMarkdownMinerU(
  buffer: Buffer,
  filename: string,
  onFase?: ReportarFase,
): Promise<ResultadoConversion> {
  if (buffer.length > MAX_BYTES) {
    throw new ConversionError(`El archivo supera los ${Math.round(MAX_BYTES / 1024 / 1024)} MB`);
  }

  const circuito = estadoCircuitoMinerU();
  if (circuito.abierto) {
    onFase?.({
      fase: 'esperando_circuito',
      proveedor: 'mineru',
      limiteMs: circuito.segundosRestantes * 1000,
    });
    await new Promise((r) => setTimeout(r, circuito.segundosRestantes * 1000));
  }

  onFase?.({ fase: 'en_cola_conversor', proveedor: 'mineru', limiteMs: null });
  return enSerie(() => {
    onFase?.({ fase: 'convirtiendo', proveedor: 'mineru', limiteMs: TOPE_CONVERSION_MINERU_MS });
    return convertirUno(buffer, filename);
  });
}

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
    formulario.append('files', new Blob([new Uint8Array(buffer)]), filename);
    formulario.append('backend', 'pipeline');
    formulario.append('parse_method', PARSE_METHOD);
    formulario.append('formula_enable', 'true');
    formulario.append('table_enable', 'true');
    formulario.append('return_md', 'true');
    for (const lang of LANG_LIST) formulario.append('lang_list', lang);

    const respuesta = await fetch(`${URL_BASE()}/file_parse`, {
      method: 'POST',
      body: formulario,
      signal: abortador.signal,
    });

    if (!respuesta.ok) {
      const detalle = await respuesta.text().catch(() => '');
      // Mismo criterio que mdConvertService: 404/405 es el servicio mal desplegado (endpoint
      // inexistente), no un archivo que este conversor no sepa procesar.
      const esServicioMalDesplegado = respuesta.status === 404 || respuesta.status === 405;
      const reintentable = respuesta.status >= 500 || esServicioMalDesplegado;
      if (reintentable) registrarFallo();
      else fallosSeguidos = 0;
      throw new ConversionError(
        `mineru HTTP ${respuesta.status}: ${detalle.slice(0, 200)}`,
        reintentable,
      );
    }

    const cuerpo = (await respuesta.json()) as RespuestaFileParse;
    fallosSeguidos = 0;

    // HTTP 200 no garantiza éxito: MinerU puede devolver status='failed' con error != null para
    // archivos que no pudo procesar (culpa del archivo, no del servicio -> no reintentable).
    if (cuerpo.status === 'failed' || cuerpo.error) {
      throw new ConversionError(`mineru no pudo procesar el archivo: ${cuerpo.error ?? 'sin detalle'}`);
    }

    const clave = cuerpo.file_names?.[0];
    const resultado = clave ? cuerpo.results?.[clave] : undefined;
    if (!resultado || typeof resultado.md_content !== 'string') {
      throw new ConversionError('mineru devolvió una respuesta sin md_content', true);
    }

    return { markdown: resultado.md_content, ms: Date.now() - inicio };
  } catch (error) {
    if (error instanceof ConversionError) throw error;

    if (error instanceof Error && error.name === 'AbortError') {
      registrarFallo();
      throw new ConversionError(`La conversión superó ${TIMEOUT_MS / 1000} s`, true);
    }

    registrarFallo();
    throw new ConversionError(
      `No se pudo contactar con mineru: ${error instanceof Error ? error.message : 'error de red'}`,
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

export async function mineruDisponible(): Promise<boolean> {
  try {
    const abortador = new AbortController();
    const t = setTimeout(() => abortador.abort(), 5000);
    const r = await fetch(`${URL_BASE()}/health`, { signal: abortador.signal });
    clearTimeout(t);
    if (!r.ok) return false;
    const cuerpo = (await r.json()) as { status?: string };
    return cuerpo.status === 'healthy';
  } catch {
    return false;
  }
}
