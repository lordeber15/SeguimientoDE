import { apiJson } from './cliente';

/** Campos de calidad y carga (Fase 2) — mismos en la fila de oficina y en la de empleado. */
interface KpiCalidad {
  /** Motivos donde no se espera devolución (COPIA, INFORMAR, PARA CONOCIMIENTO…), aparte de
   *  `recibidos`/`atendidos`/`tasaAtencion`. */
  recibidosInformativos: number;
  atendidosInformativos: number;
  pendientesInformativos: number;
  tasaAtencionInformativos: number;
  expedientesDistintos: number;
  movimientos: number;
  movimientosPromedioPorExpediente: number | null;
  gruposEmpleadoExpediente: number;
  gruposReprocesados: number;
  tasaReproceso: number | null;
  emitidos: number;
  anulados: number;
  tasaAnulacion: number | null;
}

export interface KpiEmpleado extends KpiCalidad {
  coEmpleado: string;
  nombreCompleto: string | null;
  coDependencia: string;
  nombreDependencia: string | null;
  /** Fase 6 — ver `KpiOficina`. */
  esComite: boolean;
  recibidos: number;
  /** Fase 8 — de `recibidos`, cuánto vino de OTRA oficina (`co_dep_emi <> co_dep_des`, o el origen
   *  no se pudo determinar). Ver `recibidosMismaOficina`. */
  recibidosExternos: number;
  /** Recibido cuyo emisor es la MISMA oficina de destino — típicamente la respuesta que la propia
   *  oficina se manda a sí misma dentro de un expediente que ella misma impulsó, no carga nueva. */
  recibidosMismaOficina: number;
  atendidos: number;
  pendientes: number;
  tasaAtencion: number;
  tiempoPromedioHoras: number | null;
  tiempoMedianoHoras: number | null;
  tiempoPromedioHabilHoras: number | null;
  /** Fase 3 — ver `KpiOficina`. */
  productividadPonderada: number;
  cargaPonderada: number;
}

export interface KpiOficina extends KpiCalidad {
  coDependencia: string;
  nombreDependencia: string | null;
  /** Fase 6 — `true` si es un comité de evaluación (`TI_DEPENDENCIA = '1'` en la fuente), `false`
   *  si es una oficina/unidad institucional permanente. Verificado contra la BD real 2026-08-31:
   *  separación limpia entre 20 dependencias institucionales y 47 comités. */
  esComite: boolean;
  recibidos: number;
  /** Fase 8 — ver `KpiEmpleado`. */
  recibidosExternos: number;
  recibidosMismaOficina: number;
  atendidos: number;
  pendientes: number;
  tasaAtencion: number;
  tiempoPromedioHoras: number | null;
  tiempoMedianoHoras: number | null;
  tiempoPromedioHabilHoras: number | null;
  /** Fase 3 — `atendidos`/`recibidos` pesados por complejidad del tipo de documento (pestaña
   *  "Pesos", requiere `dashboard.gestionar`). Con todos los pesos en 1 coincide con
   *  `atendidos`/`recibidos`. */
  productividadPonderada: number;
  cargaPonderada: number;
}

export interface FiltroResumen {
  /** `YYYY-MM-DD`. Cada extremo es OPCIONAL e independiente del otro (Fase 9): sin ninguno, la
   *  consulta es sobre todo el histórico; con uno solo, el rango queda abierto de ese lado. */
  desde?: string;
  hasta?: string;
  coDependencia?: string;
  tipoDocumento?: string;
}

function construirParams(filtro: FiltroResumen | FiltroPendientes): URLSearchParams {
  const params = new URLSearchParams();
  if ('desde' in filtro && filtro.desde) params.set('desde', filtro.desde);
  if ('hasta' in filtro && filtro.hasta) params.set('hasta', filtro.hasta);
  if (filtro.coDependencia) params.set('coDependencia', filtro.coDependencia);
  if (filtro.tipoDocumento) params.set('tipoDocumento', filtro.tipoDocumento);
  return params;
}

/** Se pide en cada carga del dashboard: tarjetas, gráficos y referencia de los badges. */
export function fetchDesempenoOficinas(filtro: FiltroResumen): Promise<KpiOficina[]> {
  return apiJson(`/api/dashboard/oficinas?${construirParams(filtro)}`, 'calcular el desempeño por oficina');
}

/** Agregación más cara: se pide solo al abrir la pestaña "Por empleado". */
export function fetchDesempenoEmpleados(filtro: FiltroResumen): Promise<KpiEmpleado[]> {
  return apiJson(`/api/dashboard/empleados?${construirParams(filtro)}`, 'calcular el desempeño por empleado');
}

export interface TipoDocumento {
  codigo: string;
  descripcion: string | null;
}

export function fetchTiposDocumento(): Promise<TipoDocumento[]> {
  return apiJson('/api/dashboard/tipos-documento', 'obtener los tipos de documento');
}

/** Sin `desde`/`hasta` a propósito: mide el backlog vigente HOY, no lo recibido en un período —
 *  ver `pendientesAntiguosPorOficina` en el backend. */
export interface FiltroPendientes {
  coDependencia?: string;
  tipoDocumento?: string;
}

export interface PendientesAntiguos {
  coDependencia: string;
  nombreDependencia: string | null;
  pendientes: number;
  pendientes0a7: number;
  pendientes8a30: number;
  pendientes31Mas: number;
  diasPendienteMasAntiguo: number | null;
}

/** Carga laboral (Fase 2): se pide solo al abrir la pestaña "Pendientes", igual que "Por
 *  empleado" — ignora el rango de fechas del filtro común, solo respeta oficina/tipo. */
export function fetchPendientesOficinas(filtro: FiltroPendientes): Promise<PendientesAntiguos[]> {
  return apiJson(
    `/api/dashboard/pendientes/oficinas?${construirParams(filtro)}`,
    'calcular los pendientes antiguos',
  );
}

/** Todos los indicadores del dashboard salen de un espejo local, refrescado periódicamente en
 *  background — no en vivo contra el SGD. Esto es lo que alimenta la nota "Datos actualizados
 *  hace X min". */
export interface EstadoResumen {
  ultimoRefresco: string | null;
  minutosDesde: number | null;
  participaciones: number;
  ultimoError: string | null;
}

export function fetchResumenEstado(): Promise<EstadoResumen> {
  return apiJson('/api/dashboard/resumen/estado', 'obtener el estado del espejo del dashboard');
}

export interface ResultadoRefresco {
  id: number;
  participaciones: number;
  emisiones: number;
  msSgd: number;
  msTotal: number;
}

/** Requiere `dashboard.gestionar` — tarda 8-10 s (consulta completa contra el SGD), no es una
 *  operación para cualquiera con acceso de solo lectura. */
export function refrescarResumenAhora(): Promise<ResultadoRefresco> {
  return apiJson('/api/dashboard/resumen/refrescar', 'refrescar el espejo del dashboard', { method: 'POST' });
}

/**
 * Fase 3 — complejidad documental configurable. `pesoSugerido` es `null` cuando el tipo no tiene
 * muestra suficiente de atendidos (ver `dashboardPesosService.listarPesos` en el backend) — la
 * pantalla debe mostrar eso como "sin sugerencia", no como 0 ni omitir la fila.
 */
export interface PesoTipoDocumento {
  coTipDoc: string;
  descripcion: string | null;
  peso: number;
  pesoSugerido: number | null;
  muestraAtendidos: number;
  medianaHoras: number | null;
  actualizadoPor: string | null;
  feActualizado: string | null;
}

/** Requiere `dashboard.gestionar` — trae la muestra/mediana/sugerencia de cada tipo, no solo el
 *  peso vigente (ese sí viaja dentro de cada fila de oficina/empleado con solo `dashboard.ver`). */
export function fetchPesosTipoDocumento(): Promise<PesoTipoDocumento[]> {
  return apiJson('/api/dashboard/pesos', 'obtener los pesos por tipo de documento');
}

export function guardarPesoTipoDocumento(coTipDoc: string, peso: number): Promise<{ ok: true }> {
  return apiJson(`/api/dashboard/pesos/${encodeURIComponent(coTipDoc)}`, 'guardar el peso del tipo de documento', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peso }),
  });
}
