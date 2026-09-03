import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { fetchDependencias, type Dependencia } from '../api/dependencias';
import { DependenciaTable } from '../components/DependenciaTable';
import { TableSkeleton } from '../components/TableSkeleton';

type Estado =
  | { tipo: 'cargando' }
  | { tipo: 'error'; mensaje: string }
  | { tipo: 'listo'; dependencias: Dependencia[] };

export function DependenciasPage() {
  const [estado, setEstado] = useState<Estado>({ tipo: 'cargando' });
  const [busqueda, setBusqueda] = useState('');
  const busquedaDiferida = useDeferredValue(busqueda);

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

  const dependenciasFiltradas = useMemo(() => {
    if (estado.tipo !== 'listo') return [];
    const termino = busquedaDiferida.trim().toLowerCase();
    if (!termino) return estado.dependencias;

    return estado.dependencias.filter((dep) => {
      const campos = [dep.deDependencia, dep.deSigla, dep.jefe?.nombreCompleto, dep.coDependencia];
      return campos.some((campo) => campo?.toLowerCase().includes(termino));
    });
  }, [estado, busquedaDiferida]);

  return (
    <main className="app-main">
      <div className="toolbar">
        <input
          type="search"
          className="search-input"
          placeholder="Buscar por dependencia, sigla o jefe..."
          aria-label="Buscar dependencia"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          disabled={estado.tipo !== 'listo'}
        />
        {estado.tipo === 'listo' && (
          <span className="result-count">
            {dependenciasFiltradas.length} de {estado.dependencias.length} dependencias
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

      {estado.tipo === 'listo' && dependenciasFiltradas.length === 0 && (
        <div className="state-message">No se encontraron dependencias que coincidan con la búsqueda.</div>
      )}

      {estado.tipo === 'listo' && dependenciasFiltradas.length > 0 && (
        <DependenciaTable dependencias={dependenciasFiltradas} />
      )}
    </main>
  );
}
