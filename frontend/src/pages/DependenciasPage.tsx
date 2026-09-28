import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { fetchDependencias, type Dependencia } from '../api/dependencias';
import { DependenciaTable } from '../components/DependenciaTable';
import { idPanel, idPestana, Pestanas } from '../components/Pestanas';
import { TableSkeleton } from '../components/TableSkeleton';

type Estado =
  | { tipo: 'cargando' }
  | { tipo: 'error'; mensaje: string }
  | { tipo: 'listo'; dependencias: Dependencia[] };

/** Sub-pestañas que separan instituciones (`esComite: false`) de comités de evaluación
 *  (`esComite: true`) — mismo criterio que usa el dashboard (Fase 6). */
const CATEGORIAS = [
  { clave: 'institucion', etiqueta: 'Instituciones' },
  { clave: 'comite', etiqueta: 'Comités' },
] as const;

type Categoria = (typeof CATEGORIAS)[number]['clave'];

function categoriasConContador(nInstituciones: number, nComites: number) {
  return CATEGORIAS.map((c) => ({
    ...c,
    etiqueta: `${c.etiqueta} (${c.clave === 'institucion' ? nInstituciones : nComites})`,
  }));
}

interface ComiteDePersona {
  coDependencia: string;
  nombre: string | null;
  rol: 'Presidente / Encargado' | 'Miembro';
}

interface ResultadoPersona {
  coEmpleado: string;
  nombre: string | null;
  comites: ComiteDePersona[];
}

/** Agrupa, por persona que coincide con `termino`, en qué comités aparece y con qué rol: el jefe
 *  de la dependencia (`RHTM_DEPENDENCIA.CO_EMPLEADO`) es el presidente/encargado; el resto de
 *  `miembros` son miembros. Presidente y miembros no se solapan (ver dependenciaController). */
function buscarPersonaEnComites(comites: Dependencia[], termino: string): ResultadoPersona[] {
  const porPersona = new Map<string, ResultadoPersona>();

  function agregar(coEmpleado: string, nombre: string | null, comite: ComiteDePersona) {
    const existente = porPersona.get(coEmpleado);
    if (existente) {
      existente.comites.push(comite);
    } else {
      porPersona.set(coEmpleado, { coEmpleado, nombre, comites: [comite] });
    }
  }

  for (const comite of comites) {
    if (comite.jefe && comite.jefe.nombreCompleto?.toLowerCase().includes(termino)) {
      agregar(comite.jefe.cempCodemp, comite.jefe.nombreCompleto, {
        coDependencia: comite.coDependencia,
        nombre: comite.deDependencia,
        rol: 'Presidente / Encargado',
      });
    }
    for (const miembro of comite.miembros) {
      if (miembro.coEmpleado === comite.jefe?.cempCodemp) continue;
      if (!miembro.nombreCompleto?.toLowerCase().includes(termino)) continue;
      agregar(miembro.coEmpleado, miembro.nombreCompleto, {
        coDependencia: comite.coDependencia,
        nombre: comite.deDependencia,
        rol: 'Miembro',
      });
    }
  }

  return [...porPersona.values()].sort((a, b) => (a.nombre ?? '').localeCompare(b.nombre ?? ''));
}

export function DependenciasPage() {
  const [estado, setEstado] = useState<Estado>({ tipo: 'cargando' });
  const [busqueda, setBusqueda] = useState('');
  const [categoria, setCategoria] = useState<Categoria>('institucion');
  const [busquedaPersona, setBusquedaPersona] = useState('');
  const busquedaDiferida = useDeferredValue(busqueda);
  const busquedaPersonaDiferida = useDeferredValue(busquedaPersona);

  useEffect(() => {
    cargar();
  }, []);

  async function cargar() {
    setEstado({ tipo: 'cargando' });
    try {
      const dependencias = await fetchDependencias();
      setEstado({ tipo: 'listo', dependencias });
    } catch (error) {
      setEstado({
        tipo: 'error',
        mensaje: error instanceof Error ? error.message : 'Error desconocido al cargar dependencias',
      });
    }
  }

  const { instituciones, comites } = useMemo(() => {
    if (estado.tipo !== 'listo') return { instituciones: [] as Dependencia[], comites: [] as Dependencia[] };
    return {
      instituciones: estado.dependencias.filter((d) => !d.esComite),
      comites: estado.dependencias.filter((d) => d.esComite),
    };
  }, [estado]);

  const listaCategoria = categoria === 'institucion' ? instituciones : comites;

  const resultadosPersona = useMemo(() => {
    const termino = busquedaPersonaDiferida.trim().toLowerCase();
    if (categoria !== 'comite' || !termino) return null;
    return buscarPersonaEnComites(comites, termino);
  }, [categoria, comites, busquedaPersonaDiferida]);

  const dependenciasFiltradas = useMemo(() => {
    const termino = busquedaDiferida.trim().toLowerCase();
    let base = listaCategoria;

    if (resultadosPersona) {
      const deps = new Set(resultadosPersona.flatMap((p) => p.comites.map((c) => c.coDependencia)));
      base = base.filter((dep) => deps.has(dep.coDependencia));
    }

    if (!termino) return base;

    return base.filter((dep) => {
      const campos = [
        dep.deDependencia,
        dep.deSigla,
        dep.jefe?.nombreCompleto,
        dep.coDependencia,
        ...dep.miembros.map((m) => m.nombreCompleto),
      ];
      return campos.some((campo) => campo?.toLowerCase().includes(termino));
    });
  }, [listaCategoria, busquedaDiferida, resultadosPersona]);

  return (
    <main className="app-main">
      <div className="toolbar">
        <input
          type="search"
          className="search-input"
          placeholder="Buscar por dependencia, sigla, jefe o miembro..."
          aria-label="Buscar dependencia"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          disabled={estado.tipo !== 'listo'}
        />
        {estado.tipo === 'listo' && (
          <span className="result-count">
            {dependenciasFiltradas.length} de {listaCategoria.length}{' '}
            {categoria === 'institucion' ? 'instituciones' : 'comités'}
          </span>
        )}
      </div>

      {estado.tipo === 'cargando' && <TableSkeleton etiqueta="Cargando dependencias" />}

      {estado.tipo === 'error' && (
        <div className="state-message is-error" role="alert">
          <p>No se pudo cargar la lista de dependencias.</p>
          <p>{estado.mensaje}</p>
          <button className="retry-button" onClick={cargar}>
            Reintentar
          </button>
        </div>
      )}

      {estado.tipo === 'listo' && (
        <>
          <Pestanas
            pestanas={categoriasConContador(instituciones.length, comites.length)}
            activa={categoria}
            onCambiar={setCategoria}
            etiqueta="Tipo de dependencia"
          />

          <div role="tabpanel" id={idPanel(categoria)} aria-labelledby={idPestana(categoria)}>
            {categoria === 'comite' && (
              <div className="toolbar">
                <input
                  type="search"
                  className="search-input"
                  placeholder="Buscar persona en comités..."
                  aria-label="Buscar persona en comités"
                  value={busquedaPersona}
                  onChange={(e) => setBusquedaPersona(e.target.value)}
                />
              </div>
            )}

            {resultadosPersona && (
              <div className="table-card panel-busqueda-persona">
                {resultadosPersona.length === 0 ? (
                  <div className="state-message">Ninguna persona coincide en los comités.</div>
                ) : (
                  <ul className="lista-personas-comite">
                    {resultadosPersona.map((persona) => (
                      <li key={persona.coEmpleado}>
                        <div className="dep-name">
                          {persona.nombre} — {persona.comites.length}{' '}
                          {persona.comites.length === 1 ? 'comité' : 'comités'}
                        </div>
                        <ul className="lista-comites-persona">
                          {persona.comites.map((c) => (
                            <li key={c.coDependencia}>
                              <span className="dep-sigla">{c.nombre}</span>
                              <span className={c.rol === 'Miembro' ? 'badge badge-encargado' : 'badge badge-titular'}>
                                {c.rol}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {dependenciasFiltradas.length === 0 && !(resultadosPersona && resultadosPersona.length === 0) && (
              <div className="state-message">
                No se encontraron {categoria === 'institucion' ? 'instituciones' : 'comités'} que coincidan con la
                búsqueda.
              </div>
            )}

            {dependenciasFiltradas.length > 0 && (
              <DependenciaTable
                dependencias={dependenciasFiltradas}
                etiquetaJefe={categoria === 'comite' ? 'Presidente / Encargado' : 'Jefe / Responsable'}
              />
            )}
          </div>
        </>
      )}
    </main>
  );
}
