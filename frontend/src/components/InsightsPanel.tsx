import { calcularIndicesYNiveles, PESOS_INDICE_OFICINA } from './IndiceGlobalBadge';
import type { KpiEmpleado, KpiOficina } from '../api/dashboard';

export type CategoriaConclusion = 'carga' | 'calidad' | 'complejidad' | 'tendencia';
export type TonoConclusion = 'positivo' | 'negativo' | 'neutral';

export interface Conclusion {
  /** Clave estable para listas — no un índice de array, que cambiaría si el orden se reordena. */
  id: string;
  categoria: CategoriaConclusion;
  tono: TonoConclusion;
  mensaje: string;
}

/** Cuánta carga de más, respecto al promedio de SU oficina, se considera digna de mención —
 *  mismo umbral propuesto en PLAN-DASHBOARD-DESEMPENO.md §9 al diseñar esta regla. */
const UMBRAL_CARGA_ALTA = 1.35;
/** "Top/bottom 25%" de las reglas de productividad/complejidad — percentil, no z-score: no hace
 *  falta asumir una distribución, alcanza con la posición relativa dentro del grupo cargado. */
const PERCENTIL_ALTO = 0.75;
const PERCENTIL_BAJO = 0.25;
/** Diferencia mínima de índice global (Fase 4) entre períodos para hablar de una tendencia real,
 *  no ruido — con desvío ~1 tras el z-score, 0.3 es aproximadamente un tercio de un desvío estándar. */
const UMBRAL_TENDENCIA = 0.3;

function media(valores: number[]): number {
  return valores.reduce((a, b) => a + b, 0) / valores.length;
}

/** Percentil (0-1) de `valor` dentro de `ordenados` (ya ordenado ascendente) — empates resueltos
 *  al punto medio entre su primera y última posición, mismo criterio que `IndiceGlobalBadge`. */
function percentilDe(valor: number, ordenados: number[]): number {
  if (ordenados.length <= 1) return 0.5;
  const primero = ordenados.indexOf(valor);
  const ultimo = ordenados.lastIndexOf(valor);
  return (primero + ultimo) / 2 / (ordenados.length - 1);
}

function formatearPorcentaje(valor: number): string {
  return `${(valor * 100).toFixed(0)}%`;
}

/**
 * Motor de insights (Fase 5) — función pura, sin BD ni red: evalúa reglas de negocio sobre KPIs
 * ya calculados en las Fases 1-4, exactamente igual que `IndiceGlobalBadge`/`NivelDesempenoBadge`
 * (mismo patrón "función pura + componente", testeable sin backend).
 *
 * Cubre 4 de las 5 reglas propuestas en PLAN-DASHBOARD-DESEMPENO.md §9. La quinta —"cuello de
 * botella en la etapa Y"— depende de datos que todavía no existen (tiempo por etapa agregado a
 * través de expedientes, ver §11 "Cuellos de botella por etapa") y se deja fuera a propósito, no
 * por descuido: no hay nada que evaluar sin esa pieza.
 *
 * `oficinasPeriodoAnterior` es opcional: si no se pasa (o viene vacío), la regla de tendencia
 * simplemente no aporta ninguna conclusión — no es un error, es "todavía no se pidió ese dato".
 */
export function generarConclusiones(datos: {
  oficinas: KpiOficina[];
  empleados: KpiEmpleado[];
  oficinasPeriodoAnterior?: KpiOficina[];
}): Conclusion[] {
  // Cada regla acompaña su conclusión con una `severidad` — el mismo número que ya muestra su
  // propio mensaje, no uno nuevo — para poder ordenar de más a menos grave dentro de cada
  // categoría (Fase 7: la UI filtra por categoría en sub-pestañas, así que un solo orden global
  // por severidad alcanza para que cada subconjunto quede bien ordenado). No es parte del tipo
  // público `Conclusion`: es un detalle de este ordenamiento, no algo que la UI necesite leer.
  const resultados: { conclusion: Conclusion; severidad: number }[] = [];

  // ── Carga alta: recibidos EXTERNOS del empleado vs promedio de los RECIBIDOS EXTERNOS de su
  // propia oficina ── (el promedio de "su oficina" es entre sus compañeros, no
  // `KpiOficina.recibidos` — ese es el TOTAL de la oficina, no un promedio por persona).
  //
  // Fase 8: se usa `recibidosExternos`, no `recibidos` a secas — un jefe que deriva un expediente
  // y luego recibe la respuesta de su propia oficina (`recibidosMismaOficina`) no está recibiendo
  // trabajo nuevo de afuera, así que esa vuelta no debería inflarle la "carga".
  const empleadosPorOficina = new Map<string, KpiEmpleado[]>();
  for (const e of datos.empleados) {
    const lista = empleadosPorOficina.get(e.coDependencia) ?? [];
    lista.push(e);
    empleadosPorOficina.set(e.coDependencia, lista);
  }
  for (const e of datos.empleados) {
    const companeros = empleadosPorOficina.get(e.coDependencia) ?? [];
    if (companeros.length < 2) continue; // sin con quién comparar dentro de la misma oficina
    const promedio = media(companeros.map((c) => c.recibidosExternos));
    if (promedio <= 0) continue;
    const razon = e.recibidosExternos / promedio;
    if (razon > UMBRAL_CARGA_ALTA) {
      const nombre = e.nombreCompleto ?? `empleado ${e.coEmpleado}`;
      const oficina = e.nombreDependencia ?? e.coDependencia;
      resultados.push({
        severidad: (razon - 1) * 100,
        conclusion: {
          id: `carga-${e.coEmpleado}-${e.coDependencia}`,
          categoria: 'carga',
          tono: 'negativo',
          mensaje: `${nombre} tiene una carga ${Math.round((razon - 1) * 100)}% superior al promedio de ${oficina} (${e.recibidosExternos} recibidos de otras áreas vs. ${promedio.toFixed(1)} en promedio).`,
        },
      });
    }
  }

  // ── Alta productividad pero alto reproceso, a la vez — comparado contra TODOS los empleados
  // cargados, no solo los de su oficina: acá interesa destacar quién resalta en el conjunto ──
  const conReproceso = datos.empleados.filter((e) => e.tasaReproceso !== null);
  if (conReproceso.length >= 4) {
    const atendidosOrdenados = datos.empleados.map((e) => e.atendidos).sort((a, b) => a - b);
    const reprocesoOrdenados = conReproceso.map((e) => e.tasaReproceso!).sort((a, b) => a - b);
    for (const e of conReproceso) {
      const pctAtendidos = percentilDe(e.atendidos, atendidosOrdenados);
      const pctReproceso = percentilDe(e.tasaReproceso!, reprocesoOrdenados);
      if (pctAtendidos >= PERCENTIL_ALTO && pctReproceso >= PERCENTIL_ALTO) {
        const nombre = e.nombreCompleto ?? `empleado ${e.coEmpleado}`;
        resultados.push({
          severidad: e.tasaReproceso!,
          conclusion: {
            id: `reproceso-${e.coEmpleado}-${e.coDependencia}`,
            categoria: 'calidad',
            tono: 'neutral',
            mensaje: `${nombre} tiene alta productividad (${e.atendidos} atendidos, entre los más altos) pero también una tasa de reproceso superior a la mayoría (${formatearPorcentaje(e.tasaReproceso!)}).`,
          },
        });
      }
    }
  }

  // ── Baja productividad explicada por alta complejidad promedio (Fase 3) — mismo grupo de
  // comparación (todos los empleados cargados) que la regla anterior ──
  const conRecibidos = datos.empleados.filter((e) => e.recibidos > 0);
  if (conRecibidos.length >= 4) {
    const atendidosOrdenados = datos.empleados.map((e) => e.atendidos).sort((a, b) => a - b);
    const complejidades = conRecibidos.map((e) => e.cargaPonderada / e.recibidos);
    const complejidadesOrdenadas = [...complejidades].sort((a, b) => a - b);
    conRecibidos.forEach((e, i) => {
      const pctAtendidos = percentilDe(e.atendidos, atendidosOrdenados);
      const pctComplejidad = percentilDe(complejidades[i], complejidadesOrdenadas);
      if (pctAtendidos <= PERCENTIL_BAJO && pctComplejidad >= PERCENTIL_ALTO) {
        const nombre = e.nombreCompleto ?? `empleado ${e.coEmpleado}`;
        resultados.push({
          severidad: complejidades[i],
          conclusion: {
            id: `complejidad-${e.coEmpleado}-${e.coDependencia}`,
            categoria: 'complejidad',
            tono: 'neutral',
            mensaje: `${nombre} tiene pocos atendidos (${e.atendidos}, entre los más bajos) pero recibe documentos de complejidad superior al resto (peso promedio ${complejidades[i].toFixed(2)}) — podría explicar parte de la diferencia.`,
          },
        });
      }
    });
  }

  // ── Tendencia del índice global (Fase 4) por oficina, contra el mismo largo de período
  // inmediatamente anterior ──
  if (datos.oficinasPeriodoAnterior && datos.oficinasPeriodoAnterior.length > 0) {
    const indicesActuales = calcularIndicesYNiveles(datos.oficinas, PESOS_INDICE_OFICINA);
    const indicesAnteriores = calcularIndicesYNiveles(datos.oficinasPeriodoAnterior, PESOS_INDICE_OFICINA);
    const indiceAnteriorPorOficina = new Map(
      datos.oficinasPeriodoAnterior.map((o, i) => [o.coDependencia, indicesAnteriores[i].indice]),
    );

    datos.oficinas.forEach((o, i) => {
      const actual = indicesActuales[i].indice;
      const anterior = indiceAnteriorPorOficina.get(o.coDependencia);
      if (actual === null || anterior === null || anterior === undefined) return;

      const diferencia = actual - anterior;
      if (diferencia >= UMBRAL_TENDENCIA) {
        resultados.push({
          severidad: Math.abs(diferencia),
          conclusion: {
            id: `tendencia-${o.coDependencia}`,
            categoria: 'tendencia',
            tono: 'positivo',
            mensaje: `${o.nombreDependencia ?? o.coDependencia} mejoró su índice global de ${anterior.toFixed(2)} a ${actual.toFixed(2)} respecto al período anterior de igual duración.`,
          },
        });
      } else if (diferencia <= -UMBRAL_TENDENCIA) {
        resultados.push({
          severidad: Math.abs(diferencia),
          conclusion: {
            id: `tendencia-${o.coDependencia}`,
            categoria: 'tendencia',
            tono: 'negativo',
            mensaje: `${o.nombreDependencia ?? o.coDependencia} empeoró su índice global de ${anterior.toFixed(2)} a ${actual.toFixed(2)} respecto al período anterior de igual duración.`,
          },
        });
      }
    });
  }

  // Fase 7: dentro de cada categoría (la UI filtra por una a la vez, ver DashboardPage.tsx), el
  // caso más grave primero — no hace falta un sort por categoría aparte, filtrar sobre este orden
  // ya deja cada subconjunto ordenado por su propia severidad.
  return resultados.sort((a, b) => b.severidad - a.severidad).map((r) => r.conclusion);
}

/** Fase 7 — exportado: única fuente de verdad para la etiqueta de cada categoría, tanto para las
 *  sub-pestañas de `DashboardPage.tsx` como (antes de Fase 7) para el rótulo por fila. */
export const ETIQUETA_POR_CATEGORIA: Record<CategoriaConclusion, string> = {
  carga: 'Carga laboral',
  calidad: 'Calidad',
  complejidad: 'Complejidad',
  tendencia: 'Tendencia',
};

/**
 * Fase 7 — `conclusiones` ya viene filtrada a UNA sola categoría (`DashboardPage.tsx` la filtra
 * antes de pasarla, con sub-pestañas por categoría) — por eso ya no repite la etiqueta de
 * categoría en cada fila, la sub-pestaña activa la dice una sola vez. El mensaje de "vacío" es
 * genérico: puede aparecer con otras categorías teniendo hallazgos, no solo cuando no hay nada.
 */
export function InsightsPanel({ conclusiones }: { conclusiones: Conclusion[] }) {
  if (conclusiones.length === 0) {
    return <div className="state-message">Sin hallazgos en esta categoría en este período.</div>;
  }

  return (
    <ul className="insights-lista">
      {conclusiones.map((c) => (
        <li key={c.id} className={`insights-item insights-item--${c.tono}`}>
          {c.mensaje}
        </li>
      ))}
    </ul>
  );
}
