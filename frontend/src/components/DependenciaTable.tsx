import { Fragment, useState } from 'react';
import type { Dependencia } from '../api/dependencias';
import { EncargaturaBadge } from './EncargaturaBadge';

interface Props {
  dependencias: Dependencia[];
  /** "Jefe / Responsable" para instituciones, "Presidente / Encargado" para comités. */
  etiquetaJefe?: string;
}

function idFilaMiembros(coDependencia: string): string {
  return `miembros-${coDependencia}`;
}

export function DependenciaTable({ dependencias, etiquetaJefe = 'Jefe / Responsable' }: Props) {
  const [expandidas, setExpandidas] = useState<Set<string>>(new Set());

  function alternar(coDependencia: string) {
    setExpandidas((anterior) => {
      const siguiente = new Set(anterior);
      if (siguiente.has(coDependencia)) siguiente.delete(coDependencia);
      else siguiente.add(coDependencia);
      return siguiente;
    });
  }

  return (
    <div className="table-card">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Dependencia</th>
              <th scope="col">Código</th>
              <th scope="col">{etiquetaJefe}</th>
              <th scope="col">Depende de</th>
              <th scope="col">Miembros</th>
            </tr>
          </thead>
          <tbody>
            {dependencias.map((dep) => {
              const expandida = expandidas.has(dep.coDependencia);
              return (
                <Fragment key={dep.coDependencia}>
                  <tr>
                    <td>
                      <div className="dep-name">{dep.deDependencia}</div>
                      {dep.deSigla && <div className="dep-sigla">{dep.deSigla}</div>}
                    </td>
                    <td className="dep-code">{dep.coDependencia}</td>
                    <td>
                      {dep.jefe ? (
                        <>
                          <div className="dep-name">{dep.jefe.nombreCompleto}</div>
                          {dep.cargoDescripcion && <div className="dep-sigla">{dep.cargoDescripcion}</div>}
                          <EncargaturaBadge tipo={dep.coTipoEncargatura} descripcion={dep.tipoEncargaturaDescripcion} />
                        </>
                      ) : (
                        <span className="dep-sigla">Sin jefe asignado</span>
                      )}
                    </td>
                    <td className="dep-sigla">{dep.padre?.deDependencia ?? '—'}</td>
                    <td>
                      {dep.miembros.length > 0 ? (
                        <button
                          type="button"
                          className="link-button"
                          aria-expanded={expandida}
                          aria-controls={idFilaMiembros(dep.coDependencia)}
                          onClick={() => alternar(dep.coDependencia)}
                        >
                          {expandida ? 'Ocultar' : `Ver (${dep.miembros.length})`}
                        </button>
                      ) : (
                        <span className="dep-sigla">Sin miembros registrados</span>
                      )}
                    </td>
                  </tr>
                  {expandida && (
                    <tr id={idFilaMiembros(dep.coDependencia)} className="fila-miembros">
                      <td colSpan={5}>
                        <ul className="lista-miembros">
                          {dep.miembros.map((miembro) => (
                            <li key={miembro.coEmpleado}>
                              <span className="dep-name">{miembro.nombreCompleto}</span>
                              {miembro.cargoDescripcion && <span className="dep-sigla"> — {miembro.cargoDescripcion}</span>}
                              {dep.jefe?.cempCodemp === miembro.coEmpleado && <span className="badge badge-titular">Jefe</span>}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
