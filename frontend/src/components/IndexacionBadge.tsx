import type { EstadoIngestaExpediente } from '../api/chat';

export type NivelIndexacion = 'sin-indexar' | 'solo-texto' | 'listo';

export interface ResultadoIndexacion {
  nivel: NivelIndexacion;
  etiqueta: string;
  tooltip: string;
}

/** Desglose legible de lo que falta, omitiendo los ceros — mismo criterio que ya usa el panel RAG. */
function construirDesglose(e: EstadoIngestaExpediente): string {
  const detalles: string[] = [];
  if (e.pendientes > 0) detalles.push(`${e.pendientes} pendiente(s)`);
  if (e.error > 0) detalles.push(`${e.error} con error`);
  if (e.sinTexto > 0) detalles.push(`${e.sinTexto} sin texto extraíble`);
  if (e.noSoportado > 0) detalles.push(`${e.noSoportado} de formato no soportado`);
  return detalles.join(', ');
}

/**
 * Tres estados honestos para el badge de la tabla de Seguimiento — no el mismo criterio que
 * `completo` (usado por `ChatPage` para el aviso de chat, que exige TODO en `ok`):
 *
 * - `recuperables = listos + convertidos` — lo que el chat ya puede encontrar hoy (`buscarHibrido`
 *   degrada con gracia a búsqueda de texto puro cuando falta el modelo de embeddings).
 * - `faltantes = pendientes + error` — debería estar y no está: un hueco real.
 * - `imposibles = sinTexto + noSoportado` — nunca va a ser recuperable, y ningún botón lo arregla
 *   (PDF escaneado sin OCR, .zip, .docx...).
 *
 * Verde se calcula sobre `recuperables`, no sobre `total`, a propósito: un expediente con 3 "ok" y
 * 2 "sin_texto" ya llegó a su mejor estado posible — dejarlo ámbar para siempre, junto a un botón
 * que no puede hacer nada al respecto, sería la opción deshonesta.
 */
export function derivarEstadoIndexacion(e: EstadoIngestaExpediente): ResultadoIndexacion {
  const recuperables = e.listos + e.convertidos;
  const faltantes = e.pendientes + e.error;
  const imposibles = e.sinTexto + e.noSoportado;

  if (e.total === 0) {
    return {
      nivel: 'sin-indexar',
      etiqueta: 'Sin indexar',
      tooltip: 'Este expediente no está en la base de conocimientos todavía.',
    };
  }

  if (recuperables === 0) {
    if (imposibles === e.total) {
      return {
        nivel: 'sin-indexar',
        etiqueta: 'Sin indexar',
        tooltip:
          `Ninguno de sus ${e.total} documento(s) tiene texto extraíble (PDF escaneado sin OCR ` +
          'o formato no soportado). El chat no podrá citarlos.',
      };
    }
    const detalle = construirDesglose(e);
    return {
      nivel: 'sin-indexar',
      etiqueta: 'Sin indexar',
      tooltip: `Todavía no hay ningún documento listo para el chat en este expediente${detalle ? ` (${detalle})` : ''}.`,
    };
  }

  if (e.listos === recuperables && faltantes === 0) {
    let tooltip = `${e.listos} documento(s) listos para búsqueda semántica.`;
    if (imposibles > 0) tooltip += ` (${imposibles} sin texto extraíble, no recuperable.)`;
    return { nivel: 'listo', etiqueta: 'Listo', tooltip };
  }

  const detalle = construirDesglose(e);
  return {
    nivel: 'solo-texto',
    etiqueta: 'Solo texto',
    tooltip:
      `${e.listos} de ${recuperables} documento(s) con búsqueda semántica; el resto solo se ` +
      `encuentra por coincidencia de texto${detalle ? ` (${detalle})` : ''}.`,
  };
}

const CLASE_POR_NIVEL: Record<NivelIndexacion, string> = {
  'sin-indexar': 'badge-neutro',
  'solo-texto': 'badge-pendiente',
  listo: 'badge-atendido',
};

export function IndexacionBadge({ estado }: { estado: EstadoIngestaExpediente }) {
  const resultado = derivarEstadoIndexacion(estado);
  return (
    <span className={`badge ${CLASE_POR_NIVEL[resultado.nivel]}`} title={resultado.tooltip}>
      {resultado.etiqueta}
    </span>
  );
}
