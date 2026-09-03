import type { Dependencia } from '../api/dependencias';
import type { UsuarioDependencia } from '../api/seguimiento';

interface Props {
  dependencias: Dependencia[];
  usuarios: UsuarioDependencia[];
  cargandoDependencias: boolean;
  cargandoUsuarios: boolean;
  coDependencia: string;
  coEmpleado: string;
  onCambiarDependencia: (valor: string) => void;
  onCambiarUsuario: (valor: string) => void;
}

export function FiltroDependenciaUsuario({
  dependencias,
  usuarios,
  cargandoDependencias,
  cargandoUsuarios,
  coDependencia,
  coEmpleado,
  onCambiarDependencia,
  onCambiarUsuario,
}: Props) {
  return (
    <div className="filtros">
      <div className="campo">
        <label htmlFor="filtro-dependencia">Dependencia</label>
        <select
          id="filtro-dependencia"
          value={coDependencia}
          disabled={cargandoDependencias}
          onChange={(e) => onCambiarDependencia(e.target.value)}
        >
          <option value="">{cargandoDependencias ? 'Cargando…' : 'Seleccione una dependencia'}</option>
          {dependencias.map((dep) => (
            <option key={dep.coDependencia} value={dep.coDependencia}>
              {dep.deSigla ? `${dep.deSigla} — ${dep.deDependencia}` : dep.deDependencia}
            </option>
          ))}
        </select>
      </div>

      <div className="campo">
        <label htmlFor="filtro-usuario">Usuario</label>
        <select
          id="filtro-usuario"
          value={coEmpleado}
          disabled={!coDependencia || cargandoUsuarios}
          onChange={(e) => onCambiarUsuario(e.target.value)}
        >
          <option value="">
            {!coDependencia
              ? 'Primero elija una dependencia'
              : cargandoUsuarios
                ? 'Cargando…'
                : usuarios.length === 0
                  ? 'Sin usuarios con movimiento'
                  : 'Seleccione un usuario'}
          </option>
          {usuarios.map((u) => (
            <option key={u.coEmpleado} value={u.coEmpleado}>
              {u.nombreCompleto ?? `(empleado ${u.coEmpleado})`} · {u.recibidos} recibidos
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
