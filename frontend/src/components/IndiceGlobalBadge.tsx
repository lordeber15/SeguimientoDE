export interface DimensionesIndice {
  tasaAtencion: number;
  tiempoPromedioHoras: number | null;
  tasaAnulacion: number | null;
}

export interface PesosIndice {
  tasaAtencion: number;
  tiempoPromedioHoras: number;
  tasaAnulacion: number;
}

/**
 * Calibrado 2026-08-29 sobre el espejo real (2026-05-06 a 2026-08-28, único período con volumen —
 * ver PLAN-DASHBOARD-DESEMPENO.md §3/§9): primer componente principal (PCA) sobre `tasaAtencion`,
 * `tiempoPromedioHoras` (invertido) y `tasaAnulacion` (invertida), ambos normalizados por z-score,
 * de las 24 oficinas con `recibidos >= 15` en ese período — explica 62,5% de la varianza conjunta.
 *
 * `tasaReproceso` quedó FUERA del índice a propósito: en los datos reales correlaciona NEGATIVO
 * con `tasaAtencion` (r=-0,38) — las oficinas que más atienden también más reprocesan, lo
 * contrario de lo que se esperaría si "menos reproceso" fuera simplemente mejor. Es consistente
 * con que ya está documentado como un proxy ("el mismo empleado volvió a tocar el expediente", no
 * un devuelto confirmado, ver §3) — forzarlo en un índice compuesto le habría dado signo opuesto
 * al que el nombre de la columna sugiere, más confuso que útil.
 */
export const PESOS_INDICE_OFICINA: PesosIndice = {
  tasaAtencion: 0.38,
  tiempoPromedioHoras: 0.29,
  tasaAnulacion: 0.33,
};

/**
 * A nivel EMPLEADO (118 empleados, `recibidos >= 10`, mismo período) las tres dimensiones casi no
 * correlacionan entre sí (r entre 0,03 y 0,15) — el primer componente principal solo explica un
 * 39,7% de la varianza, apenas por encima del ~33% que ya explicaría un peso igual sin ninguna
 * correlación real que aprovechar. Sin redundancia que ajustar, se usan pesos iguales — la
 * alternativa que el propio §9 dejaba prevista si el PCA "resulta impráctico" — en vez de forzar
 * una combinación que no aporta señal por sobre simplemente promediar las tres.
 */
export const PESOS_INDICE_EMPLEADO: PesosIndice = {
  tasaAtencion: 1 / 3,
  tiempoPromedioHoras: 1 / 3,
  tasaAnulacion: 1 / 3,
};

function media(valores: number[]): number {
  return valores.reduce((a, b) => a + b, 0) / valores.length;
}

/** Desvío muestral (n-1) — con un solo elegible en el grupo, `desvio` es 0 y su z-score cae a 0
 *  (ver `zscore`), no `NaN`: no hay con qué comparar, no que esa fila sea "el promedio". */
function desvio(valores: number[], mediaValor: number): number {
  if (valores.length < 2) return 0;
  return Math.sqrt(valores.reduce((a, b) => a + (b - mediaValor) ** 2, 0) / (valores.length - 1));
}

function zscore(valor: number, mediaValor: number, desvioValor: number): number {
  return desvioValor === 0 ? 0 : (valor - mediaValor) / desvioValor;
}

/**
 * Índice compuesto (Fase 4): combina las 3 dimensiones ya normalizadas (z-score) dentro del GRUPO
 * recibido — quien llama decide el grupo (todas las oficinas del período, o los empleados de una
 * misma oficina, ver `calcularIndicesYNiveles`) — con los pesos calibrados de arriba.
 * `tiempoPromedioHoras`/`tasaAnulacion` se invierten antes de normalizar: menos es mejor en
 * ambas, al revés que `tasaAtencion`. Filas con algún valor `null` (nadie atendió o nadie emitió
 * todavía en el período) quedan fuera de la media/desvío del grupo Y sin índice propio (`null`)
 * — no hay base para comparar ni para ubicarlas.
 */
export function calcularIndicesGlobales<T extends DimensionesIndice>(
  filas: T[],
  pesos: PesosIndice,
): (number | null)[] {
  const elegibles = filas
    .map((fila, posicion) => ({ fila, posicion }))
    .filter(({ fila }) => fila.tiempoPromedioHoras !== null && fila.tasaAnulacion !== null);

  const crudo = {
    tasaAtencion: elegibles.map(({ fila }) => fila.tasaAtencion),
    tiempoPromedioHoras: elegibles.map(({ fila }) => -fila.tiempoPromedioHoras!),
    tasaAnulacion: elegibles.map(({ fila }) => -fila.tasaAnulacion!),
  };

  const stats = {
    tasaAtencion: { media: media(crudo.tasaAtencion), desvio: 0 },
    tiempoPromedioHoras: { media: media(crudo.tiempoPromedioHoras), desvio: 0 },
    tasaAnulacion: { media: media(crudo.tasaAnulacion), desvio: 0 },
  };
  stats.tasaAtencion.desvio = desvio(crudo.tasaAtencion, stats.tasaAtencion.media);
  stats.tiempoPromedioHoras.desvio = desvio(crudo.tiempoPromedioHoras, stats.tiempoPromedioHoras.media);
  stats.tasaAnulacion.desvio = desvio(crudo.tasaAnulacion, stats.tasaAnulacion.media);

  const resultado: (number | null)[] = filas.map(() => null);
  elegibles.forEach(({ posicion }, i) => {
    const zTasaAtencion = zscore(crudo.tasaAtencion[i], stats.tasaAtencion.media, stats.tasaAtencion.desvio);
    const zTiempo = zscore(crudo.tiempoPromedioHoras[i], stats.tiempoPromedioHoras.media, stats.tiempoPromedioHoras.desvio);
    const zAnulacion = zscore(crudo.tasaAnulacion[i], stats.tasaAnulacion.media, stats.tasaAnulacion.desvio);
    resultado[posicion] = zTasaAtencion * pesos.tasaAtencion + zTiempo * pesos.tiempoPromedioHoras + zAnulacion * pesos.tasaAnulacion;
  });

  return resultado;
}

export type NivelIndice = 'bajo' | 'medio' | 'alto';

export interface ResultadoIndice {
  nivel: NivelIndice;
  etiqueta: string;
  tooltip: string;
}

/**
 * Niveles por PERCENTIL dentro del grupo (§9, Fase 4, punto 3) — a diferencia de los badges de
 * Fase 1 (`NivelDesempenoBadge`), que comparan contra un único promedio de referencia con un
 * margen fijo (±10pp / razón 0,8-1,2), acá la referencia es la posición relativa dentro de TODO
 * el grupo comparado. Terciles: percentil ≤33 bajo, ≥67 alto, medio en el resto. Empates
 * (mismo índice exacto) se resuelven al punto medio entre su primera y última posición en el
 * orden, para no favorecer arbitrariamente a uno de los empatados.
 */
export function derivarNivelesPorPercentil(indices: (number | null)[]): (ResultadoIndice | null)[] {
  const ordenados = [...indices].filter((v): v is number => v !== null).sort((a, b) => a - b);

  function percentilDe(valor: number): number {
    if (ordenados.length <= 1) return 50;
    const primero = ordenados.indexOf(valor);
    const ultimo = ordenados.lastIndexOf(valor);
    return ((primero + ultimo) / 2 / (ordenados.length - 1)) * 100;
  }

  return indices.map((indice) => {
    if (indice === null) return null;
    const percentil = percentilDe(indice);
    const tooltipBase = `Índice ${indice.toFixed(2)} — percentil ${percentil.toFixed(0)} dentro del grupo comparado.`;
    if (percentil >= 67) return { nivel: 'alto', etiqueta: 'Alto', tooltip: `${tooltipBase} Entre el tercio superior.` };
    if (percentil <= 33) return { nivel: 'bajo', etiqueta: 'Bajo', tooltip: `${tooltipBase} Entre el tercio inferior.` };
    return { nivel: 'medio', etiqueta: 'Medio', tooltip: `${tooltipBase} En el tercio intermedio.` };
  });
}

/**
 * Junta las dos funciones de arriba, agrupando las filas según `claveGrupo` antes de normalizar —
 * así una sola llamada sirve tanto para oficinas (`claveGrupo` fija, un solo grupo = todas) como
 * para empleados (`claveGrupo = coDependencia`, un grupo por oficina, ver §9: "misma oficina para
 * empleados, todas las oficinas del período para oficinas"). El resultado queda alineado con
 * `filas`, no con el orden de recorrido de los grupos.
 */
export function calcularIndicesYNiveles<T extends DimensionesIndice>(
  filas: T[],
  pesos: PesosIndice,
  claveGrupo: (fila: T) => string = () => '__todas__',
): { indice: number | null; nivel: ResultadoIndice | null }[] {
  const posicionesPorGrupo = new Map<string, number[]>();
  filas.forEach((fila, posicion) => {
    const clave = claveGrupo(fila);
    const lista = posicionesPorGrupo.get(clave) ?? [];
    lista.push(posicion);
    posicionesPorGrupo.set(clave, lista);
  });

  const resultado: { indice: number | null; nivel: ResultadoIndice | null }[] = filas.map(() => ({ indice: null, nivel: null }));

  for (const posiciones of posicionesPorGrupo.values()) {
    const subgrupo = posiciones.map((posicion) => filas[posicion]);
    const indices = calcularIndicesGlobales(subgrupo, pesos);
    const niveles = derivarNivelesPorPercentil(indices);
    posiciones.forEach((posicion, i) => {
      resultado[posicion] = { indice: indices[i], nivel: niveles[i] };
    });
  }

  return resultado;
}

const CLASE_POR_NIVEL: Record<NivelIndice, string> = {
  bajo: 'badge-anulado',
  medio: 'badge-pendiente',
  alto: 'badge-atendido',
};

export function IndiceGlobalBadge({ resultado }: { resultado: ResultadoIndice | null }) {
  if (!resultado) {
    return <span className="exp-nota" title="Sin tiempo promedio o sin emisiones en el período: no hay base para calcular el índice.">—</span>;
  }
  return (
    <span className={`badge ${CLASE_POR_NIVEL[resultado.nivel]}`} title={resultado.tooltip}>
      {resultado.etiqueta}
    </span>
  );
}
