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
  | 'objetivoPercentil';

const DEFINICIONES: Record<ClaveMetrica, { termino: string; definicion: string }> = {
  recibidos: {
    termino: 'Recibidos',
    definicion:
      'Documentos recibidos en el período elegido (o en todo el histórico, si no se puso fecha) — sin contar copias ni otros motivos informativos.',
  },
  atendidos: {
    termino: 'Atendidos',
    definicion:
      'De los recibidos, cuántos ya tienen respuesta registrada o fueron archivados según el estado del SGD.',
  },
  pendientes: {
    termino: 'Pendientes',
    definicion: 'Recibidos menos atendidos — lo que todavía sigue sin resolver.',
  },
  tasaAtencion: {
    termino: 'Tasa de atención',
    definicion:
      'Atendidos ÷ recibidos, en porcentaje — qué proporción de lo recibido ya se resolvió. El badge compara este número contra el promedio del grupo: Alto si está 10 puntos porcentuales o más por encima, Bajo si está 10 puntos o más por debajo, Medio en el resto (dentro de ±10 puntos).',
  },
  tiempoPromedio: {
    termino: 'Tiempo promedio',
    definicion:
      'Horas promedio entre la recepción de un documento y la primera respuesta del mismo empleado en ese expediente. El badge compara este tiempo contra el promedio del grupo (menos es mejor): Alto si es 20% más rápido o más, Bajo si es 20% más lento o más, Medio en el resto.',
  },
  indiceGlobal: {
    termino: 'Índice global',
    definicion:
      'Puntaje único que combina tasa de atención, tiempo de respuesta y tasa de anulación, comparado contra otras oficinas/empleados de la misma categoría (institución o comité) en este período — más alto es mejor. El número en sí no tiene una escala fija (puede ser negativo, ej. -0.16): lo que define el badge es la posición relativa dentro del grupo comparado — Alto es el tercio superior, Bajo el tercio inferior, Medio el tercio del medio.',
  },
  informativos: {
    termino: 'Informativos',
    definicion:
      'Copias, memorandos "para conocimiento", circulares u otros documentos que no esperan respuesta — se cuentan aparte para no penalizar a quien recibe muchas copias.',
  },
  tasaInformativos: {
    termino: 'Tasa inf.',
    definicion: 'Igual que la tasa de atención, pero calculada solo sobre los documentos informativos.',
  },
  anulacion: {
    termino: 'Anulación',
    definicion: 'Porcentaje de lo EMITIDO por esta oficina/empleado que terminó anulado — no de lo recibido.',
  },
  reproceso: {
    termino: 'Reproceso',
    definicion:
      'Porcentaje de los expedientes que trabajó en los que volvió a recibir el MISMO asunto — una señal aproximada, no una devolución confirmada. Recibir varias veces el mismo expediente con asuntos distintos no cuenta: eso es la circulación normal del trámite, no un retroceso. Un documento sin asunto tampoco cuenta, porque no hay con qué compararlo.',
  },
  movimientosPorExpediente: {
    termino: 'Mov./exped.',
    definicion: 'En promedio, cuántas veces circula cada expediente por esta oficina/empleado.',
  },
  prodPonderada: {
    termino: 'Prod. ponderada',
    definicion:
      'Atendidos pesados por la complejidad del tipo de documento (pestaña "Pesos por tipo"), en vez de contar 1 por documento. Con todos los pesos en 1 (valor por defecto), coincide con Atendidos.',
  },
  cargaPonderada: {
    termino: 'Carga ponderada',
    definicion:
      'Igual idea que "Prod. ponderada", pero sobre Recibidos: cuánto entró, pesado por complejidad, en vez de cuánto se resolvió.',
  },
  columnaVertebral: {
    termino: 'Columna vertebral',
    definicion:
      'El camino de oficinas por el que pasa MÁS gente dentro del proceso, calculado sobre el grafo completo de transiciones — no la secuencia exacta más repetida. Un expediente puede dar rodeos (una consulta, una devolución) y de todas formas contar como que "siguió" la columna, siempre que pase por sus etapas en el orden correcto.',
  },
  coberturaColumna: {
    termino: 'Cobertura de la columna',
    definicion:
      'Porcentaje de expedientes de este proceso que efectivamente recorren la columna vertebral, en orden (con o sin rodeos intermedios). Suele ser mucho más alta que la cobertura de la ruta exacta.',
  },
  rutaExacta: {
    termino: 'Ruta exacta',
    definicion:
      'La secuencia de oficinas idéntica, paso a paso, que más se repite. Casi siempre cubre mucho menos que la columna vertebral: pequeñas variaciones (una consulta de más, un orden distinto) ya cuentan como una ruta distinta.',
  },
  espera: {
    termino: 'Espera',
    definicion:
      'Dentro de una oficina, el tiempo entre que el documento llega y alguien lo abre (registrado en el SGD). Es tiempo de cola, no de trabajo.',
  },
  trabajo: {
    termino: 'Trabajo',
    definicion: 'Dentro de una oficina, el tiempo entre que abren el documento y emiten la respuesta.',
  },
  objetivoPercentil: {
    termino: 'Objetivo de la propuesta',
    definicion:
      'El percentil bajo (por defecto, el 10) del tiempo que toma esa misma tarea (mismo motivo de derivación y mismo tipo de documento) en TODAS las oficinas que la hacen — no el mínimo absoluto, que suele ser un caso atípico. Sin muestra suficiente en ese universo, se usa en cambio el propio mejor cuartil de la oficina.',
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
          const { termino, definicion } = DEFINICIONES[clave];
          return (
            <div key={clave}>
              <dt>{termino}</dt>
              <dd>{definicion}</dd>
            </div>
          );
        })}
      </dl>
    </details>
  );
}
