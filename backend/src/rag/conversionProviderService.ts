/**
 * Orquestador de los proveedores de conversión a Markdown (markitdown / mineru).
 *
 * `RAG_CONVERTER_PROVIDER` elige cuál se intenta PRIMERO y `RAG_CONVERTER_FALLBACK` cuál se
 * intenta si el primero falla — mismo patrón de configuración que `EMBEDDING_PROVIDER`/
 * `CHAT_PROVIDER` en providerFactory.ts. Cambiar cualquiera de las dos requiere reiniciar el
 * backend.
 *
 * El respaldo se intenta ante CUALQUIER fallo del primero, no solo ante los no reintentables: si
 * markitdown se cae, el trabajo sigue saliendo por mineru en vez de acumularse en la cola. La
 * contrapartida es de rendimiento (mineru es CPU y bastante más lento), no de corrección.
 */

import { ConversionError, convertirAMarkdown, estadoCircuito, type ResultadoConversion } from './mdConvertService';
import { convertirAMarkdownMinerU, estadoCircuitoMinerU } from './mineruConvertService';

export type ProveedorConversion = 'markitdown' | 'mineru';

export interface ResultadoConversionConMetodo extends ResultadoConversion {
  /** Quién consiguió el markdown DE VERDAD — no siempre el proveedor activo, si hubo respaldo.
   *  Es lo que se guarda en `rag.contenido.metodo`, así que la columna "Método" del panel mide
   *  directamente cuánto está rescatando el fallback. */
  metodo: ProveedorConversion;
}

export function proveedorConversionActivo(): ProveedorConversion {
  const valor = (process.env.RAG_CONVERTER_PROVIDER ?? '').trim().toLowerCase();
  return valor === 'mineru' ? 'mineru' : 'markitdown';
}

/**
 * Proveedor de respaldo, o `null` si no hay.
 *
 * Sin `RAG_CONVERTER_FALLBACK` el respaldo es "el otro" — la mejora viene activada de fábrica.
 * `ninguno` (o nombrar al mismo proveedor que ya es el activo, que sería una configuración
 * incoherente) la desactiva y restaura el comportamiento de un solo intento.
 */
export function proveedorRespaldo(): ProveedorConversion | null {
  const activo = proveedorConversionActivo();
  const valor = (process.env.RAG_CONVERTER_FALLBACK ?? '').trim().toLowerCase();

  if (valor === 'ninguno' || valor === 'none') return null;

  const elegido: ProveedorConversion = valor === 'mineru' || valor === 'markitdown'
    ? valor
    : (activo === 'markitdown' ? 'mineru' : 'markitdown');

  return elegido === activo ? null : elegido;
}

function convertirCon(
  proveedor: ProveedorConversion,
  buffer: Buffer,
  filename: string,
): Promise<ResultadoConversion> {
  return proveedor === 'mineru'
    ? convertirAMarkdownMinerU(buffer, filename)
    : convertirAMarkdown(buffer, filename);
}

export function circuitoDe(proveedor: ProveedorConversion): { abierto: boolean; segundosRestantes: number } {
  return proveedor === 'mineru' ? estadoCircuitoMinerU() : estadoCircuito();
}

export async function convertirAMarkdownActivo(
  buffer: Buffer,
  filename: string,
): Promise<ResultadoConversionConMetodo> {
  const activo = proveedorConversionActivo();

  try {
    return { ...(await convertirCon(activo, buffer, filename)), metodo: activo };
  } catch (error) {
    const respaldo = proveedorRespaldo();
    if (!respaldo) throw error;

    // El cliente de cada proveedor ESPERA bloqueando lo que le quede al circuito abierto en vez de
    // rechazar al instante (ver el comentario largo en mdConvertService). Eso está bien cuando es
    // el único intento, pero como respaldo significaría sumar hasta un minuto de espera muerta a
    // cada documento mientras el segundo servicio está caído — y encima para fallar igual. Con el
    // circuito abierto, el fallo que vale es el del primero.
    if (circuitoDe(respaldo).abierto) throw error;

    try {
      return { ...(await convertirCon(respaldo, buffer, filename)), metodo: respaldo };
    } catch (errorRespaldo) {
      throw combinar(activo, error, respaldo, errorRespaldo);
    }
  }
}

/**
 * Junta los dos fallos en un solo error, conservando de dónde vino cada motivo para que
 * `rag.documento.motivo_error` diga qué pasó en cada conversor.
 *
 * `reintentable` es la DISYUNCIÓN, no la conjunción: si cualquiera de los dos fallos pudo ser
 * transitorio (timeout, red, 5xx), el documento tiene que volver a `pendiente` para el próximo
 * job. Solo cuando AMBOS conversores dicen "este archivo no se puede" se gana el `error` terminal,
 * que hoy solo se sale de él con la extracción por IA de pago.
 */
function combinar(
  activo: ProveedorConversion,
  errorActivo: unknown,
  respaldo: ProveedorConversion,
  errorRespaldo: unknown,
): ConversionError {
  const motivo = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const reintentable = (e: unknown) => (e instanceof ConversionError ? e.reintentable : true);

  return new ConversionError(
    `${activo}: ${motivo(errorActivo)} | ${respaldo}: ${motivo(errorRespaldo)}`,
    reintentable(errorActivo) || reintentable(errorRespaldo),
  );
}

/** Circuito del proveedor activo — se mantiene por compatibilidad con quien solo mira "el" estado. */
export function estadoCircuitoActivo(): { abierto: boolean; segundosRestantes: number } {
  return circuitoDe(proveedorConversionActivo());
}

/**
 * `true` solo si NINGUNA vía está disponible ahora mismo. Con respaldo configurado, que el activo
 * tenga el circuito abierto no basta para rechazar una conversión: la petición saldría igual por
 * el otro conversor.
 */
export function conversionBloqueada(): { bloqueada: boolean; segundosRestantes: number } {
  const activo = circuitoDe(proveedorConversionActivo());
  const respaldo = proveedorRespaldo();

  if (!respaldo) return { bloqueada: activo.abierto, segundosRestantes: activo.segundosRestantes };

  const otro = circuitoDe(respaldo);
  return {
    bloqueada: activo.abierto && otro.abierto,
    // El que antes vuelva a estar disponible es el que marca la espera real.
    segundosRestantes: Math.min(activo.segundosRestantes, otro.segundosRestantes),
  };
}
