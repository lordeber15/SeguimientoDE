/**
 * Fase 9 — qué mide cada indicador de "Por oficina"/"Por empleado", en lenguaje llano. Las
 * definiciones están tomadas de `docs/PLAN-DASHBOARD-DESEMPENO.md` §3 (ya redactadas y verificadas
 * contra la BD real ahí) para no desalinear la explicación de lo que ya está documentado.
 */
export type ClaveMetrica =
  | 'recibidos'
  | 'atendidos'
  | 'pendientes'
  | 'tasaAtencion'
  | 'tiempoPromedio'
  | 'indiceGlobal'
  | 'informativos'
  | 'tasaInformativos'
  | 'anulacion'
  | 'reproceso'
  | 'movimientosPorExpediente'
  | 'prodPonderada'
  | 'cargaPonderada'
  | 'columnaVertebral'
  | 'coberturaColumna'
  | 'rutaExacta'
  | 'espera'
  | 'trabajo'
  | 'objetivoPercentil'
  | 'backlogPendientes';

const DEFINICIONES: Record<ClaveMetrica, { termino: string; resumen: string; detalle?: string }> = {
  recibidos: {
    termino: 'Recibidos',
    resumen: 'Documentos recibidos en el período elegido, sin copias ni otros motivos informativos.',
  },
  atendidos: {
    termino: 'Atendidos',
    resumen: 'De los recibidos, los que ya tienen respuesta registrada o fueron archivados.',
  },
  pendientes: {
    termino: 'Pendientes',
    resumen: 'Recibidos menos atendidos.',
  },
  tasaAtencion: {
    termino: 'Tasa de atención',
    resumen: 'Atendidos ÷ recibidos, en porcentaje.',
    detalle:
      'El badge compara este número contra el promedio del grupo: Alto si está 10 puntos porcentuales o más por encima, Bajo si está 10 puntos o más por debajo, Medio en el resto (dentro de ±10 puntos).',
  },
  tiempoPromedio: {
    termino: 'Tiempo promedio',
    resumen: 'Horas promedio entre la recepción de un documento y la primera respuesta del mismo empleado.',
    detalle:
      'El badge compara este tiempo contra el promedio del grupo (menos es mejor): Alto si es 20% más rápido o más, Bajo si es 20% más lento o más, Medio en el resto.',
  },
  indiceGlobal: {
    termino: 'Índice global',
    resumen: 'Puntaje único que combina tasa de atención, tiempo de respuesta y tasa de anulación — más alto es mejor.',
    detalle:
      'Comparado contra otras oficinas/empleados de la misma categoría (institución o comité) en este período. El número no tiene una escala fija (puede ser negativo, ej. -0.16): el badge se define por la posición relativa dentro del grupo — Alto es el tercio superior, Bajo el tercio inferior, Medio el tercio del medio.',
  },
  informativos: {
    termino: 'Informativos',
    resumen: 'Copias, memorandos u otros documentos que no esperan respuesta — se cuentan aparte.',
  },
  tasaInformativos: {
    termino: 'Tasa inf.',
    resumen: 'Igual que la tasa de atención, pero solo sobre los documentos informativos.',
  },
  anulacion: {
    termino: 'Anulación',
    resumen: 'Porcentaje de lo emitido (no de lo recibido) que terminó anulado.',
  },
  reproceso: {
    termino: 'Reproceso',
    resumen: 'Expedientes en los que volvió a recibir el MISMO asunto.',
    detalle:
      'Es una señal aproximada, no una devolución confirmada. Recibir varias veces el mismo expediente con asuntos distintos no cuenta: eso es la circulación normal del trámite, no un retroceso. Un documento sin asunto tampoco cuenta, porque no hay con qué compararlo.',
  },
  movimientosPorExpediente: {
    termino: 'Mov./exped.',
    resumen: 'En promedio, cuántas veces circula cada expediente por esta oficina/empleado.',
  },
  prodPonderada: {
    termino: 'Prod. ponderada',
    resumen: 'Atendidos, pesados por la complejidad del tipo de documento.',
    detalle: 'Pesos definibles en la pestaña "Pesos por tipo". Con todos en 1 (valor por defecto), coincide con Atendidos.',
  },
  cargaPonderada: {
    termino: 'Carga ponderada',
    resumen: 'Igual idea que "Prod. ponderada", pero sobre Recibidos.',
  },
  columnaVertebral: {
    termino: 'Columna vertebral',
    resumen: 'El camino de oficinas por el que pasa MÁS gente dentro del proceso.',
    detalle:
      'Se calcula sobre el grafo completo de transiciones, no la secuencia exacta más repetida. Un expediente puede dar rodeos (una consulta, una devolución) y de todas formas contar como que "siguió" la columna, siempre que pase por sus etapas en el orden correcto.',
  },
  coberturaColumna: {
    termino: 'Cobertura de la columna',
    resumen: 'Porcentaje de expedientes de este proceso que efectivamente recorren la columna vertebral, en orden.',
    detalle: 'Con o sin rodeos intermedios. Suele ser mucho más alta que la cobertura de la ruta exacta.',
  },
  rutaExacta: {
    termino: 'Ruta exacta',
    resumen: 'La secuencia de oficinas idéntica, paso a paso, que más se repite.',
    detalle:
      'Casi siempre cubre mucho menos que la columna vertebral: pequeñas variaciones (una consulta de más, un orden distinto) ya cuentan como una ruta distinta.',
  },
  espera: {
    termino: 'Espera',
    resumen: 'Tiempo entre que el documento llega y alguien lo abre — tiempo de cola, no de trabajo.',
  },
  trabajo: {
    termino: 'Trabajo',
    resumen: 'Tiempo entre que abren el documento y emiten la respuesta.',
  },
  objetivoPercentil: {
    termino: 'Objetivo de la propuesta',
    resumen: 'El percentil bajo (10 por defecto) del tiempo de esa misma tarea en todas las oficinas que la hacen.',
    detalle:
      'Misma tarea = mismo motivo de derivación y mismo tipo de documento. No es el mínimo absoluto, que suele ser un caso atípico. Sin muestra suficiente en ese universo, se usa en cambio el propio mejor cuartil de la oficina.',
  },
  backlogPendientes: {
    termino: 'Pendientes (backlog)',
    resumen: 'Recibidos que siguen sin respuesta HOY, sin límite de cuándo llegaron — distinto del "Pendientes" de "Por oficina"/"Por empleado", que sí se acota al período elegido.',
    detalle:
      'No cuenta los documentos informativos (copia, para conocimiento y fines, circular) ni los que quedaron abiertos en un expediente que después se archivó: en ambos casos ya no hay respuesta que esperar. Los buckets (0-7, 8-30, 31+ días) miden la antigüedad contra el momento actual, no contra un rango fijo.',
  },
};

/** Colapsado por defecto (`<details>` nativo, sin JS ni estado propio) para no volver a sumar
 *  clutter vertical después de la reducción de columnas de Fase 6 — la explicación queda a un
 *  clic, no siempre visible. */
export function GlosarioMetricas({ claves }: { claves: ClaveMetrica[] }) {
  return (
    <details className="glosario">
      <summary>Qué mide cada indicador</summary>
      <dl className="glosario-lista">
        {claves.map((clave) => {
          const { termino, resumen, detalle } = DEFINICIONES[clave];
          return (
            <div key={clave}>
              <dt>{termino}</dt>
              <dd>
                <strong>{resumen}</strong>
                {detalle && (
                  <details className="glosario-detalle">
                    <summary>Más detalle</summary>
                    <p>{detalle}</p>
                  </details>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </details>
  );
}
