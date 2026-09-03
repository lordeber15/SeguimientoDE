import type { Dependencia } from '../api/dependencias';
import { EncargaturaBadge } from './EncargaturaBadge';

interface Props {
  dependencias: Dependencia[];
}

export function DependenciaTable({ dependencias }: Props) {
  return (
    <div className="table-card">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Dependencia</th>
              <th scope="col">Código</th>
              <th scope="col">Jefe / Responsable</th>
              <th scope="col">Depende de</th>
            </tr>
          </thead>
          <tbody>
            {dependencias.map((dep) => (
              <tr key={dep.coDependencia}>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
