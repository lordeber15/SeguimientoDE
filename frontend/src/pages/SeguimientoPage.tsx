import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { fetchEstadosIndexacion, type EstadoIngestaExpediente } from '../api/chat';
import { fetchDependencias, type Dependencia } from '../api/dependencias';
import {
  buscarExpediente,
  fetchExpedientes,
  fetchUsuarios,
  formatearDuracion,
  type ExpedienteEncontrado,
  type ExpedienteSeguimiento,
  type UsuarioDependencia,
} from '../api/seguimiento';
import { useSesion } from '../auth/SesionContext';
import { ExpedienteCompleto } from '../components/ExpedienteCompleto';
import { ExpedienteTable, type Indexacion, type ModoTiempo } from '../components/ExpedienteTable';
import { FiltroDependenciaUsuario } from '../components/FiltroDependenciaUsuario';
import { idPanel, idPestana, Pestanas } from '../components/Pestanas';
import { TableSkeleton } from '../components/TableSkeleton';
import { UnirPdfModal } from '../components/UnirPdfModal';
import { VisorDocumento } from '../components/VisorDocumento';

// Identidad estable a nivel de módulo: evita que el efecto de estados de indexación se dispare de
// nuevo solo porque `estado` cambió de forma (por ejemplo a 'cargando') sin que la LISTA de
// expedientes realmente haya cambiado.
const EXPEDIENTES_VACIOS: ExpedienteSeguimiento[] = [];

const PESTANAS = [
  { clave: 'expediente', etiqueta: 'Expediente' },
  { clave: 'dependencia', etiqueta: 'Dependencia' },
] as const;

type PestanaSeguimiento = (typeof PESTANAS)[number]['clave'];

interface DocumentoAbierto {
  url: string;
  titulo: string;
  visualizable: boolean;
}

interface UnionAbierta {
  nuAnnExp: string;
  nuSecExp: string;
  numeroExpediente: string;
}

type EstadoTabla =
  | { tipo: 'sin-seleccion' }
  | { tipo: 'cargando' }
  | { tipo: 'error'; mensaje: string }
  | { tipo: 'listo'; expedientes: ExpedienteSeguimiento[] };

interface Props {
  /** Ausente cuando el usuario no tiene permiso `rag.consultar` — el botón de chat no se muestra. */
  onAbrirChatExpediente?: (nuAnnExp: string, nuSecExp: string, numeroExpediente: string) => void;
}

export function SeguimientoPage({ onAbrirChatExpediente }: Props) {
  const { puede } = useSesion();
  const puedeGestionarRag = puede('rag.gestionar');

  const [pestana, setPestana] = useState<PestanaSeguimiento>('expediente');

  const [dependencias, setDependencias] = useState<Dependencia[]>([]);
  const [cargandoDependencias, setCargandoDependencias] = useState(true);
  const [errorDependencias, setErrorDependencias] = useState<string | null>(null);

  const [usuarios, setUsuarios] = useState<UsuarioDependencia[]>([]);
  const [cargandoUsuarios, setCargandoUsuarios] = useState(false);

  const [coDependencia, setCoDependencia] = useState('');
  const [coEmpleado, setCoEmpleado] = useState('');
  const [modoTiempo, setModoTiempo] = useState<ModoTiempo>('corridas');
  const [busqueda, setBusqueda] = useState('');
  const busquedaDiferida = useDeferredValue(busqueda);

  const [estado, setEstado] = useState<EstadoTabla>({ tipo: 'sin-seleccion' });
  const [documentoAbierto, setDocumentoAbierto] = useState<DocumentoAbierto | null>(null);
  const [unionAbierta, setUnionAbierta] = useState<UnionAbierta | null>(null);

  const [terminoExpediente, setTerminoExpediente] = useState('');
  const [buscandoExpediente, setBuscandoExpediente] = useState(false);
  const [errorBusquedaExpediente, setErrorBusquedaExpediente] = useState<string | null>(null);
  const [resultadosExpediente, setResultadosExpediente] = useState<ExpedienteEncontrado[] | null>(null);
  // Búsqueda por expediente: vista propia e independiente de la búsqueda por dependencia/usuario
  // de arriba — no toca `coDependencia`/`coEmpleado`/`busqueda` ni depende de ellos.
  const [expedienteAbierto, setExpedienteAbierto] = useState<{
    nuAnnExp: string;
    nuSecExp: string;
    numeroExpediente: string;
  } | null>(null);

  const [estadosIndexacion, setEstadosIndexacion] = useState<Map<string, EstadoIngestaExpediente>>(new Map());
  const [jobEnCurso, setJobEnCurso] = useState<string | null>(null);

  useEffect(() => {
    let vigente = true;

    fetchDependencias()
      .then((datos) => {
        if (vigente) setDependencias(datos);
      })
      .catch((error: unknown) => {
        if (vigente) setErrorDependencias(error instanceof Error ? error.message : 'Error desconocido');
      })
      .finally(() => {
        if (vigente) setCargandoDependencias(false);
      });

    return () => {
      vigente = false;
    };
  }, []);

  // El combo de usuarios depende de la dependencia elegida. La bandera `vigente` descarta la
  // respuesta de una petición previa si el usuario cambió de dependencia mientras estaba en vuelo.
  useEffect(() => {
    if (!coDependencia) {
      setUsuarios([]);
      return;
    }

    let vigente = true;
    setCargandoUsuarios(true);

    fetchUsuarios(coDependencia)
      .then((datos) => {
        if (vigente) setUsuarios(datos);
      })
      .catch(() => {
        if (vigente) setUsuarios([]);
      })
      .finally(() => {
        if (vigente) setCargandoUsuarios(false);
      });

    return () => {
      vigente = false;
    };
  }, [coDependencia]);

  const cargarExpedientes = useCallback(() => {
    if (!coDependencia || !coEmpleado) {
      setEstado({ tipo: 'sin-seleccion' });
      return () => {};
    }

    let vigente = true;
    setEstado({ tipo: 'cargando' });

    fetchExpedientes(coDependencia, coEmpleado)
      .then((datos) => {
        if (vigente) setEstado({ tipo: 'listo', expedientes: datos.items });
      })
      .catch((error: unknown) => {
        if (vigente) {
          setEstado({
            tipo: 'error',
            mensaje: error instanceof Error ? error.message : 'Error desconocido al cargar expedientes',
          });
        }
      });

    return () => {
      vigente = false;
    };
  }, [coDependencia, coEmpleado]);

  useEffect(() => cargarExpedientes(), [cargarExpedientes]);

  const expedientes = estado.tipo === 'listo' ? estado.expedientes : EXPEDIENTES_VACIOS;

  const recargarEstadosIndexacion = useCallback(() => {
    if (!onAbrirChatExpediente || expedientes.length === 0) {
      setEstadosIndexacion(new Map());
      return () => {};
    }

    let vigente = true;
    fetchEstadosIndexacion(expedientes.map((e) => ({ nuAnnExp: e.nuAnnExp, nuSecExp: e.nuSecExp })))
      .then((mapa) => {
        if (vigente) setEstadosIndexacion(mapa);
      })
      .catch(() => {
        // Aviso best-effort: si falla, la columna simplemente no pinta badges — no debe romper
        // el resto de la tabla, que sí es información real y ya cargada.
        if (vigente) setEstadosIndexacion(new Map());
      });

    return () => {
      vigente = false;
    };
  }, [expedientes, onAbrirChatExpediente]);

  useEffect(() => recargarEstadosIndexacion(), [recargarEstadosIndexacion]);

  function cambiarDependencia(valor: string) {
    setCoDependencia(valor);
    setCoEmpleado('');
    setBusqueda('');
  }

  /** Abre la vista de expediente completo — independiente de la búsqueda por dependencia/usuario. */
  function abrirExpediente(resultado: ExpedienteEncontrado) {
    setResultadosExpediente(null);
    setTerminoExpediente('');
    setExpedienteAbierto({
      nuAnnExp: resultado.nuAnnExp,
      nuSecExp: resultado.nuSecExp,
      numeroExpediente: resultado.numeroExpediente ?? `${resultado.nuAnnExp}-${resultado.nuSecExp}`,
    });
  }

  async function buscar(e: React.FormEvent) {
    e.preventDefault();
    const termino = terminoExpediente.trim();
    if (termino.length < 3 || buscandoExpediente) return;

    setBuscandoExpediente(true);
    setErrorBusquedaExpediente(null);
    setResultadosExpediente(null);

    try {
      const resultados = await buscarExpediente(termino);
      if (resultados.length === 1) {
        abrirExpediente(resultados[0]);
      } else {
        setResultadosExpediente(resultados);
      }
    } catch (err) {
      setErrorBusquedaExpediente(err instanceof Error ? err.message : 'No se pudo buscar el expediente');
    } finally {
      setBuscandoExpediente(false);
    }
  }

  const expedientesFiltrados = useMemo(() => {
    if (estado.tipo !== 'listo') return [];
    const termino = busquedaDiferida.trim().toLowerCase();
    if (!termino) return estado.expedientes;

    return estado.expedientes.filter((exp) => {
      const campos = [exp.numeroExpediente, exp.documento.nombre, exp.asunto, exp.estado.descripcion];
      return campos.some((campo) => campo?.toLowerCase().includes(termino));
    });
  }, [estado, busquedaDiferida]);

  const resumen = useMemo(() => {
    const resueltos = expedientesFiltrados
      .map((e) => (modoTiempo === 'habiles' ? e.segundosHabiles : e.segundosCorridos))
      .filter((s): s is number => s !== null);

    const pendientes = expedientesFiltrados.length - resueltos.length;
    const promedio = resueltos.length
      ? Math.round(resueltos.reduce((a, b) => a + b, 0) / resueltos.length)
      : null;

    return { pendientes, promedio: formatearDuracion(promedio) };
  }, [expedientesFiltrados, modoTiempo]);

  const usuarioElegido = usuarios.find((u) => u.coEmpleado === coEmpleado);

  const indexacion: Indexacion | undefined = onAbrirChatExpediente
    ? {
        estados: estadosIndexacion,
        puedeGestionar: puedeGestionarRag,
        jobEnCurso,
        onJobCambio: setJobEnCurso,
        onRefrescar: recargarEstadosIndexacion,
      }
    : undefined;
  const columnasTabla = onAbrirChatExpediente ? 9 : 8;

  return (
    <main className="app-main app-main--ancho">
      <Pestanas
        pestanas={PESTANAS}
        activa={pestana}
        onCambiar={setPestana}
        etiqueta="Cómo buscar los expedientes"
      />

      {pestana === 'expediente' && (
        <div role="tabpanel" id={idPanel('expediente')} aria-labelledby={idPestana('expediente')}>
          <form className="busqueda-expediente" onSubmit={buscar}>
            <label htmlFor="buscar-expediente">Busque por N° de expediente</label>
            <div className="busqueda-expediente-campo">
              <input
                id="buscar-expediente"
                type="search"
                value={terminoExpediente}
                onChange={(e) => setTerminoExpediente(e.target.value)}
                placeholder="Ej. OGAUL02026000058"
              />
              <button type="submit" className="boton-secundario" disabled={buscandoExpediente || terminoExpediente.trim().length < 3}>
                {buscandoExpediente ? 'Buscando…' : 'Buscar'}
              </button>
            </div>
          </form>

          {errorBusquedaExpediente && (
            <div className="state-message is-error" role="alert">
              {errorBusquedaExpediente}
            </div>
          )}

          {resultadosExpediente !== null && resultadosExpediente.length === 0 && (
            <div className="state-message">No se encontró ningún expediente con ese número.</div>
          )}

          {resultadosExpediente !== null && resultadosExpediente.length > 0 && (
            <ul className="resultados-expediente">
              {resultadosExpediente.map((r) => (
                <li key={`${r.nuAnnExp}-${r.nuSecExp}`}>
                  <button type="button" className="boton-enlace" onClick={() => abrirExpediente(r)}>
                    {r.numeroExpediente ?? `${r.nuAnnExp}-${r.nuSecExp}`}
                  </button>
                  <span className="exp-nota">
                    {r.nombreCompleto ?? `empleado ${r.coEmpleado}`} · {r.nombreDependencia ?? r.coDependencia}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {expedienteAbierto && (
            <ExpedienteCompleto
              nuAnnExp={expedienteAbierto.nuAnnExp}
              nuSecExp={expedienteAbierto.nuSecExp}
              numeroExpediente={expedienteAbierto.numeroExpediente}
              onAbrirDocumento={(url, titulo, visualizable) =>
                setDocumentoAbierto({ url, titulo, visualizable })
              }
              onUnirPdf={() =>
                setUnionAbierta({
                  nuAnnExp: expedienteAbierto.nuAnnExp,
                  nuSecExp: expedienteAbierto.nuSecExp,
                  numeroExpediente: expedienteAbierto.numeroExpediente,
                })
              }
              onCerrar={() => setExpedienteAbierto(null)}
            />
          )}

          {!expedienteAbierto && resultadosExpediente === null && !errorBusquedaExpediente && (
            <div className="state-message">
              Escriba al menos 3 caracteres del número de expediente para ver todos sus documentos y
              participantes.
            </div>
          )}
        </div>
      )}

      {pestana === 'dependencia' && (
        <div role="tabpanel" id={idPanel('dependencia')} aria-labelledby={idPestana('dependencia')}>
          <FiltroDependenciaUsuario
            dependencias={dependencias}
            usuarios={usuarios}
            cargandoDependencias={cargandoDependencias}
            cargandoUsuarios={cargandoUsuarios}
            coDependencia={coDependencia}
            coEmpleado={coEmpleado}
            onCambiarDependencia={cambiarDependencia}
            onCambiarUsuario={setCoEmpleado}
          />

          {errorDependencias && (
            <div className="state-message is-error" role="alert">
              <p>No se pudo cargar la lista de dependencias.</p>
              <p>{errorDependencias}</p>
            </div>
          )}

          {estado.tipo === 'listo' && (
            <div className="toolbar">
              <input
                type="search"
                className="search-input"
                placeholder="Buscar por expediente, documento o asunto…"
                aria-label="Buscar expediente"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
              />

              <fieldset className="segmentado">
                <legend className="sr-only">Cómo medir el tiempo de atención</legend>
                <button
                  type="button"
                  className={modoTiempo === 'corridas' ? 'is-activo' : ''}
                  aria-pressed={modoTiempo === 'corridas'}
                  onClick={() => setModoTiempo('corridas')}
                >
                  Horas corridas
                </button>
                <button
                  type="button"
                  className={modoTiempo === 'habiles' ? 'is-activo' : ''}
                  aria-pressed={modoTiempo === 'habiles'}
                  onClick={() => setModoTiempo('habiles')}
                >
                  Días hábiles
                </button>
              </fieldset>
            </div>
          )}

          {estado.tipo === 'listo' && (
            <p className="result-count resumen" aria-live="polite">
              <strong>{expedientesFiltrados.length}</strong> de {estado.expedientes.length} expedientes
              {usuarioElegido?.nombreCompleto ? ` de ${usuarioElegido.nombreCompleto}` : ''}
              {resumen.promedio ? ` · promedio ${resumen.promedio}` : ''}
              {resumen.pendientes > 0 ? ` · ${resumen.pendientes} sin respuesta` : ''}
            </p>
          )}

          {estado.tipo === 'sin-seleccion' && !errorDependencias && (
            <div className="state-message">
              Elija una dependencia y un usuario para ver los expedientes que pasaron por esa persona.
            </div>
          )}

          {estado.tipo === 'cargando' && <TableSkeleton columnas={columnasTabla} etiqueta="Cargando expedientes" />}

          {estado.tipo === 'error' && (
            <div className="state-message is-error" role="alert">
              <p>No se pudieron cargar los expedientes.</p>
              <p>{estado.mensaje}</p>
              <button className="retry-button" onClick={cargarExpedientes}>
                Reintentar
              </button>
            </div>
          )}

          {estado.tipo === 'listo' && expedientesFiltrados.length === 0 && (
            <div className="state-message">
              {estado.expedientes.length === 0
                ? 'Este usuario no tiene expedientes registrados en esta dependencia.'
                : 'Ningún expediente coincide con la búsqueda.'}
            </div>
          )}

          {estado.tipo === 'listo' && expedientesFiltrados.length > 0 && (
            <ExpedienteTable
              expedientes={expedientesFiltrados}
              modoTiempo={modoTiempo}
              coDependencia={coDependencia}
              coEmpleado={coEmpleado}
              onAbrirDocumento={(url, titulo, visualizable) =>
                setDocumentoAbierto({ url, titulo, visualizable })
              }
              onUnirPdf={(nuAnnExp, nuSecExp, numeroExpediente) =>
                setUnionAbierta({ nuAnnExp, nuSecExp, numeroExpediente })
              }
              onAbrirChat={onAbrirChatExpediente}
              indexacion={indexacion}
            />
          )}
        </div>
      )}

      {unionAbierta && (
        <UnirPdfModal
          nuAnnExp={unionAbierta.nuAnnExp}
          nuSecExp={unionAbierta.nuSecExp}
          numeroExpediente={unionAbierta.numeroExpediente}
          onCerrar={() => setUnionAbierta(null)}
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
