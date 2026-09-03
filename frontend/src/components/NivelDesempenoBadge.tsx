export type NivelDesempeno = 'bajo' | 'medio' | 'alto';

export interface ResultadoNivel {
  nivel: NivelDesempeno;
  etiqueta: string;
  tooltip: string;
}

/**
 * Compara la tasa de atención de una fila contra el promedio de SU PROPIA oficina — no hay plazo
 * oficial ni índice global todavía (Fase 1), así que la única referencia justa disponible es "cómo
 * le va comparado con su contexto inmediato", nunca un umbral absoluto. El tooltip siempre dice
 * contra qué se comparó, para que el badge nunca se lea como un juicio aislado.
 */
export function derivarNivelPorTasaAtencion(tasaAtencion: number, promedioReferencia: number): ResultadoNivel {
  const diferencia = tasaAtencion - promedioReferencia;
  const tooltipBase = `Tasa de atención ${(tasaAtencion * 100).toFixed(0)}% — promedio de referencia ${(promedioReferencia * 100).toFixed(0)}%.`;

  if (diferencia >= 0.1) {
    return { nivel: 'alto', etiqueta: 'Alto', tooltip: `${tooltipBase} Por encima del promedio.` };
  }
  if (diferencia <= -0.1) {
    return { nivel: 'bajo', etiqueta: 'Bajo', tooltip: `${tooltipBase} Por debajo del promedio.` };
  }
  return { nivel: 'medio', etiqueta: 'Medio', tooltip: `${tooltipBase} En línea con el promedio.` };
}

/**
 * Compara el tiempo de atención — aquí menos es mejor, al revés que la tasa de atención, así que
 * la comparación se invierte.
 */
export function derivarNivelPorTiempo(horas: number | null, promedioReferencia: number | null): ResultadoNivel {
  if (horas === null) {
    return { nivel: 'medio', etiqueta: 'Sin dato', tooltip: 'Todavía no hay ninguna atención registrada.' };
  }
  if (promedioReferencia === null || promedioReferencia === 0) {
    return { nivel: 'medio', etiqueta: 'Medio', tooltip: `${horas.toFixed(1)} h — sin promedio de referencia todavía.` };
  }

  const razon = horas / promedioReferencia;
  const tooltipBase = `${horas.toFixed(1)} h — promedio de referencia ${promedioReferencia.toFixed(1)} h.`;

  if (razon <= 0.8) {
    return { nivel: 'alto', etiqueta: 'Alto', tooltip: `${tooltipBase} Más rápido que el promedio.` };
  }
  if (razon >= 1.2) {
    return { nivel: 'bajo', etiqueta: 'Bajo', tooltip: `${tooltipBase} Más lento que el promedio.` };
  }
  return { nivel: 'medio', etiqueta: 'Medio', tooltip: `${tooltipBase} En línea con el promedio.` };
}

const CLASE_POR_NIVEL: Record<NivelDesempeno, string> = {
  bajo: 'badge-anulado',
  medio: 'badge-pendiente',
  alto: 'badge-atendido',
};

export function NivelDesempenoBadge({ resultado }: { resultado: ResultadoNivel }) {
  return (
    <span className={`badge ${CLASE_POR_NIVEL[resultado.nivel]}`} title={resultado.tooltip}>
      {resultado.etiqueta}
    </span>
  );
}
