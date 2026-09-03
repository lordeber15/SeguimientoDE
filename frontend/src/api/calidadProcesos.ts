import { apiJson } from './cliente';

/** Cada extremo es OPCIONAL e independiente (mismo patrón que `FiltroResumen` del dashboard):
 *  sin ninguno, se ve todo el histórico; con uno solo, el rango queda abierto de ese lado. */
export interface FiltroProcesos {
  desde?: string;
  hasta?: string;
  coDependencia?: string;
  /** Por defecto `true` en el backend: un expediente a medio camino tiene la ruta truncada y
   *  ensucia el cálculo de la columna vertebral. */
  soloCerrados?: boolean;
}

function construirParams(filtro: FiltroProcesos): URLSearchParams {
  const params = new URLSearchParams();
  if (filtro.desde) params.set('desde', filtro.desde);
  if (filtro.hasta) params.set('hasta', filtro.hasta);
  if (filtro.coDependencia) params.set('coDependencia', filtro.coDependencia);
  if (filtro.soloCerrados === false) params.set('soloCerrados', 'false');
  return params;
}

export interface ResumenProceso {
  clave: string;
  nombre: string;
  /** `true` si alguien lo renombró a mano (`PUT .../nombre`) — la tabla lo muestra distinto del
   *  nombre automático descubierto por el agrupamiento. */
  renombrado: boolean;
  expedientes: number;
  pasosPromedio: number | null;
  duracionMedianaHoras: number | null;
  nodosColumna: number;
  /** % de expedientes que recorren la columna vertebral en orden — la lectura principal de cuánto
   *  representa el flujograma. */
  coberturaColumna: number | null;
  /** % que sigue la ruta EXACTA más repetida — casi siempre mucho más bajo que `coberturaColumna`;
   *  se muestra junto para que quede claro por qué se usa la columna y no la ruta exacta. */
  coberturaRutaExacta: number | null;
}

export function fetchProcesos(filtro: FiltroProcesos): Promise<ResumenProceso[]> {
  return apiJson(`/api/calidad-procesos/procesos?${construirParams(filtro)}`, 'listar los procesos detectados');
}

export interface NodoFlujo {
  orden: number;
  coDependencia: string;
  nombreDependencia: string;
  expedientes: number;
  cobertura: number;
  visitas: number;
  medianaHoras: number | null;
  p25Horas: number | null;
  p75Horas: number | null;
  esperaMedianaHoras: number | null;
  trabajoMedianaHoras: number | null;
  motivos: { codigo: string | null; visitas: number }[];
  /** Desglose por persona dentro del nodo — lo que se ve al expandirlo. Hasta 8, ordenado por
   *  visitas descendente. */
  porEmpleado: { coEmpleado: string; nombre: string | null; visitas: number; medianaHoras: number | null }[];
}

export interface PasoOpcional {
  coDependencia: string;
  nombreDependencia: string;
  expedientes: number;
  cobertura: number;
  medianaHoras: number | null;
  p25Horas: number | null;
}

export interface FlujoProceso {
  clave: string;
  nombre: string;
  expedientes: number;
  columna: NodoFlujo[];
  coberturaColumna: number | null;
  rutaExacta: { oficinas: string[]; expedientes: number; cobertura: number } | null;
  rutasDistintas: number;
  /** Oficinas por las que pasa una parte relevante de los expedientes (≥3%) pero que no entran en
   *  la columna vertebral — p. ej. la conformidad técnica de un pago de consultoría, repartida
   *  entre varias oficinas alternativas sin que ninguna sola sea mayoría. Se muestran aparte del
   *  diagrama (decisión explícita: no complicar la cadena principal). */
  opcionales: PasoOpcional[];
}

export function fetchFlujoProceso(clave: string, filtro: FiltroProcesos): Promise<FlujoProceso> {
  return apiJson(
    `/api/calidad-procesos/procesos/${encodeURIComponent(clave)}/flujo?${construirParams(filtro)}`,
    'calcular el flujo del proceso',
  );
}

export interface PasoPropuesta {
  orden: number;
  coDependencia: string;
  nombreDependencia: string;
  actualMedianaHoras: number | null;
  objetivoHoras: number | null;
  /** De dónde sale el objetivo: `'comparable'` (percentil del universo entre todas las oficinas
   *  que hacen la misma tarea) o `'propio'` (sin muestra suficiente, el propio mejor cuartil de
   *  esta oficina) — la UI debe decirlo, no mostrar el número solo. */
  origenObjetivo: 'comparable' | 'propio' | null;
  mejorOficina: { coDependencia: string; nombreDependencia: string; medianaHoras: number } | null;
  minimoObservadoHoras: number | null;
  muestra: number;
  ahorroHoras: number | null;
}

export interface Propuesta {
  clave: string;
  nombre: string;
  percentilObjetivo: number;
  pasos: PasoPropuesta[];
  totalActualHoras: number | null;
  totalPropuestoHoras: number | null;
  ahorroHoras: number | null;
  ahorroPorcentaje: number | null;
}

export function fetchPropuestaProceso(clave: string, filtro: FiltroProcesos): Promise<Propuesta> {
  return apiJson(
    `/api/calidad-procesos/procesos/${encodeURIComponent(clave)}/propuesta?${construirParams(filtro)}`,
    'calcular la propuesta de mejora',
  );
}

/** Requiere `dashboard.gestionar` (se reutiliza, mismo criterio que los pesos por tipo de
 *  documento del dashboard) — renombrar una familia cambia lo que ve todo el mundo. */
export function renombrarProceso(clave: string, nombre: string): Promise<{ ok: true }> {
  return apiJson(`/api/calidad-procesos/procesos/${encodeURIComponent(clave)}/nombre`, 'renombrar el proceso', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre }),
  });
}
