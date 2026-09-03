import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchFlujoProceso,
  fetchProcesos,
  fetchPropuestaProceso,
  renombrarProceso as renombrarProcesoApi,
  type FiltroProcesos,
  type FlujoProceso,
  type Propuesta,
  type ResumenProceso,
} from '../api/calidadProcesos';
import { fetchResumenEstado, type EstadoResumen } from '../api/dashboard';
import { fetchDependencias, type Dependencia } from '../api/dependencias';
import { useSesion } from '../auth/SesionContext';
import { Flujograma } from '../components/Flujograma';
import { GlosarioMetricas } from '../components/GlosarioMetricas';
import { idPanel, idPestana, Pestanas } from '../components/Pestanas';
import { TableSkeleton } from '../components/TableSkeleton';

type EstadoProcesos =
  | { tipo: 'cargando' }
  | { tipo: 'error'; mensaje: string }
  | { tipo: 'listo'; datos: ResumenProceso[] };

/** Igual patrón que `EstadoEmpleados` en `DashboardPage.tsx`: la clave con la que se pidió viaja
 *  dentro del propio estado, para saber sin preguntar si lo que hay en memoria sigue vigente. */
type EstadoFlujo =
  | { tipo: 'ocioso' }
  | { tipo: 'cargando'; clave: string }
  | { tipo: 'error'; clave: string; mensaje: string }
  | { tipo: 'listo'; clave: string; datos: FlujoProceso };

type EstadoPropuesta =
  | { tipo: 'ocioso' }
  | { tipo: 'cargando'; clave: string }
  | { tipo: 'error'; clave: string; mensaje: string }
  | { tipo: 'listo'; clave: string; datos: Propuesta };

const PESTANAS = [
  { clave: 'procesos', etiqueta: 'Procesos detectados' },
  { clave: 'flujo', etiqueta: 'Flujo actual' },
  { clave: 'propuesta', etiqueta: 'Propuesta de mejora' },
] as const;

type PestanaCalidad = (typeof PESTANAS)[number]['clave'];

const GLOSARIO_CLAVES = [
  'columnaVertebral',
  'coberturaColumna',
  'rutaExacta',
  'espera',
  'trabajo',
  'objetivoPercentil',
] as const;

function formatearHoras(horas: number | null): string {
  if (horas === null) return '—';
  if (horas < 1) return `${Math.round(horas * 60)} min`;
  if (horas < 24) return `${horas.toFixed(1)} h`;
  return `${(horas / 24).toFixed(1)} d`;
}

function formatearPorcentaje(valor: number | null): string {
  return valor === null ? '—' : `${valor}%`;
}

/** Mismo texto que `DashboardPage.formatearFrescura` — es literalmente el mismo espejo (el refresco
 *  llena `dashboard.paso`/`dashboard.proceso*` en la MISMA transacción que `dashboard.participacion`). */
function formatearFrescura(estado: EstadoResumen | null): string {
  if (!estado) return 'Cargando estado de los datos…';
  if (estado.ultimoError) return `El último refresco falló: ${estado.ultimoError}`;
  if (estado.minutosDesde === null) return 'Los datos todavía no se han cargado por primera vez.';
  if (estado.minutosDesde < 1) return 'Datos actualizados hace instantes.';
  if (estado.minutosDesde < 60) return `Datos actualizados hace ${Math.round(estado.minutosDesde)} min.`;
  return `Datos actualizados hace ${(estado.minutosDesde / 60).toFixed(1)} h.`;
}

function formatearRangoFiltro(desde: string, hasta: string): string {
  if (!desde && !hasta) return 'Mostrando todo el histórico de expedientes cerrados disponible.';
  if (desde && hasta) return `Mostrando del ${desde} al ${hasta}.`;
  if (desde) return `Mostrando desde el ${desde} en adelante.`;
  return `Mostrando hasta el ${hasta}.`;
}

/** Nombre visible de una familia: el editado a mano si existe, si no el descubierto automáticamente
 *  — el propio `nombre` que ya trae `ResumenProceso` resuelve esa prioridad en el backend. Aquí solo
 *  se decide el estilo (cursiva + nota) cuando NO fue renombrado, para que se note que es un nombre
 *  inferido del texto de los asuntos, no uno confirmado por una persona. */
function NombreProceso({ proceso }: { proceso: ResumenProceso }) {
  if (proceso.renombrado) return <span className="proceso-nombre">{proceso.nombre}</span>;
  return (
    <span className="proceso-nombre proceso-nombre--auto" title="Nombre descubierto automáticamente a partir del asunto de los expedientes">
      {proceso.nombre}
    </span>
  );
}

export function CalidadProcesosPage() {
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [coDependencia, setCoDependencia] = useState('');
  const [soloCerrados, setSoloCerrados] = useState(true);
  const [pestana, setPestana] = useState<PestanaCalidad>('procesos');
  const [procesoSeleccionado, setProcesoSeleccionado] = useState<string | null>(null);

  const [dependencias, setDependencias] = useState<Dependencia[]>([]);
  const [estadoProcesos, setEstadoProcesos] = useState<EstadoProcesos>({ tipo: 'cargando' });
  const [estadoFlujo, setEstadoFlujo] = useState<EstadoFlujo>({ tipo: 'ocioso' });
  const [estadoPropuesta, setEstadoPropuesta] = useState<EstadoPropuesta>({ tipo: 'ocioso' });
  const [estadoResumenEspejo, setEstadoResumenEspejo] = useState<EstadoResumen | null>(null);

  const [editandoNombre, setEditandoNombre] = useState<string | null>(null);
  const [nombreEditado, setNombreEditado] = useState('');
  const [guardandoNombre, setGuardandoNombre] = useState(false);

  const { puede } = useSesion();
  const puedeGestionar = puede('dashboard.gestionar');

  useEffect(() => {
    let vigente = true;
    fetchDependencias().then((d) => vigente && setDependencias(d)).catch(() => {});
    fetchResumenEstado().then((e) => vigente && setEstadoResumenEspejo(e)).catch(() => {});
    return () => {
      vigente = false;
    };
  }, []);

  const filtro = useMemo<FiltroProcesos>(
    () => ({
      desde: desde || undefined,
      hasta: hasta || undefined,
      coDependencia: coDependencia || undefined,
      soloCerrados,
    }),
    [desde, hasta, coDependencia, soloCerrados],
  );
  const claveFiltro = useMemo(() => JSON.stringify(filtro), [filtro]);

  const cargarProcesos = useCallback(() => {
    let vigente = true;
    setEstadoProcesos({ tipo: 'cargando' });

    fetchProcesos(filtro)
      .then((datos) => {
        if (vigente) setEstadoProcesos({ tipo: 'listo', datos });
      })
      .catch((err: unknown) => {
        if (vigente) {
          setEstadoProcesos({ tipo: 'error', mensaje: err instanceof Error ? err.message : 'Error desconocido' });
        }
      });

    return () => {
      vigente = false;
    };
  }, [filtro]);

  useEffect(() => cargarProcesos(), [cargarProcesos]);

  // El proceso seleccionado sigue vigente mientras siga apareciendo en la lista recién cargada;
  // si no (cambió el filtro y ya no tiene expedientes, o es la primera carga), se elige el de
  // mayor volumen — la lista ya llega ordenada por `expedientes` descendente desde el backend.
  useEffect(() => {
    if (estadoProcesos.tipo !== 'listo') return;
    setProcesoSeleccionado((actual) => {
      if (actual && estadoProcesos.datos.some((p) => p.clave === actual)) return actual;
      return estadoProcesos.datos[0]?.clave ?? null;
    });
  }, [estadoProcesos]);

  const claveFlujo = procesoSeleccionado ? `${claveFiltro}|${procesoSeleccionado}` : null;
  const claveFlujoPedida = useRef<string | null>(null);
  const [intentoFlujo, setIntentoFlujo] = useState(0);

  useEffect(() => {
    if (pestana !== 'flujo' || !procesoSeleccionado || !claveFlujo) return;
    if (claveFlujoPedida.current === claveFlujo) return;

    claveFlujoPedida.current = claveFlujo;
    setEstadoFlujo({ tipo: 'cargando', clave: claveFlujo });

    fetchFlujoProceso(procesoSeleccionado, filtro)
      .then((datos) => {
        if (claveFlujoPedida.current === claveFlujo) setEstadoFlujo({ tipo: 'listo', clave: claveFlujo, datos });
      })
      .catch((err: unknown) => {
        if (claveFlujoPedida.current === claveFlujo) {
          setEstadoFlujo({
            tipo: 'error',
            clave: claveFlujo,
            mensaje: err instanceof Error ? err.message : 'Error desconocido',
          });
        }
      });
  }, [pestana, procesoSeleccionado, claveFlujo, filtro, intentoFlujo]);

  const reintentarFlujo = useCallback(() => {
    claveFlujoPedida.current = null;
    setIntentoFlujo((n) => n + 1);
  }, []);

  const clavePropuestaPedida = useRef<string | null>(null);
  const [intentoPropuesta, setIntentoPropuesta] = useState(0);

  useEffect(() => {
    if (pestana !== 'propuesta' || !procesoSeleccionado || !claveFlujo) return;
    if (clavePropuestaPedida.current === claveFlujo) return;

    clavePropuestaPedida.current = claveFlujo;
    setEstadoPropuesta({ tipo: 'cargando', clave: claveFlujo });

    fetchPropuestaProceso(procesoSeleccionado, filtro)
      .then((datos) => {
        if (clavePropuestaPedida.current === claveFlujo) setEstadoPropuesta({ tipo: 'listo', clave: claveFlujo, datos });
      })
      .catch((err: unknown) => {
        if (clavePropuestaPedida.current === claveFlujo) {
          setEstadoPropuesta({
            tipo: 'error',
            clave: claveFlujo,
            mensaje: err instanceof Error ? err.message : 'Error desconocido',
          });
        }
      });
  }, [pestana, procesoSeleccionado, claveFlujo, filtro, intentoPropuesta]);

  const reintentarPropuesta = useCallback(() => {
    clavePropuestaPedida.current = null;
    setIntentoPropuesta((n) => n + 1);
  }, []);

  function seleccionarProceso(clave: string) {
    setProcesoSeleccionado(clave);
    setPestana('flujo');
  }

  function empezarEdicion(proceso: ResumenProceso) {
    setEditandoNombre(proceso.clave);
    setNombreEditado(proceso.nombre);
  }

  async function guardarNombre(clave: string) {
    const nombre = nombreEditado.trim();
    if (!nombre) return;
    setGuardandoNombre(true);
    try {
      await renombrarProcesoApi(clave, nombre);
      setEditandoNombre(null);
      cargarProcesos();
    } catch {
      // El error se refleja al reintentar: no hay un canal de error específico para esta acción
      // puntual, mismo criterio que otras ediciones inline del proyecto.
    } finally {
      setGuardandoNombre(false);
    }
  }

  const procesos = estadoProcesos.tipo === 'listo' ? estadoProcesos.datos : [];
  const procesoActivo = procesos.find((p) => p.clave === procesoSeleccionado) ?? null;

  return (
    <main className="app-main app-main--ancho">
      <form className="filtros" onSubmit={(e) => e.preventDefault()}>
        <div className="campo">
          <label htmlFor="cal-desde">Desde</label>
          <input id="cal-desde" type="date" value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)} />
        </div>
        <div className="campo">
          <label htmlFor="cal-hasta">Hasta</label>
          <input id="cal-hasta" type="date" value={hasta} min={desde} onChange={(e) => setHasta(e.target.value)} />
        </div>
        <div className="campo">
          <label htmlFor="cal-dependencia">Oficina</label>
          <select id="cal-dependencia" value={coDependencia} onChange={(e) => setCoDependencia(e.target.value)}>
            <option value="">Todas las oficinas</option>
            {dependencias.map((d) => (
              <option key={d.coDependencia} value={d.coDependencia}>
                {d.deSigla ? `${d.deSigla} — ${d.deDependencia}` : d.deDependencia}
              </option>
            ))}
          </select>
        </div>
        <div className="campo checkbox-linea">
          <label htmlFor="cal-cerrados">
            <input
              id="cal-cerrados"
              type="checkbox"
              checked={soloCerrados}
              onChange={(e) => setSoloCerrados(e.target.checked)}
            />
            Solo expedientes cerrados
          </label>
          <p className="exp-nota">
            Un expediente a medio camino tiene la ruta truncada y distorsiona el flujo detectado.
          </p>
        </div>
      </form>

      <p className="exp-nota">{formatearRangoFiltro(desde, hasta)}</p>
      <p className="exp-nota exp-nota--espejo">
        <span>{formatearFrescura(estadoResumenEspejo)}</span>
      </p>
      <p className="exp-nota">
        Cada proceso se descubre automáticamente agrupando expedientes por el asunto con el que
        ENTRARON (no el de cada etapa, que cambia en el camino). El flujo mostrado es la "columna
        vertebral" — el camino de oficinas por el que pasa más gente, aunque ninguna ruta exacta,
        paso a paso, sea mayoría — y no la simple secuencia más repetida, que casi siempre representa
        a muy pocos expedientes.
      </p>

      <Pestanas pestanas={PESTANAS} activa={pestana} onCambiar={setPestana} etiqueta="Secciones de calidad de procesos" />

      <div role="tabpanel" id={idPanel(pestana)} aria-labelledby={idPestana(pestana)}>
        {pestana === 'procesos' && (
          <PanelProcesos
            estado={estadoProcesos}
            reintentar={cargarProcesos}
            seleccionado={procesoSeleccionado}
            onSeleccionar={seleccionarProceso}
            puedeGestionar={puedeGestionar}
            editandoNombre={editandoNombre}
            nombreEditado={nombreEditado}
            onCambiarNombreEditado={setNombreEditado}
            onEmpezarEdicion={empezarEdicion}
            onCancelarEdicion={() => setEditandoNombre(null)}
            onGuardarNombre={guardarNombre}
            guardandoNombre={guardandoNombre}
          />
        )}

        {pestana === 'flujo' && (
          <PanelFlujo
            estado={estadoFlujo}
            reintentar={reintentarFlujo}
            procesoActivo={procesoActivo}
            haySeleccion={procesoSeleccionado !== null}
          />
        )}

        {pestana === 'propuesta' && (
          <PanelPropuesta estado={estadoPropuesta} reintentar={reintentarPropuesta} haySeleccion={procesoSeleccionado !== null} />
        )}
      </div>

      {pestana !== 'propuesta' && <GlosarioMetricas claves={[...GLOSARIO_CLAVES]} />}
    </main>
  );
}

function PanelProcesos({
  estado,
  reintentar,
  seleccionado,
  onSeleccionar,
  puedeGestionar,
  editandoNombre,
  nombreEditado,
  onCambiarNombreEditado,
  onEmpezarEdicion,
  onCancelarEdicion,
  onGuardarNombre,
  guardandoNombre,
}: {
  estado: EstadoProcesos;
  reintentar: () => void;
  seleccionado: string | null;
  onSeleccionar: (clave: string) => void;
  puedeGestionar: boolean;
  editandoNombre: string | null;
  nombreEditado: string;
  onCambiarNombreEditado: (valor: string) => void;
  onEmpezarEdicion: (proceso: ResumenProceso) => void;
  onCancelarEdicion: () => void;
  onGuardarNombre: (clave: string) => void;
  guardandoNombre: boolean;
}) {
  if (estado.tipo === 'error') {
    return (
      <div className="state-message is-error" role="alert">
        <p>No se pudieron listar los procesos.</p>
        <p>{estado.mensaje}</p>
        <button className="retry-button" onClick={reintentar}>Reintentar</button>
      </div>
    );
  }

  if (estado.tipo === 'cargando') {
    return <TableSkeleton rows={6} columnas={6} etiqueta="Detectando procesos" />;
  }

  if (estado.datos.length === 0) {
    return (
      <div className="state-message">
        <p>No se detectó ningún proceso con muestra suficiente en este período.</p>
        <p className="exp-nota">
          Si el sistema acaba de instalarse, puede que el espejo todavía no se haya refrescado por
          primera vez — la nota de arriba indica el estado.
        </p>
      </div>
    );
  }

  return (
    <div className="table-card table-scroll">
      <table className="tabla-procesos">
        <thead>
          <tr>
            <th scope="col">Proceso</th>
            <th scope="col">Expedientes</th>
            <th scope="col">Pasos prom.</th>
            <th scope="col">Duración mediana</th>
            <th scope="col">Cobertura columna</th>
            <th scope="col">Cobertura ruta exacta</th>
            {puedeGestionar && <th scope="col"><span className="sr-only">Acciones</span></th>}
          </tr>
        </thead>
        <tbody>
          {estado.datos.map((p) => (
            <tr key={p.clave} className={p.clave === seleccionado ? 'is-activo' : undefined}>
              <td>
                {editandoNombre === p.clave ? (
                  <div className="proceso-edicion">
                    <input
                      value={nombreEditado}
                      onChange={(e) => onCambiarNombreEditado(e.target.value)}
                      maxLength={120}
                      autoFocus
                    />
                    <button className="boton-secundario" disabled={guardandoNombre} onClick={() => onGuardarNombre(p.clave)}>
                      Guardar
                    </button>
                    <button className="boton-enlace" disabled={guardandoNombre} onClick={onCancelarEdicion}>
                      Cancelar
                    </button>
                  </div>
                ) : (
                  <button className="boton-enlace proceso-boton-seleccionar" onClick={() => onSeleccionar(p.clave)}>
                    <NombreProceso proceso={p} />
                  </button>
                )}
              </td>
              <td>{p.expedientes}</td>
              <td>{p.pasosPromedio ?? '—'}</td>
              <td>{formatearHoras(p.duracionMedianaHoras)}</td>
              <td>{formatearPorcentaje(p.coberturaColumna)}</td>
              <td>{formatearPorcentaje(p.coberturaRutaExacta)}</td>
              {puedeGestionar && (
                <td>
                  {editandoNombre !== p.clave && (
                    <button className="boton-enlace" onClick={() => onEmpezarEdicion(p)}>Renombrar</button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PanelFlujo({
  estado,
  reintentar,
  procesoActivo,
  haySeleccion,
}: {
  estado: EstadoFlujo;
  reintentar: () => void;
  procesoActivo: ResumenProceso | null;
  haySeleccion: boolean;
}) {
  if (!haySeleccion) {
    return <div className="state-message"><p>Elegí un proceso en "Procesos detectados" para ver su flujo.</p></div>;
  }

  if (estado.tipo === 'error') {
    return (
      <div className="state-message is-error" role="alert">
        <p>No se pudo calcular el flujo del proceso.</p>
        <p>{estado.mensaje}</p>
        <button className="retry-button" onClick={reintentar}>Reintentar</button>
      </div>
    );
  }

  if (estado.tipo === 'cargando' || estado.tipo === 'ocioso') {
    return <TableSkeleton rows={4} columnas={3} etiqueta="Calculando el flujo" />;
  }

  const { datos } = estado;

  return (
    <div className="flujo-panel">
      <div className="flujo-cabecera">
        <h2>{procesoActivo?.nombre ?? datos.nombre}</h2>
        <p className="exp-nota">
          {datos.expedientes} expedientes · columna vertebral con {datos.coberturaColumna ?? 0}% de
          cobertura
          {datos.rutaExacta && ` · la ruta exacta más repetida cubre solo ${datos.rutaExacta.cobertura}% (${datos.rutasDistintas} rutas distintas en total)`}
        </p>
      </div>

      <Flujograma nodos={datos.columna} />

      {datos.opcionales.length > 0 && (
        <div className="flujograma-opcionales">
          <h3>Pasos opcionales frecuentes</h3>
          <p className="exp-nota">
            Oficinas por las que pasa una parte relevante de los expedientes pero que no forman parte
            de la columna principal — ninguna, por sí sola, es mayoría. Aquí es donde se compara, por
            ejemplo, una conformidad técnica que distintas oficinas resuelven en tiempos distintos.
          </p>
          <div className="table-card table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Oficina</th>
                  <th scope="col">Expedientes</th>
                  <th scope="col">Cobertura</th>
                  <th scope="col">Mediana</th>
                  <th scope="col">P25</th>
                </tr>
              </thead>
              <tbody>
                {datos.opcionales.map((o) => (
                  <tr key={o.coDependencia}>
                    <td>{o.nombreDependencia}</td>
                    <td>{o.expedientes}</td>
                    <td>{o.cobertura}%</td>
                    <td>{formatearHoras(o.medianaHoras)}</td>
                    <td>{formatearHoras(o.p25Horas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function origenObjetivoTexto(origen: 'comparable' | 'propio' | null): string {
  if (origen === 'comparable') return 'Percentil entre oficinas comparables';
  if (origen === 'propio') return 'Sin muestra suficiente — mejor cuartil propio';
  return 'Sin objetivo calculable';
}

function PanelPropuesta({
  estado,
  reintentar,
  haySeleccion,
}: {
  estado: EstadoPropuesta;
  reintentar: () => void;
  haySeleccion: boolean;
}) {
  if (!haySeleccion) {
    return <div className="state-message"><p>Elegí un proceso en "Procesos detectados" para ver su propuesta.</p></div>;
  }

  if (estado.tipo === 'error') {
    return (
      <div className="state-message is-error" role="alert">
        <p>No se pudo calcular la propuesta de mejora.</p>
        <p>{estado.mensaje}</p>
        <button className="retry-button" onClick={reintentar}>Reintentar</button>
      </div>
    );
  }

  if (estado.tipo === 'cargando' || estado.tipo === 'ocioso') {
    return <TableSkeleton rows={4} columnas={4} etiqueta="Calculando la propuesta" />;
  }

  const { datos } = estado;

  return (
    <div className="propuesta-panel">
      <div className="rag-grid">
        <section className="rag-tarjeta">
          <h2>Tiempo actual (suma de medianas)</h2>
          <p className="dashboard-stat">{formatearHoras(datos.totalActualHoras)}</p>
        </section>
        <section className="rag-tarjeta">
          <h2>Tiempo propuesto</h2>
          <p className="dashboard-stat">{formatearHoras(datos.totalPropuestoHoras)}</p>
        </section>
        <section className="rag-tarjeta">
          <h2>Ahorro estimado</h2>
          <p className="dashboard-stat">
            {formatearHoras(datos.ahorroHoras)}
            {datos.ahorroPorcentaje !== null && ` (${datos.ahorroPorcentaje}%)`}
          </p>
        </section>
      </div>

      <p className="exp-nota">
        Objetivo: percentil {datos.percentilObjetivo} del tiempo que toma la MISMA tarea (mismo
        motivo de derivación y tipo de documento) en todas las oficinas que la hacen — no el mínimo
        absoluto, que suele ser un caso atípico.
      </p>

      <div className="table-card table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Oficina</th>
              <th scope="col">Actual (mediana)</th>
              <th scope="col">Objetivo</th>
              <th scope="col">Origen del objetivo</th>
              <th scope="col">Mejor oficina hoy</th>
              <th scope="col">Muestra comparable</th>
              <th scope="col">Ahorro</th>
            </tr>
          </thead>
          <tbody>
            {datos.pasos.map((paso) => (
              <tr key={paso.coDependencia}>
                <td>{paso.nombreDependencia}</td>
                <td>{formatearHoras(paso.actualMedianaHoras)}</td>
                <td>{formatearHoras(paso.objetivoHoras)}</td>
                <td>{origenObjetivoTexto(paso.origenObjetivo)}</td>
                <td>{paso.mejorOficina ? `${paso.mejorOficina.nombreDependencia} (${formatearHoras(paso.mejorOficina.medianaHoras)})` : '—'}</td>
                <td>{paso.muestra}</td>
                <td>{paso.ahorroHoras !== null ? formatearHoras(paso.ahorroHoras) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
