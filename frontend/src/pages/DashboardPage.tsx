import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  fetchDesempenoEmpleados,
  fetchDesempenoOficinas,
  fetchPendientesOficinas,
  fetchPesosTipoDocumento,
  fetchResumenEstado,
  fetchTiposDocumento,
  guardarPesoTipoDocumento,
  refrescarResumenAhora,
  type BucketPendientes,
  type EstadoResumen,
  type FiltroResumen,
  type KpiEmpleado,
  type KpiOficina,
  type PendientesAntiguos,
  type PesoTipoDocumento,
  type TipoDocumento,
} from '../api/dashboard';
import { fetchDependencias, type Dependencia } from '../api/dependencias';
import { useSesion } from '../auth/SesionContext';
import {
  calcularIndicesYNiveles,
  IndiceGlobalBadge,
  PESOS_INDICE_EMPLEADO,
  PESOS_INDICE_OFICINA,
  type ResultadoIndice,
} from '../components/IndiceGlobalBadge';
import { GlosarioMetricas, type ClaveMetrica } from '../components/GlosarioMetricas';
import {
  ETIQUETA_POR_CATEGORIA,
  generarConclusiones,
  InsightsPanel,
  type CategoriaConclusion,
  type Conclusion,
} from '../components/InsightsPanel';
import {
  derivarNivelPorTasaAtencion,
  derivarNivelPorTiempo,
  NivelDesempenoBadge,
} from '../components/NivelDesempenoBadge';
import { idPanel, idPestana, Pestanas } from '../components/Pestanas';
import { ModalPendientesDetalle } from '../components/ModalPendientesDetalle';
import { TableSkeleton } from '../components/TableSkeleton';
import { VisorDocumento } from '../components/VisorDocumento';

type EstadoOficinas =
  | { tipo: 'cargando' }
  | { tipo: 'error'; mensaje: string }
  | { tipo: 'listo'; datos: KpiOficina[] };

/**
 * El estado de los empleados lleva dentro la **clave del filtro** con la que se pidió: es lo que
 * permite saber, sin pedir nada, si lo que hay en memoria todavía corresponde a los filtros
 * actuales. `ocioso` = nunca se pidió para esta clave.
 */
type EstadoEmpleados =
  | { tipo: 'ocioso' }
  | { tipo: 'cargando'; clave: string }
  | { tipo: 'error'; clave: string; mensaje: string }
  | { tipo: 'listo'; clave: string; datos: KpiEmpleado[] };

/** Misma forma que `EstadoEmpleados`, pero con su propia clave: la pestaña "Pendientes" (Fase 2)
 *  ignora el rango de fechas, así que un cambio de `desde`/`hasta` NO debe invalidarla. */
type EstadoPendientes =
  | { tipo: 'ocioso' }
  | { tipo: 'cargando'; clave: string }
  | { tipo: 'error'; clave: string; mensaje: string }
  | { tipo: 'listo'; clave: string; datos: PendientesAntiguos[] };

/** Pesos por tipo de documento (Fase 3) — sin clave de filtro: no depende de ningún filtro del
 *  dashboard, solo se pide una vez al abrir la pestaña (y de nuevo tras guardar un peso). */
type EstadoPesos =
  | { tipo: 'ocioso' }
  | { tipo: 'cargando' }
  | { tipo: 'error'; mensaje: string }
  | { tipo: 'listo'; datos: PesoTipoDocumento[] };

/**
 * Oficinas del período INMEDIATAMENTE ANTERIOR, misma duración (Fase 5, regla de tendencia) — su
 * propia clave es la misma `claveFiltro` que empleados: depende de los mismos filtros
 * (desde/hasta/oficina/tipo), solo que desplazados hacia atrás (ver `periodoAnterior`).
 */
type EstadoOficinasAnterior =
  | { tipo: 'ocioso' }
  | { tipo: 'cargando'; clave: string }
  | { tipo: 'error'; clave: string; mensaje: string }
  | { tipo: 'listo'; clave: string; datos: KpiOficina[] };

const PESTANAS = [
  { clave: 'resumen', etiqueta: 'Resumen' },
  { clave: 'oficina', etiqueta: 'Por oficina' },
  { clave: 'empleado', etiqueta: 'Por empleado' },
  { clave: 'pendientes', etiqueta: 'Pendientes' },
  { clave: 'insights', etiqueta: 'Hallazgos' },
] as const;

/** Pestaña de administración (Fase 3) — separada de `PESTANAS` porque solo se ofrece con
 *  `dashboard.gestionar`, mismo permiso que ya gated el botón "Actualizar ahora". */
const PESTANA_PESOS = { clave: 'pesos', etiqueta: 'Pesos por tipo' } as const;

type PestanaDashboard = (typeof PESTANAS)[number]['clave'] | typeof PESTANA_PESOS.clave;

/** Fase 6 — sub-pestañas dentro de "Por oficina"/"Por empleado" que separan instituciones
 *  (`esComite: false`) de comités de evaluación (`esComite: true`). Claves propias, distintas de
 *  las de `PESTANAS`/`PESTANA_PESOS`, para que `idPestana`/`idPanel` no choquen al anidar. */
const SUB_PESTANAS_CATEGORIA = [
  { clave: 'institucion', etiqueta: 'Instituciones' },
  { clave: 'comite', etiqueta: 'Comités' },
] as const;

type CategoriaUuoo = (typeof SUB_PESTANAS_CATEGORIA)[number]['clave'];

/** Etiquetas de `SUB_PESTANAS_CATEGORIA` con el conteo de cada categoría — mismo patrón que
 *  `pestanasConContador` para las pestañas de nivel superior. */
function subPestanasConContador(nInstituciones: number, nComites: number) {
  return SUB_PESTANAS_CATEGORIA.map((p) => ({
    ...p,
    etiqueta: `${p.etiqueta} (${p.clave === 'institucion' ? nInstituciones : nComites})`,
  }));
}

/** Fase 7 — orden en que se muestran las sub-pestañas de "Hallazgos". */
const CATEGORIAS_HALLAZGO: CategoriaConclusion[] = ['carga', 'calidad', 'complejidad', 'tendencia'];

/** Mismo patrón que `subPestanasConContador`, pero para las 4 categorías de `generarConclusiones`
 *  — etiquetas desde `ETIQUETA_POR_CATEGORIA` (única fuente de verdad, ver `InsightsPanel.tsx`). */
function subPestanasHallazgoConContador(conclusiones: Conclusion[]) {
  return CATEGORIAS_HALLAZGO.map((clave) => ({
    clave,
    etiqueta: `${ETIQUETA_POR_CATEGORIA[clave]} (${conclusiones.filter((c) => c.categoria === clave).length})`,
  }));
}

/**
 * Período inmediatamente anterior, de la MISMA duración (Fase 5, regla de tendencia — ver §9 de
 * PLAN-DASHBOARD-DESEMPENO.md) — sin ningún día de solapamiento ni de hueco: si el rango elegido
 * es `[desde, hasta]` de N días, el anterior termina el día antes de `desde` y también dura N días.
 */
function periodoAnterior(desde: string, hasta: string): { desde: string; hasta: string } {
  const MS_POR_DIA = 24 * 60 * 60 * 1000;
  const d1 = new Date(`${desde}T00:00:00Z`);
  const d2 = new Date(`${hasta}T00:00:00Z`);
  const duracionDias = Math.round((d2.getTime() - d1.getTime()) / MS_POR_DIA) + 1;

  const nuevoHasta = new Date(d1.getTime() - MS_POR_DIA);
  const nuevoDesde = new Date(nuevoHasta.getTime() - (duracionDias - 1) * MS_POR_DIA);

  return { desde: nuevoDesde.toISOString().slice(0, 10), hasta: nuevoHasta.toISOString().slice(0, 10) };
}

/** Solo para la ETIQUETA del eje — el tooltip de Recharts sigue leyendo el nombre completo del
 *  punto de datos, esto no lo toca. */
function truncar(texto: string, limite = 26): string {
  return texto.length > limite ? `${texto.slice(0, limite).trimEnd()}…` : texto;
}

/**
 * Tick propio para el eje Y categórico: el `tickFormatter` de Recharts NO basta — su `Text`
 * interno vuelve a recortar la etiqueta ya acortada según un cálculo propio de ancho por
 * carácter, y con nombres de oficina largos el resultado terminaba en apenas "..."/"U...". Un
 * `<text>` SVG propio, sin pasar por ese componente, no sufre ese segundo recorte.
 */
function TickOficina({ x, y, payload }: { x?: number; y?: number; payload?: { value: string } }) {
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fontSize={11} fill="var(--color-muted-foreground)">
      {truncar(payload?.value ?? '')}
    </text>
  );
}

function formatearHoras(horas: number | null): string {
  if (horas === null) return '—';
  if (horas < 1) return `${Math.round(horas * 60)} min`;
  if (horas < 24) return `${horas.toFixed(1)} h`;
  return `${(horas / 24).toFixed(1)} d`;
}

/** `null` es "sin base para calcular" (nadie emitió/participó todavía) — se muestra como "—", no
 *  como 0%, que se leería como "ninguno", una afirmación distinta. */
function formatearPorcentaje(valor: number | null): string {
  return valor === null ? '—' : `${(valor * 100).toFixed(0)}%`;
}

/**
 * Todos los indicadores salen de un espejo local, refrescado en background cada
 * `dashboard.resumen.cadencia_min` (15 min por defecto) — nunca en vivo contra el SGD. Esta nota
 * es la única señal de qué tan al día está lo que se ve; sin ella, un espejo estancado por un
 * refresco fallido pasaría desapercibido.
 */
/** Fase 9 — qué rango de fechas se está aplicando realmente, ya que "Desde"/"Hasta" son opcionales
 *  e independientes: sin ninguno, todo el histórico; con uno solo, abierto de ese lado. */
function formatearRangoFiltro(desde: string, hasta: string): string {
  if (!desde && !hasta) {
    return 'Mostrando todos los datos disponibles en la base de datos. Elegí una fecha para acotar el período.';
  }
  if (desde && hasta) return `Mostrando del ${desde} al ${hasta}.`;
  if (desde) return `Mostrando desde el ${desde} en adelante.`;
  return `Mostrando hasta el ${hasta}.`;
}

function formatearFrescura(estado: EstadoResumen | null): string {
  if (!estado) return 'Cargando estado de los datos…';
  if (estado.ultimoError) return `El último refresco falló: ${estado.ultimoError}`;
  if (estado.minutosDesde === null) return 'Los datos todavía no se han cargado por primera vez.';
  if (estado.minutosDesde < 1) return 'Datos actualizados hace instantes.';
  if (estado.minutosDesde < 60) return `Datos actualizados hace ${Math.round(estado.minutosDesde)} min.`;
  return `Datos actualizados hace ${(estado.minutosDesde / 60).toFixed(1)} h.`;
}

/** Promedio simple de una lista de números que puede tener `null` — ignora los `null`, no los trata como 0. */
function promedioSinNulos(valores: (number | null)[]): number | null {
  const validos = valores.filter((v): v is number => v !== null);
  if (validos.length === 0) return null;
  return validos.reduce((a, b) => a + b, 0) / validos.length;
}

/**
 * Resumen agregado de un conjunto de oficinas — sumas directas de recibidos/atendidos, y
 * promedios calculados sobre las OFICINAS (no sobre los empleados) para no pesar de más a las
 * oficinas con más gente, igual criterio con el que el backend agrega cada nivel por separado en
 * SQL. Extraído como función pura (Fase 6) para poder aplicarlo tanto al total como, por
 * separado, a instituciones y comités — dos poblaciones de volumen muy distinto que antes se
 * promediaban juntas.
 */
function calcularResumenOficinas(oficinas: KpiOficina[]) {
  const recibidos = oficinas.reduce((a, o) => a + o.recibidos, 0);
  const atendidos = oficinas.reduce((a, o) => a + o.atendidos, 0);
  const emitidos = oficinas.reduce((a, o) => a + o.emitidos, 0);
  const anulados = oficinas.reduce((a, o) => a + o.anulados, 0);
  const gruposEmpleadoExpediente = oficinas.reduce((a, o) => a + o.gruposEmpleadoExpediente, 0);
  const gruposReprocesados = oficinas.reduce((a, o) => a + o.gruposReprocesados, 0);
  return {
    recibidos,
    atendidos,
    pendientes: recibidos - atendidos,
    tasaAtencion: recibidos > 0 ? atendidos / recibidos : 0,
    tiempoPromedioHoras: promedioSinNulos(oficinas.map((o) => o.tiempoPromedioHoras)),
    tasaAnulacion: emitidos > 0 ? anulados / emitidos : null,
    tasaReproceso: gruposEmpleadoExpediente > 0 ? gruposReprocesados / gruposEmpleadoExpediente : null,
  };
}

export function DashboardPage() {
  // Fase 9: sin fecha por defecto, no "últimos 30 días" — vacío muestra todo el histórico hasta
  // que la persona elija un rango (ver la nota junto a estos campos, más abajo).
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [coDependencia, setCoDependencia] = useState('');
  const [tipoDocumento, setTipoDocumento] = useState('');
  const [busquedaEmpleado, setBusquedaEmpleado] = useState('');
  const busquedaDiferida = useDeferredValue(busquedaEmpleado);
  const [pestana, setPestana] = useState<PestanaDashboard>('resumen');
  const [subPestanaOficina, setSubPestanaOficina] = useState<CategoriaUuoo>('institucion');
  const [subPestanaEmpleado, setSubPestanaEmpleado] = useState<CategoriaUuoo>('institucion');
  const [subPestanaHallazgo, setSubPestanaHallazgo] = useState<CategoriaConclusion>('carga');

  const [dependencias, setDependencias] = useState<Dependencia[]>([]);
  const [tipos, setTipos] = useState<TipoDocumento[]>([]);
  const [estadoOficinas, setEstadoOficinas] = useState<EstadoOficinas>({ tipo: 'cargando' });
  const [estadoEmpleados, setEstadoEmpleados] = useState<EstadoEmpleados>({ tipo: 'ocioso' });
  const [estadoPendientes, setEstadoPendientes] = useState<EstadoPendientes>({ tipo: 'ocioso' });
  const [estadoPesos, setEstadoPesos] = useState<EstadoPesos>({ tipo: 'ocioso' });
  const [estadoOficinasAnterior, setEstadoOficinasAnterior] = useState<EstadoOficinasAnterior>({ tipo: 'ocioso' });

  const { puede } = useSesion();
  const puedeGestionar = puede('dashboard.gestionar');
  const [estadoResumenEspejo, setEstadoResumenEspejo] = useState<EstadoResumen | null>(null);
  const [refrescando, setRefrescando] = useState(false);

  const cargarEstadoResumen = useCallback(() => {
    fetchResumenEstado().then(setEstadoResumenEspejo).catch(() => { });
  }, []);

  // Catálogos de los filtros: se cargan una sola vez, no dependen del rango elegido. El estado del
  // espejo también, para la nota "Datos actualizados hace X min".
  useEffect(() => {
    let vigente = true;
    fetchDependencias().then((d) => vigente && setDependencias(d)).catch(() => { });
    fetchTiposDocumento().then((t) => vigente && setTipos(t)).catch(() => { });
    cargarEstadoResumen();
    return () => {
      vigente = false;
    };
  }, [cargarEstadoResumen]);

  const filtro = useMemo<FiltroResumen>(
    () => ({
      desde: desde || undefined,
      hasta: hasta || undefined,
      coDependencia: coDependencia || undefined,
      tipoDocumento: tipoDocumento || undefined,
    }),
    [desde, hasta, coDependencia, tipoDocumento],
  );

  /** Identidad de la combinación de filtros: si cambia, lo cargado ya no vale. */
  const claveFiltro = useMemo(() => JSON.stringify(filtro), [filtro]);

  const cargarOficinas = useCallback(() => {
    let vigente = true;
    setEstadoOficinas({ tipo: 'cargando' });

    fetchDesempenoOficinas(filtro)
      .then((datos) => {
        if (vigente) setEstadoOficinas({ tipo: 'listo', datos });
      })
      .catch((err: unknown) => {
        if (vigente) {
          setEstadoOficinas({ tipo: 'error', mensaje: err instanceof Error ? err.message : 'Error desconocido' });
        }
      });

    return () => {
      vigente = false;
    };
  }, [filtro]);

  useEffect(() => cargarOficinas(), [cargarOficinas]);

  /** Clave para la que ya se lanzó la petición de empleados — evita repetirla al volver a la pestaña. */
  const claveEmpleadosPedida = useRef<string | null>(null);
  const [intentoEmpleados, setIntentoEmpleados] = useState(0);

  /**
   * Carga perezosa de la agregación por empleado — la más cara de las dos. Solo se pide al abrir
   * su pestaña, y una única vez por combinación de filtros.
   *
   * El guardia va contra un `ref` y no contra `estadoEmpleados`: si el estado estuviera en las
   * dependencias, dejar `cargando` volvería a disparar el efecto y su limpieza cancelaría la
   * petición que acababa de lanzarse. Y por eso mismo no hay limpieza aquí — en `StrictMode` React
   * monta el efecto dos veces en desarrollo, y una limpieza descartaría la única petición viva.
   * La condición de carrera se resuelve al resolver: solo escribe quien siga siendo el vigente.
   *
   * También se pide al abrir "Insights" (Fase 5): esa pestaña necesita los mismos datos por
   * empleado para sus reglas de carga/calidad/complejidad — reusar este mismo efecto evita pedirla
   * dos veces si se visitan ambas pestañas.
   */
  useEffect(() => {
    if (pestana !== 'empleado' && pestana !== 'insights') return;
    if (claveEmpleadosPedida.current === claveFiltro) return;

    claveEmpleadosPedida.current = claveFiltro;
    setEstadoEmpleados({ tipo: 'cargando', clave: claveFiltro });

    fetchDesempenoEmpleados(filtro)
      .then((datos) => {
        if (claveEmpleadosPedida.current === claveFiltro) {
          setEstadoEmpleados({ tipo: 'listo', clave: claveFiltro, datos });
        }
      })
      .catch((err: unknown) => {
        if (claveEmpleadosPedida.current === claveFiltro) {
          setEstadoEmpleados({
            tipo: 'error',
            clave: claveFiltro,
            mensaje: err instanceof Error ? err.message : 'Error desconocido',
          });
        }
      });
  }, [pestana, claveFiltro, filtro, intentoEmpleados]);

  /** Olvida la clave ya pedida y fuerza una vuelta del efecto, aunque los filtros no hayan cambiado. */
  const reintentarEmpleados = useCallback(() => {
    claveEmpleadosPedida.current = null;
    setIntentoEmpleados((n) => n + 1);
  }, []);

  /** Clave para la que ya se pidió el período anterior — misma idea que `claveEmpleadosPedida`. */
  const claveOficinasAnteriorPedida = useRef<string | null>(null);
  const [intentoOficinasAnterior, setIntentoOficinasAnterior] = useState(0);

  /**
   * Oficinas del período INMEDIATAMENTE ANTERIOR, misma duración (Fase 5, regla de tendencia) —
   * solo se pide al abrir "Insights", reutilizando el mismo endpoint `/oficinas` con fechas
   * desplazadas (`periodoAnterior`). Misma clave de caché que empleados (`claveFiltro`): depende
   * de los mismos filtros, ya desplazados.
   */
  useEffect(() => {
    if (pestana !== 'insights') return;
    if (claveOficinasAnteriorPedida.current === claveFiltro) return;

    claveOficinasAnteriorPedida.current = claveFiltro;

    // Fase 9: sin un rango de fechas puesto, "el período anterior de igual duración" no tiene
    // sentido (no hay duración que replicar) — se marca "listo" con datos vacíos en vez de pedir
    // nada, así la regla de tendencia de `generarConclusiones` simplemente no aporta ninguna
    // conclusión (su propio guard de `.length > 0`) y `insightsListos` no se queda esperando para
    // siempre un fetch que nunca iba a salir.
    if (!filtro.desde || !filtro.hasta) {
      setEstadoOficinasAnterior({ tipo: 'listo', clave: claveFiltro, datos: [] });
      return;
    }

    setEstadoOficinasAnterior({ tipo: 'cargando', clave: claveFiltro });

    fetchDesempenoOficinas({ ...periodoAnterior(filtro.desde, filtro.hasta), coDependencia: filtro.coDependencia, tipoDocumento: filtro.tipoDocumento })
      .then((datos) => {
        if (claveOficinasAnteriorPedida.current === claveFiltro) {
          setEstadoOficinasAnterior({ tipo: 'listo', clave: claveFiltro, datos });
        }
      })
      .catch((err: unknown) => {
        if (claveOficinasAnteriorPedida.current === claveFiltro) {
          setEstadoOficinasAnterior({
            tipo: 'error',
            clave: claveFiltro,
            mensaje: err instanceof Error ? err.message : 'Error desconocido',
          });
        }
      });
  }, [pestana, claveFiltro, filtro, intentoOficinasAnterior]);

  const reintentarOficinasAnterior = useCallback(() => {
    claveOficinasAnteriorPedida.current = null;
    setIntentoOficinasAnterior((n) => n + 1);
  }, []);

  /**
   * Carga laboral (Fase 2): backlog vigente HOY, no acotado por `desde`/`hasta` — por eso su
   * clave de filtro (y por lo tanto su carga perezosa) es independiente de `claveFiltro`: cambiar
   * el rango de fechas no debe invalidar esta pestaña, solo cambiar oficina o tipo de documento sí.
   */
  const clavePendientesFiltro = useMemo(
    () => JSON.stringify({ coDependencia: coDependencia || undefined, tipoDocumento: tipoDocumento || undefined }),
    [coDependencia, tipoDocumento],
  );
  const clavePendientesPedida = useRef<string | null>(null);
  const [intentoPendientes, setIntentoPendientes] = useState(0);

  useEffect(() => {
    if (pestana !== 'pendientes') return;
    if (clavePendientesPedida.current === clavePendientesFiltro) return;

    clavePendientesPedida.current = clavePendientesFiltro;
    setEstadoPendientes({ tipo: 'cargando', clave: clavePendientesFiltro });

    fetchPendientesOficinas({ coDependencia: coDependencia || undefined, tipoDocumento: tipoDocumento || undefined })
      .then((datos) => {
        if (clavePendientesPedida.current === clavePendientesFiltro) {
          setEstadoPendientes({ tipo: 'listo', clave: clavePendientesFiltro, datos });
        }
      })
      .catch((err: unknown) => {
        if (clavePendientesPedida.current === clavePendientesFiltro) {
          setEstadoPendientes({
            tipo: 'error',
            clave: clavePendientesFiltro,
            mensaje: err instanceof Error ? err.message : 'Error desconocido',
          });
        }
      });
  }, [pestana, clavePendientesFiltro, coDependencia, tipoDocumento, intentoPendientes]);

  const reintentarPendientes = useCallback(() => {
    clavePendientesPedida.current = null;
    setIntentoPendientes((n) => n + 1);
  }, []);

  // Drill-down de "Pendientes": qué oficina/bucket se abrió (`ModalPendientesDetalle`) y qué
  // documento se está viendo desde ahí (`VisorDocumento`) — mismo patrón de estado que
  // `SeguimientoPage`, solo que ambos modales viven acá porque el drill-down es exclusivo de esta
  // pestaña.
  const [detallePendientes, setDetallePendientes] = useState<{
    coDependencia: string;
    nombreDependencia: string | null;
    bucket: BucketPendientes;
  } | null>(null);
  const [documentoAbierto, setDocumentoAbierto] = useState<{
    url: string;
    titulo: string;
    visualizable: boolean;
  } | null>(null);

  /**
   * Pesos por tipo de documento (Fase 3) — sin filtro propio, así que a diferencia de empleados/
   * pendientes no necesita una "clave": basta con pedirlo una vez al entrar a la pestaña. Solo se
   * ofrece con `dashboard.gestionar` (ver `pestanasDisponibles` más abajo), así que ni siquiera
   * vale la pena intentar cargarlo sin el permiso.
   */
  const pesosPedidos = useRef(false);

  const cargarPesos = useCallback(() => {
    pesosPedidos.current = true;
    setEstadoPesos({ tipo: 'cargando' });
    fetchPesosTipoDocumento()
      .then((datos) => setEstadoPesos({ tipo: 'listo', datos }))
      .catch((err: unknown) => {
        setEstadoPesos({ tipo: 'error', mensaje: err instanceof Error ? err.message : 'Error desconocido' });
      });
  }, []);

  useEffect(() => {
    if (pestana !== 'pesos' || !puedeGestionar) return;
    if (pesosPedidos.current) return;
    cargarPesos();
  }, [pestana, puedeGestionar, cargarPesos]);

  const guardarPeso = useCallback(async (coTipDoc: string, peso: number) => {
    await guardarPesoTipoDocumento(coTipDoc, peso);
    cargarPesos();
  }, [cargarPesos]);

  /**
   * Fuerza un refresco del espejo — solo con `dashboard.gestionar`. Tarda 8-10 s (consulta
   * completa contra el SGD), así que el botón se deshabilita mientras corre en vez de permitir
   * disparar varios a la vez (el backend igual los rechazaría con 409, pero esto evita el viaje).
   * Al terminar, vuelve a pedir todo lo que esté cargado — el espejo cambió por debajo.
   */
  const refrescarAhora = useCallback(async () => {
    setRefrescando(true);
    try {
      await refrescarResumenAhora();
      cargarEstadoResumen();
      cargarOficinas();
      claveEmpleadosPedida.current = null;
      setIntentoEmpleados((n) => n + 1);
      clavePendientesPedida.current = null;
      setIntentoPendientes((n) => n + 1);
    } catch {
      // El error del refresco no tiene su propio aviso todavía — la próxima carga normal de
      // oficinas/empleados ya muestra su propio estado de error si el espejo quedó en mal estado.
    } finally {
      setRefrescando(false);
    }
  }, [cargarEstadoResumen, cargarOficinas]);

  const oficinas = estadoOficinas.tipo === 'listo' ? estadoOficinas.datos : null;
  // La clave se comprueba también al leer: evita mostrar por un instante la tabla del filtro
  // anterior si el filtro cambió mientras esta pestaña estaba cerrada.
  const empleados =
    estadoEmpleados.tipo === 'listo' && estadoEmpleados.clave === claveFiltro ? estadoEmpleados.datos : null;

  // Resumen global (todas las oficinas — pestaña "Resumen"). Anulación y reproceso (Fase 2) se
  // suman igual: ya vienen en la misma fila de oficina, sin pedir nada aparte.
  const resumenGlobal = useMemo(() => (oficinas ? calcularResumenOficinas(oficinas) : null), [oficinas]);

  // Fase 6: instituciones y comités son poblaciones de volumen muy distinto (permanentes de alto
  // volumen vs. ad-hoc de bajo volumen) — desde aquí en adelante cada cálculo de referencia/índice
  // que compara "esta oficina contra las demás" se hace POR SEPARADO en cada categoría, no contra
  // las 67 mezcladas.
  const instituciones = useMemo(() => oficinas?.filter((o) => !o.esComite) ?? [], [oficinas]);
  const comites = useMemo(() => oficinas?.filter((o) => o.esComite) ?? [], [oficinas]);
  const resumenInstituciones = useMemo(() => calcularResumenOficinas(instituciones), [instituciones]);
  const resumenComites = useMemo(() => calcularResumenOficinas(comites), [comites]);

  // Referencia para el badge de cada EMPLEADO: el promedio de SU PROPIA oficina, no el global —
  // comparar a alguien de una oficina con poca carga contra el promedio de una oficina saturada
  // sería injusto.
  const referenciaPorOficina = useMemo(() => {
    const mapa = new Map<string, { tasa: number; tiempo: number | null }>();
    for (const o of oficinas ?? []) {
      mapa.set(o.coDependencia, { tasa: o.tasaAtencion, tiempo: o.tiempoPromedioHoras });
    }
    return mapa;
  }, [oficinas]);

  /**
   * Índice global (Fase 4) — agrupado por categoría (Fase 6: institución vs. comité), no un solo
   * grupo con las 67 oficinas mezcladas: comparar un comité de bajo volumen contra oficinas
   * institucionales grandes distorsionaba el índice de ambos lados. `calcularIndicesYNiveles` ya
   * soporta agrupar vía `claveGrupo` (mismo mecanismo que ya usa el índice por empleado más abajo,
   * agrupado por `coDependencia`). Indexado por `coDependencia` (no array paralelo) porque la
   * tabla ahora renderiza un subconjunto filtrado por categoría, no `oficinas` completo en orden.
   */
  const indicesOficinasPorClave = useMemo(() => {
    const mapa = new Map<string, { indice: number | null; nivel: ResultadoIndice | null }>();
    if (!oficinas) return mapa;
    const resultados = calcularIndicesYNiveles(oficinas, PESOS_INDICE_OFICINA, (o) => (o.esComite ? 'comite' : 'institucion'));
    oficinas.forEach((o, i) => mapa.set(o.coDependencia, resultados[i]));
    return mapa;
  }, [oficinas]);

  /**
   * Igual índice, pero agrupado por `coDependencia` (§9: "misma oficina" para el nivel empleado)
   * — cada empleado se compara solo contra sus compañeros de oficina, no contra todo el universo.
   * Se calcula sobre `empleados` (el array completo ya cargado para el filtro), NO sobre
   * `empleadosFiltrados`: el buscador de nombre es una conveniencia de UI, no debe achicar el
   * grupo de comparación estadística. El resultado se indexa por clave (no por posición) porque
   * la tabla sí puede mostrar un subconjunto filtrado.
   */
  const indicesEmpleadosPorClave = useMemo(() => {
    const mapa = new Map<string, { indice: number | null; nivel: ResultadoIndice | null }>();
    if (!empleados) return mapa;
    const resultados = calcularIndicesYNiveles(empleados, PESOS_INDICE_EMPLEADO, (e) => e.coDependencia);
    empleados.forEach((e, i) => mapa.set(`${e.coEmpleado}-${e.coDependencia}`, resultados[i]));
    return mapa;
  }, [empleados]);

  const empleadosFiltrados = useMemo(() => {
    if (!empleados) return [];
    const termino = busquedaDiferida.trim().toLowerCase();
    if (!termino) return empleados;
    return empleados.filter(
      (e) => e.nombreCompleto?.toLowerCase().includes(termino) || e.nombreDependencia?.toLowerCase().includes(termino),
    );
  }, [empleados, busquedaDiferida]);

  // Fase 6 — misma separación institución/comité que en "Por oficina", aplicada DESPUÉS del
  // buscador: el buscador es una conveniencia de UI sobre lo que ya se está mirando.
  const empleadosInstituciones = useMemo(() => empleadosFiltrados.filter((e) => !e.esComite), [empleadosFiltrados]);
  const empleadosComites = useMemo(() => empleadosFiltrados.filter((e) => e.esComite), [empleadosFiltrados]);

  // Contador en la etiqueta de cada pestaña — se ve de un vistazo cuánto hay dentro sin abrirla.
  // "Por empleado" va sin número hasta que se abre: con carga perezosa ese dato aún no se conoce.
  const pendientes =
    estadoPendientes.tipo === 'listo' && estadoPendientes.clave === clavePendientesFiltro
      ? estadoPendientes.datos
      : null;

  const pesos = estadoPesos.tipo === 'listo' ? estadoPesos.datos : null;

  const oficinasAnterior =
    estadoOficinasAnterior.tipo === 'listo' && estadoOficinasAnterior.clave === claveFiltro
      ? estadoOficinasAnterior.datos
      : null;

  /**
   * Insights (Fase 5): espera a que empleados Y el período anterior estén listos (o hayan
   * fallado) antes de evaluar las reglas — mostrar "sin hallazgos" mientras todavía falta un
   * pedazo de dato sería un falso negativo, no una conclusión real.
   */
  const insightsListos = empleados !== null && (oficinasAnterior !== null || estadoOficinasAnterior.tipo === 'error');
  const conclusiones = useMemo(
    () => (oficinas && empleados ? generarConclusiones({ oficinas, empleados, oficinasPeriodoAnterior: oficinasAnterior ?? undefined }) : []),
    [oficinas, empleados, oficinasAnterior],
  );

  // "Pesos por tipo" solo se ofrece con `dashboard.gestionar` — mismo permiso que ya gated el
  // botón "Actualizar ahora", ver §9 de PLAN-DASHBOARD-DESEMPENO.md.
  const pestanasDisponibles = useMemo(
    () => (puedeGestionar ? [...PESTANAS, PESTANA_PESOS] : PESTANAS),
    [puedeGestionar],
  );

  const pestanasConContador = useMemo(
    () =>
      pestanasDisponibles.map((p) => {
        if (p.clave === 'oficina' && oficinas) return { ...p, etiqueta: `Por oficina (${oficinas.length})` };
        if (p.clave === 'empleado' && empleados) return { ...p, etiqueta: `Por empleado (${empleados.length})` };
        if (p.clave === 'pendientes' && pendientes) return { ...p, etiqueta: `Pendientes (${pendientes.length})` };
        if (p.clave === 'pesos' && pesos) return { ...p, etiqueta: `Pesos por tipo (${pesos.length})` };
        if (p.clave === 'insights' && insightsListos) return { ...p, etiqueta: `Hallazgos (${conclusiones.length})` };
        return p;
      }),
    [pestanasDisponibles, oficinas, empleados, pendientes, pesos, insightsListos, conclusiones],
  );

  // Top 12 oficinas por volumen recibido — más que eso ya no cabe legible ni en barras horizontales.
  const datosGrafico = useMemo(
    () =>
      [...(oficinas ?? [])]
        .sort((a, b) => b.recibidos - a.recibidos)
        .slice(0, 12)
        .map((o) => ({
          nombre: o.nombreDependencia ?? o.coDependencia,
          recibidos: o.recibidos,
          atendidos: o.atendidos,
          tiempoPromedioHoras: o.tiempoPromedioHoras ?? 0,
        })),
    [oficinas],
  );

  // Cada barra necesita su propio alto fijo para no verse apretada — con pocas oficinas el
  // gráfico se encoge en vez de dejar barras gigantes o espacio vacío.
  const alturaGrafico = Math.max(160, datosGrafico.length * 34 + 40);

  /**
   * Qué estado gobierna el panel visible. En la pestaña de empleados las oficinas mandan mientras
   * no estén listas: sin ellas los badges no tendrían contra qué compararse
   * (`referenciaPorOficina` sale de las oficinas), y mostrar niveles calculados contra una
   * referencia vacía sería peor que esperar.
   *
   * Un estado de empleados de un filtro anterior cuenta como `ocioso` — el efecto todavía no ha
   * corrido para pedirlo de nuevo, y sin esto el panel quedaría en blanco ese instante.
   */
  const estadoActivo: EstadoOficinas | EstadoEmpleados =
    pestana !== 'empleado' || estadoOficinas.tipo !== 'listo'
      ? estadoOficinas
      : estadoEmpleados.tipo !== 'ocioso' && estadoEmpleados.clave === claveFiltro
        ? estadoEmpleados
        : { tipo: 'ocioso' };

  const reintentar = estadoOficinas.tipo === 'error' ? cargarOficinas : reintentarEmpleados;

  // "Pendientes", "Pesos por tipo" e "Insights" tienen su propio estado de carga, independiente de
  // `estadoActivo` (que gobierna resumen/oficina/empleado) — cada una se renderiza en su propio
  // bloque más abajo.
  const esPestanaComun = pestana !== 'pendientes' && pestana !== 'pesos' && pestana !== 'insights';

  return (
    <main className="app-main app-main--ancho">
      <form className="filtros" onSubmit={(e) => e.preventDefault()}>
        <div className="campo">
          <label htmlFor="dash-desde">Desde</label>
          <input id="dash-desde" type="date" value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)} />
        </div>
        <div className="campo">
          <label htmlFor="dash-hasta">Hasta</label>
          <input id="dash-hasta" type="date" value={hasta} min={desde} onChange={(e) => setHasta(e.target.value)} />
        </div>
        <div className="campo">
          <label htmlFor="dash-dependencia">Oficina</label>
          <select id="dash-dependencia" value={coDependencia} onChange={(e) => setCoDependencia(e.target.value)}>
            <option value="">Todas las oficinas</option>
            {dependencias.map((d) => (
              <option key={d.coDependencia} value={d.coDependencia}>
                {d.deSigla ? `${d.deSigla} — ${d.deDependencia}` : d.deDependencia}
              </option>
            ))}
          </select>
        </div>
        <div className="campo">
          <label htmlFor="dash-tipo">Tipo de documento</label>
          <select id="dash-tipo" value={tipoDocumento} onChange={(e) => setTipoDocumento(e.target.value)}>
            <option value="">Todos los tipos</option>
            {tipos.map((t) => (
              <option key={t.codigo} value={t.codigo}>
                {t.descripcion ?? t.codigo}
              </option>
            ))}
          </select>
        </div>
      </form>

      <p className="exp-nota">{formatearRangoFiltro(desde, hasta)}</p>

      <p className="exp-nota exp-nota--espejo">
        <span>{formatearFrescura(estadoResumenEspejo)}</span>
        {puedeGestionar && (
          <button className="boton-secundario" onClick={refrescarAhora} disabled={refrescando}>
            {refrescando ? 'Actualizando… (puede tardar 10 s)' : 'Actualizar ahora'}
          </button>
        )}
      </p>

      <p className="exp-nota">
        Tiempo de atención: entre la recepción y la primera respuesta del mismo empleado en el
        expediente. "Días hábiles" solo excluye fines de semana — no hay feriados cargados en esta
        instalación.
      </p>

      <Pestanas
        pestanas={pestanasConContador}
        activa={pestana}
        onCambiar={setPestana}
        etiqueta="Secciones del dashboard de desempeño"
      />

      <div role="tabpanel" id={idPanel(pestana)} aria-labelledby={idPestana(pestana)}>
        {esPestanaComun && estadoActivo.tipo === 'error' && (
          <div className="state-message is-error" role="alert">
            <p>No se pudo calcular el resumen de desempeño.</p>
            <p>{estadoActivo.mensaje}</p>
            <button className="retry-button" onClick={reintentar}>Reintentar</button>
          </div>
        )}

        {esPestanaComun && (estadoActivo.tipo === 'cargando' || estadoActivo.tipo === 'ocioso') && (
          <TableSkeleton rows={5} columnas={5} etiqueta="Calculando indicadores" />
        )}

        {esPestanaComun && estadoActivo.tipo === 'listo' && resumenGlobal && (
          <>
            {pestana === 'resumen' && (
              <PanelResumen resumenGlobal={resumenGlobal} datosGrafico={datosGrafico} alturaGrafico={alturaGrafico} />
            )}

            {pestana === 'oficina' && (
              <>
                <Pestanas
                  pestanas={subPestanasConContador(instituciones.length, comites.length)}
                  activa={subPestanaOficina}
                  onCambiar={setSubPestanaOficina}
                  etiqueta="Tipo de UUOO"
                />
                <TablaOficinas
                  oficinas={subPestanaOficina === 'institucion' ? instituciones : comites}
                  referenciaTasa={
                    (subPestanaOficina === 'institucion' ? resumenInstituciones : resumenComites).tasaAtencion
                  }
                  referenciaTiempo={
                    (subPestanaOficina === 'institucion' ? resumenInstituciones : resumenComites).tiempoPromedioHoras
                  }
                  indicesPorClave={indicesOficinasPorClave}
                />
              </>
            )}

            {pestana === 'empleado' && empleados && (
              <>
                <div className="toolbar">
                  <input
                    type="search"
                    className="search-input"
                    placeholder="Buscar por nombre u oficina…"
                    aria-label="Buscar empleado"
                    value={busquedaEmpleado}
                    onChange={(e) => setBusquedaEmpleado(e.target.value)}
                  />
                </div>
                <p className="result-count">{empleadosFiltrados.length} de {empleados.length} empleado(s)</p>
                <Pestanas
                  pestanas={subPestanasConContador(empleadosInstituciones.length, empleadosComites.length)}
                  activa={subPestanaEmpleado}
                  onCambiar={setSubPestanaEmpleado}
                  etiqueta="Tipo de UUOO"
                />
                <TablaEmpleados
                  empleados={subPestanaEmpleado === 'institucion' ? empleadosInstituciones : empleadosComites}
                  referenciaPorOficina={referenciaPorOficina}
                  indicesPorClave={indicesEmpleadosPorClave}
                />
              </>
            )}
          </>
        )}

        {pestana === 'pendientes' && (
          <>
            <p className="exp-nota">
              Backlog vigente HOY: ignora el rango "Desde"/"Hasta" a propósito. No cuenta los
              documentos informativos (copia, para conocimiento) ni los que quedaron abiertos en un
              expediente que después se archivó — en ambos casos ya no hay respuesta que esperar.
              Hacé clic en cualquier número para ver los expedientes.
            </p>

            {(estadoPendientes.tipo === 'error') && (
              <div className="state-message is-error" role="alert">
                <p>No se pudo calcular el backlog de pendientes.</p>
                <p>{estadoPendientes.mensaje}</p>
                <button className="retry-button" onClick={reintentarPendientes}>Reintentar</button>
              </div>
            )}

            {(estadoPendientes.tipo === 'cargando' || estadoPendientes.tipo === 'ocioso') && (
              <TableSkeleton rows={5} columnas={5} etiqueta="Calculando pendientes" />
            )}

            {pendientes && (
              <TablaPendientes
                pendientes={pendientes}
                onAbrirDetalle={(coDep, nombreDep, bucket) =>
                  setDetallePendientes({ coDependencia: coDep, nombreDependencia: nombreDep, bucket })
                }
              />
            )}
          </>
        )}

        {pestana === 'pesos' && (
          <>
            <p className="exp-nota">
              Multiplica cada documento en "Prod./Carga ponderada". La sugerencia sale del tiempo
              mediano de atención de ese tipo frente al resto (más lento ≈ 2.0, más rápido ≈ 1.0); sin
              muestra suficiente no hay sugerencia, pero se puede fijar a mano igual.
            </p>

            {estadoPesos.tipo === 'error' && (
              <div className="state-message is-error" role="alert">
                <p>No se pudieron cargar los pesos por tipo de documento.</p>
                <p>{estadoPesos.mensaje}</p>
                <button className="retry-button" onClick={cargarPesos}>Reintentar</button>
              </div>
            )}

            {(estadoPesos.tipo === 'cargando' || estadoPesos.tipo === 'ocioso') && (
              <TableSkeleton rows={5} columnas={5} etiqueta="Cargando pesos por tipo de documento" />
            )}

            {pesos && <TablaPesos pesos={pesos} onGuardar={guardarPeso} />}
          </>
        )}

        {pestana === 'insights' && (
          <>
            <p className="exp-nota">
              Hallazgos automáticos sobre los KPIs de arriba: carga desigual, productividad con
              reproceso alto, baja productividad por complejidad, y tendencias del índice global.
              Cada uno dice contra qué se comparó.
            </p>

            {estadoEmpleados.tipo === 'error' && estadoEmpleados.clave === claveFiltro && (
              <div className="state-message is-error" role="alert">
                <p>No se pudieron calcular los insights: falló la agregación por empleado.</p>
                <p>{estadoEmpleados.mensaje}</p>
                <button className="retry-button" onClick={reintentarEmpleados}>Reintentar</button>
              </div>
            )}

            {estadoEmpleados.tipo !== 'error' && !insightsListos && (
              <TableSkeleton rows={5} columnas={2} etiqueta="Calculando insights" />
            )}

            {estadoEmpleados.tipo !== 'error' && insightsListos && (
              <>
                {estadoOficinasAnterior.tipo === 'error' && (
                  <p className="exp-nota is-error">
                    No se pudo calcular la tendencia contra el período anterior — el resto de los
                    hallazgos sí se muestra.{' '}
                    <button className="boton-enlace" onClick={reintentarOficinasAnterior}>Reintentar</button>
                  </p>
                )}
                {conclusiones.length === 0 ? (
                  <div className="state-message">
                    Sin hallazgos relevantes en este período — ninguna oficina o empleado cruzó los
                    umbrales configurados para carga, calidad, complejidad o tendencia.
                  </div>
                ) : (
                  <>
                    <Pestanas
                      pestanas={subPestanasHallazgoConContador(conclusiones)}
                      activa={subPestanaHallazgo}
                      onCambiar={setSubPestanaHallazgo}
                      etiqueta="Categoría de hallazgo"
                    />
                    {subPestanaHallazgo === 'tendencia' && (!filtro.desde || !filtro.hasta) && (
                      <p className="exp-nota">
                        La tendencia necesita "Desde" y "Hasta" elegidos, para compararlo contra el
                        período inmediatamente anterior.
                      </p>
                    )}
                    <InsightsPanel
                      conclusiones={conclusiones.filter((c) => c.categoria === subPestanaHallazgo)}
                    />
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>

      {detallePendientes && (
        <ModalPendientesDetalle
          coDependencia={detallePendientes.coDependencia}
          nombreDependencia={detallePendientes.nombreDependencia}
          bucket={detallePendientes.bucket}
          tipoDocumento={tipoDocumento || undefined}
          tipos={tipos}
          onCerrar={() => setDetallePendientes(null)}
          onAbrirDocumento={(url, titulo, visualizable) => setDocumentoAbierto({ url, titulo, visualizable })}
        />
      )}

      {documentoAbierto && (
        <VisorDocumento
          url={documentoAbierto.url}
          titulo={documentoAbierto.titulo}
          visualizable={documentoAbierto.visualizable}
          onCerrar={() => setDocumentoAbierto(null)}
        />
      )}
    </main>
  );
}

function PanelResumen({
  resumenGlobal, datosGrafico, alturaGrafico,
}: {
  resumenGlobal: {
    recibidos: number; atendidos: number; pendientes: number; tasaAtencion: number;
    tiempoPromedioHoras: number | null; tasaAnulacion: number | null; tasaReproceso: number | null;
  };
  datosGrafico: { nombre: string; recibidos: number; atendidos: number; tiempoPromedioHoras: number }[];
  alturaGrafico: number;
}) {
  return (
    <div className="rag-grid">
      <section className="rag-tarjeta">
        <h2>Documentos recibidos</h2>
        <p className="dashboard-stat">{resumenGlobal.recibidos.toLocaleString('es-PE')}</p>
        <p className="exp-nota">solo motivos de acción — los informativos se cuentan aparte</p>
      </section>
      <section className="rag-tarjeta">
        <h2>Tasa de atención</h2>
        <p className="dashboard-stat">{(resumenGlobal.tasaAtencion * 100).toFixed(0)}%</p>
        <p className="exp-nota">{resumenGlobal.atendidos.toLocaleString('es-PE')} atendidos</p>
      </section>
      <section className="rag-tarjeta">
        <h2>Tiempo promedio</h2>
        <p className="dashboard-stat">{formatearHoras(resumenGlobal.tiempoPromedioHoras)}</p>
        <p className="exp-nota">promedio entre oficinas, no ponderado por volumen</p>
      </section>
      <section className="rag-tarjeta">
        <h2>Pendientes</h2>
        <p className="dashboard-stat">{resumenGlobal.pendientes.toLocaleString('es-PE')}</p>
      </section>
      <section className="rag-tarjeta">
        <h2>Tasa de anulación</h2>
        <p className="dashboard-stat">{formatearPorcentaje(resumenGlobal.tasaAnulacion)}</p>
        <p className="exp-nota">de lo emitido en el período — no de lo recibido</p>
      </section>
      <section className="rag-tarjeta">
        <h2>Reproceso</h2>
        <p className="dashboard-stat">{formatearPorcentaje(resumenGlobal.tasaReproceso)}</p>
        <p className="exp-nota">expedientes que el mismo empleado volvió a tocar — proxy, no un "devuelto" confirmado</p>
      </section>

      {datosGrafico.length > 0 && (
        <section className="rag-tarjeta rag-tarjeta--ancha">
          {/* Barras horizontales a propósito: con nombres de oficina largos, un eje rotado
              termina recortado por Recharts sin importar cuánto se acorte a mano — el eje Y
              de un gráfico horizontal lee el texto normal, sin rotación ni recorte. */}
          <h2>Documentos por oficina (top 12 por volumen)</h2>
          <ResponsiveContainer width="100%" height={alturaGrafico}>
            <BarChart data={datosGrafico} layout="vertical" margin={{ left: 8, right: 12 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis type="number" allowDecimals={false} />
              <YAxis type="category" dataKey="nombre" width={200} tick={<TickOficina />} />
              <RechartsTooltip />
              <Legend />
              <Bar dataKey="recibidos" name="Recibidos" fill="var(--color-primary)" />
              <Bar dataKey="atendidos" name="Atendidos" fill="var(--color-accent)" />
            </BarChart>
          </ResponsiveContainer>

          <h2>Tiempo promedio de atención por oficina (horas)</h2>
          <ResponsiveContainer width="100%" height={alturaGrafico}>
            <BarChart data={datosGrafico} layout="vertical" margin={{ left: 8, right: 12 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis type="number" allowDecimals={false} />
              <YAxis type="category" dataKey="nombre" width={200} tick={<TickOficina />} />
              <RechartsTooltip formatter={(v) => `${Number(v).toFixed(1)} h`} />
              <Bar dataKey="tiempoPromedioHoras" name="Horas promedio" fill="var(--color-primary)" />
            </BarChart>
          </ResponsiveContainer>
        </section>
      )}
    </div>
  );
}

/** Campos que alimentan el panel de métricas secundarias (Fase 6) — comunes a `KpiOficina` y
 *  `KpiEmpleado`, ya cubiertos por `KpiCalidad` en el backend/`api/dashboard.ts`. */
interface ConMetricasSecundarias {
  tiempoMedianoHoras: number | null;
  recibidosInformativos: number;
  tasaAtencionInformativos: number;
  tasaAnulacion: number | null;
  tasaReproceso: number | null;
  movimientosPromedioPorExpediente: number | null;
  productividadPonderada: number;
  cargaPonderada: number;
}

/**
 * Fase 6 — las 8 métricas que antes eran columnas propias, movidas al panel que se abre al
 * expandir una fila (mismo patrón que `InteraccionesExpediente` dentro de `fila-detalle` en
 * `ExpedienteTable`). Agrupadas en las mismas dos categorías que ya usa `InsightsPanel`
 * (calidad / complejidad y productividad) para que el vocabulario del dashboard sea consistente.
 */
function PanelMetricasSecundarias({ fila }: { fila: ConMetricasSecundarias }) {
  return (
    <div className="detalle-metricas">
      <div className="detalle-grupo">
        <h3>Calidad</h3>
        <dl>
          <div><dt>Informativos</dt><dd>{fila.recibidosInformativos}</dd></div>
          <div><dt>Tasa inf.</dt><dd>{formatearPorcentaje(fila.tasaAtencionInformativos)}</dd></div>
          <div><dt>Anulación</dt><dd>{formatearPorcentaje(fila.tasaAnulacion)}</dd></div>
          <div><dt>Reproceso</dt><dd>{formatearPorcentaje(fila.tasaReproceso)}</dd></div>
        </dl>
      </div>
      <div className="detalle-grupo">
        <h3>Complejidad y productividad</h3>
        <dl>
          <div><dt>Tiempo mediano</dt><dd>{formatearHoras(fila.tiempoMedianoHoras)}</dd></div>
          <div><dt>Mov./exped.</dt><dd>{fila.movimientosPromedioPorExpediente?.toFixed(1) ?? '—'}</dd></div>
          <div><dt>Prod. ponderada</dt><dd>{fila.productividadPonderada.toFixed(1)}</dd></div>
          <div><dt>Carga ponderada</dt><dd>{fila.cargaPonderada.toFixed(1)}</dd></div>
        </dl>
      </div>
    </div>
  );
}

/** Fase 9 — mismo conjunto de indicadores para "Por oficina" y "Por empleado": comparten casi
 *  todas las columnas (visibles + panel expandible de Fase 6). */
const CLAVES_GLOSARIO_TABLA: ClaveMetrica[] = [
  'recibidos', 'atendidos', 'pendientes', 'tasaAtencion', 'tiempoPromedio', 'indiceGlobal',
  'informativos', 'tasaInformativos', 'anulacion', 'reproceso', 'movimientosPorExpediente',
  'prodPonderada', 'cargaPonderada',
];

const COLUMNAS_TABLA_OFICINAS = 8;

/**
 * Fase 6 — de 18 a 8 columnas visibles: valor y badge de nivel fusionados en una sola celda (ya
 * no hace falta ir y venir entre "Tasa de atención" y "Nivel — tasa" para leer lo mismo dos
 * veces), y las 8 métricas restantes se movieron a un panel expandible por fila, reusando el
 * patrón `col-expandir`/`fila-detalle` de `ExpedienteTable`. Un solo panel abierto a la vez.
 */
function TablaOficinas({
  oficinas, referenciaTasa, referenciaTiempo, indicesPorClave,
}: {
  oficinas: KpiOficina[];
  referenciaTasa: number;
  referenciaTiempo: number | null;
  indicesPorClave: Map<string, { indice: number | null; nivel: ResultadoIndice | null }>;
}) {
  const [expandida, setExpandida] = useState<string | null>(null);

  if (oficinas.length === 0) {
    return <div className="state-message">Ninguna oficina tuvo movimiento en este rango.</div>;
  }

  return (
    <div className="table-card">
      <div className="table-scroll">
        <table className="tabla-expedientes tabla-oficinas">
          <thead>
            <tr>
              <th scope="col" className="col-expandir"><span className="sr-only">Ver más métricas</span></th>
              <th scope="col">Oficina</th>
              <th scope="col">Recibidos</th>
              <th scope="col">Atendidos</th>
              <th scope="col">Pendientes</th>
              <th scope="col">Tasa de atención</th>
              <th scope="col">Tiempo promedio</th>
              <th scope="col">Índice global</th>
            </tr>
          </thead>
          <tbody>
            {oficinas.map((o) => {
              const indice = indicesPorClave.get(o.coDependencia) ?? { indice: null, nivel: null };
              const nombre = o.nombreDependencia ?? o.coDependencia;
              const abierta = expandida === o.coDependencia;
              return (
                <Fragment key={o.coDependencia}>
                  <tr className={abierta ? 'fila-expandida' : undefined}>
                    <td className="col-expandir">
                      <button
                        type="button"
                        className="boton-expandir"
                        aria-expanded={abierta}
                        aria-label={abierta ? `Ocultar métricas de ${nombre}` : `Ver más métricas de ${nombre}`}
                        onClick={() => setExpandida(abierta ? null : o.coDependencia)}
                      >
                        {abierta ? '▾' : '▸'}
                      </button>
                    </td>
                    <td className="celda-nombre-truncado"><span title={nombre}>{nombre}</span></td>
                    <td className="celda-tiempo">{o.recibidos}</td>
                    <td className="celda-tiempo">{o.atendidos}</td>
                    <td className="celda-tiempo">{o.pendientes}</td>
                    <td className="celda-tiempo">
                      <span className="celda-nivel">
                        {(o.tasaAtencion * 100).toFixed(0)}%
                        <NivelDesempenoBadge resultado={derivarNivelPorTasaAtencion(o.tasaAtencion, referenciaTasa)} />
                      </span>
                    </td>
                    <td className="celda-tiempo">
                      <span className="celda-nivel">
                        {formatearHoras(o.tiempoPromedioHoras)}
                        <NivelDesempenoBadge resultado={derivarNivelPorTiempo(o.tiempoPromedioHoras, referenciaTiempo)} />
                      </span>
                    </td>
                    <td className="celda-tiempo">
                      <span className="celda-nivel">
                        {indice.indice !== null ? indice.indice.toFixed(2) : '—'}
                        <IndiceGlobalBadge resultado={indice.nivel} />
                      </span>
                    </td>
                  </tr>
                  {abierta && (
                    <tr className="fila-detalle">
                      <td colSpan={COLUMNAS_TABLA_OFICINAS}>
                        <PanelMetricasSecundarias fila={o} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <GlosarioMetricas claves={CLAVES_GLOSARIO_TABLA} />
    </div>
  );
}

const COLUMNAS_TABLA_EMPLEADOS = 9;

function TablaEmpleados({
  empleados, referenciaPorOficina, indicesPorClave,
}: {
  empleados: KpiEmpleado[];
  referenciaPorOficina: Map<string, { tasa: number; tiempo: number | null }>;
  indicesPorClave: Map<string, { indice: number | null; nivel: ResultadoIndice | null }>;
}) {
  const [expandida, setExpandida] = useState<string | null>(null);

  if (empleados.length === 0) {
    return <div className="state-message">Ningún empleado coincide con el filtro.</div>;
  }

  return (
    <div className="table-card">
      <div className="table-scroll">
        <table className="tabla-expedientes tabla-oficinas">
          <thead>
            <tr>
              <th scope="col" className="col-expandir"><span className="sr-only">Ver más métricas</span></th>
              <th scope="col">Empleado</th>
              <th scope="col">Oficina</th>
              <th scope="col">Recibidos</th>
              <th scope="col">Atendidos</th>
              <th scope="col">Pendientes</th>
              <th scope="col">Tasa de atención</th>
              <th scope="col">Tiempo promedio</th>
              <th scope="col">Índice global</th>
            </tr>
          </thead>
          <tbody>
            {empleados.map((e) => {
              const clave = `${e.coEmpleado}-${e.coDependencia}`;
              const referencia = referenciaPorOficina.get(e.coDependencia) ?? { tasa: 0, tiempo: null };
              const indice = indicesPorClave.get(clave) ?? { indice: null, nivel: null };
              const nombre = e.nombreCompleto ?? `empleado ${e.coEmpleado}`;
              const oficina = e.nombreDependencia ?? e.coDependencia;
              const abierta = expandida === clave;
              return (
                <Fragment key={clave}>
                  <tr className={abierta ? 'fila-expandida' : undefined}>
                    <td className="col-expandir">
                      <button
                        type="button"
                        className="boton-expandir"
                        aria-expanded={abierta}
                        aria-label={abierta ? `Ocultar métricas de ${nombre}` : `Ver más métricas de ${nombre}`}
                        onClick={() => setExpandida(abierta ? null : clave)}
                      >
                        {abierta ? '▾' : '▸'}
                      </button>
                    </td>
                    <td className="celda-nombre-truncado"><span title={nombre}>{nombre}</span></td>
                    <td className="celda-nombre-truncado"><span title={oficina}>{oficina}</span></td>
                    <td className="celda-tiempo">{e.recibidos}</td>
                    <td className="celda-tiempo">{e.atendidos}</td>
                    <td className="celda-tiempo">{e.pendientes}</td>
                    <td className="celda-tiempo">
                      <span className="celda-nivel">
                        {(e.tasaAtencion * 100).toFixed(0)}%
                        <NivelDesempenoBadge resultado={derivarNivelPorTasaAtencion(e.tasaAtencion, referencia.tasa)} />
                      </span>
                    </td>
                    <td className="celda-tiempo">
                      <span className="celda-nivel">
                        {formatearHoras(e.tiempoPromedioHoras)}
                        <NivelDesempenoBadge resultado={derivarNivelPorTiempo(e.tiempoPromedioHoras, referencia.tiempo)} />
                      </span>
                    </td>
                    <td className="celda-tiempo">
                      <span className="celda-nivel">
                        {indice.indice !== null ? indice.indice.toFixed(2) : '—'}
                        <IndiceGlobalBadge resultado={indice.nivel} />
                      </span>
                    </td>
                  </tr>
                  {abierta && (
                    <tr className="fila-detalle">
                      <td colSpan={COLUMNAS_TABLA_EMPLEADOS}>
                        <PanelMetricasSecundarias fila={e} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <GlosarioMetricas claves={CLAVES_GLOSARIO_TABLA} />
    </div>
  );
}

const CLAVES_GLOSARIO_PENDIENTES: ClaveMetrica[] = ['backlogPendientes'];

/** Una celda numérica de "Pendientes": botón que abre el detalle si hay algo que ver, texto plano
 *  en 0 (no hay nada que abrir) — ambas ramas llevan `celda-pendiente` para alinearse igual,
 *  porque un 0 sin botón no hereda la alineación a la derecha que sí trae `.boton-enlace`. */
function CeldaPendiente({
  cantidad, etiqueta, onAbrir,
}: {
  cantidad: number;
  etiqueta: string;
  onAbrir: () => void;
}) {
  if (cantidad === 0) return <td className="celda-tiempo celda-pendiente">0</td>;

  return (
    <td className="celda-tiempo celda-pendiente">
      <button className="boton-enlace" onClick={onAbrir} aria-label={etiqueta}>
        {cantidad}
      </button>
    </td>
  );
}

/**
 * Backlog vigente HOY por oficina (Fase 2) — sin niveles ni referencias: a diferencia de
 * productividad/oportunidad, todavía no hay un umbral "bueno/malo" definido para esto, así que se
 * muestra el número crudo y se deja el juicio a quien lo lee.
 *
 * Cada número (salvo un 0, donde no hay nada que ver) abre el detalle de los documentos concretos
 * detrás de esa cifra (`ModalPendientesDetalle`, montado en `DashboardPage`). "Más antiguo" abre
 * el bucket `todos`: como el detalle sale ordenado de más viejo a más nuevo, ese documento queda
 * como primera fila.
 */
function TablaPendientes({
  pendientes, onAbrirDetalle,
}: {
  pendientes: PendientesAntiguos[];
  onAbrirDetalle: (coDependencia: string, nombreDependencia: string | null, bucket: BucketPendientes) => void;
}) {
  if (pendientes.length === 0) {
    return <div className="state-message">Ninguna oficina tiene documentos pendientes en este momento.</div>;
  }

  return (
    <div>
      <div className="table-card">
        <div className="table-scroll">
          <table className="tabla-expedientes">
            <thead>
              <tr>
                <th scope="col">Oficina</th>
                <th scope="col">Pendientes</th>
                <th scope="col">0-7 días</th>
                <th scope="col">8-30 días</th>
                <th scope="col">31+ días</th>
                <th scope="col">Más antiguo</th>
              </tr>
            </thead>
            <tbody>
              {pendientes.map((p) => {
                const nombre = p.nombreDependencia ?? p.coDependencia;
                return (
                  <tr key={p.coDependencia}>
                    <td>{nombre}</td>
                    <CeldaPendiente
                      cantidad={p.pendientes}
                      etiqueta={`Ver los ${p.pendientes} pendientes de ${nombre}`}
                      onAbrir={() => onAbrirDetalle(p.coDependencia, p.nombreDependencia, 'todos')}
                    />
                    <CeldaPendiente
                      cantidad={p.pendientes0a7}
                      etiqueta={`Ver los ${p.pendientes0a7} pendientes de 0 a 7 días de ${nombre}`}
                      onAbrir={() => onAbrirDetalle(p.coDependencia, p.nombreDependencia, '0a7')}
                    />
                    <CeldaPendiente
                      cantidad={p.pendientes8a30}
                      etiqueta={`Ver los ${p.pendientes8a30} pendientes de 8 a 30 días de ${nombre}`}
                      onAbrir={() => onAbrirDetalle(p.coDependencia, p.nombreDependencia, '8a30')}
                    />
                    <CeldaPendiente
                      cantidad={p.pendientes31Mas}
                      etiqueta={`Ver los ${p.pendientes31Mas} pendientes de 31+ días de ${nombre}`}
                      onAbrir={() => onAbrirDetalle(p.coDependencia, p.nombreDependencia, '31mas')}
                    />
                    <td className="celda-tiempo celda-pendiente">
                      {p.diasPendienteMasAntiguo === null ? (
                        '—'
                      ) : (
                        <button
                          className="boton-enlace"
                          onClick={() => onAbrirDetalle(p.coDependencia, p.nombreDependencia, 'todos')}
                          aria-label={`Ver el pendiente más antiguo de ${nombre}, ${p.diasPendienteMasAntiguo} días`}
                        >
                          {p.diasPendienteMasAntiguo} d
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <GlosarioMetricas claves={CLAVES_GLOSARIO_PENDIENTES} />
    </div>
  );
}

/**
 * Fase 3 — administración de pesos (`dashboard.gestionar`). Cada fila se edita y guarda por
 * separado: no hay un botón "guardar todo" porque ajustar un peso es una decisión puntual, no un
 * lote — y así un error en una fila no arriesga las demás.
 */
function TablaPesos({
  pesos, onGuardar,
}: {
  pesos: PesoTipoDocumento[];
  onGuardar: (coTipDoc: string, peso: number) => Promise<void>;
}) {
  if (pesos.length === 0) {
    return <div className="state-message">Ningún tipo de documento tiene participaciones registradas todavía.</div>;
  }

  return (
    <div className="table-card">
      <div className="table-scroll">
        <table className="tabla-expedientes">
          <thead>
            <tr>
              <th scope="col">Tipo de documento</th>
              <th scope="col">Muestra (atendidos)</th>
              <th scope="col">Mediana de atención</th>
              <th scope="col">Sugerido</th>
              <th scope="col">Peso</th>
              <th scope="col">Última actualización</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {pesos.map((p) => (
              <FilaPeso key={p.coTipDoc} peso={p} onGuardar={onGuardar} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FilaPeso({
  peso, onGuardar,
}: {
  peso: PesoTipoDocumento;
  onGuardar: (coTipDoc: string, peso: number) => Promise<void>;
}) {
  const [valor, setValor] = useState(String(peso.peso));
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const numero = Number(valor);
  const esValido = valor.trim() !== '' && Number.isFinite(numero) && numero > 0 && numero <= 10;

  async function guardar() {
    if (!esValido) return;
    setGuardando(true);
    setError(null);
    try {
      await onGuardar(peso.coTipDoc, numero);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <tr>
      <td>{peso.descripcion ?? peso.coTipDoc}</td>
      <td className="celda-tiempo">{peso.muestraAtendidos}</td>
      <td className="celda-tiempo">{formatearHoras(peso.medianaHoras)}</td>
      <td className="celda-tiempo">{peso.pesoSugerido !== null ? peso.pesoSugerido.toFixed(2) : '—'}</td>
      <td className="celda-tiempo">
        <input
          type="number"
          min="0.1"
          max="10"
          step="0.1"
          value={valor}
          onChange={(ev) => setValor(ev.target.value)}
          aria-label={`Peso de ${peso.descripcion ?? peso.coTipDoc}`}
          className="peso-input"
        />
      </td>
      <td className="celda-tiempo">
        {peso.feActualizado
          ? `${peso.actualizadoPor ?? '—'} · ${new Date(peso.feActualizado).toLocaleDateString('es-PE')}`
          : 'sin ajustar (peso 1 por defecto)'}
      </td>
      <td>
        <div className="acciones-fila">
          {peso.pesoSugerido !== null && (
            <button
              type="button"
              className="boton-secundario"
              onClick={() => setValor(String(peso.pesoSugerido))}
            >
              Usar sugerido
            </button>
          )}
          <button type="button" className="boton-secundario" onClick={guardar} disabled={!esValido || guardando}>
            {guardando ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
        {error && <p className="exp-nota is-error">{error}</p>}
      </td>
    </tr>
  );
}
