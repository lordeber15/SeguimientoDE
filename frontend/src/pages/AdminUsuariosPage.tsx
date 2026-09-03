import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  cambiarHabilitado,
  fetchAccesos,
  fetchRoles,
  fetchUsuariosAdmin,
  guardarRoles,
  type Acceso,
  type Rol,
  type UsuarioAdmin,
} from '../api/admin';
import { useSesion } from '../auth/SesionContext';
import { TableSkeleton } from '../components/TableSkeleton';

type Estado =
  | { tipo: 'cargando' }
  | { tipo: 'error'; mensaje: string }
  | { tipo: 'listo'; usuarios: UsuarioAdmin[]; roles: Rol[] };

/** El SGD usa códigos de una letra; solo `A` puede entrar (ver authService.validarEstado). */
const ESTADO_SGD: Record<string, string> = {
  A: 'Activo',
  I: 'Bloqueado',
  N: 'Debe cambiar clave',
  X: 'Dado de baja',
  B: 'Baja',
};

export function AdminUsuariosPage() {
  const { usuario: yo } = useSesion();
  const [estado, setEstado] = useState<Estado>({ tipo: 'cargando' });
  const [busqueda, setBusqueda] = useState('');
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);
  const [accesos, setAccesos] = useState<Acceso[] | null>(null);

  const cargar = useCallback(() => {
    setEstado({ tipo: 'cargando' });
    Promise.all([fetchUsuariosAdmin(), fetchRoles()])
      .then(([usuarios, roles]) => setEstado({ tipo: 'listo', usuarios, roles }))
      .catch((error: unknown) =>
        setEstado({
          tipo: 'error',
          mensaje: error instanceof Error ? error.message : 'Error desconocido',
        }),
      );
  }, []);

  useEffect(() => cargar(), [cargar]);

  async function alternarRol(usuario: UsuarioAdmin, rol: string) {
    const nuevos = usuario.roles.includes(rol)
      ? usuario.roles.filter((r) => r !== rol)
      : [...usuario.roles, rol];

    try {
      await guardarRoles(usuario.codUser, nuevos);
      setAviso({ tipo: 'ok', texto: `Roles de ${usuario.nombre ?? usuario.codUser} actualizados.` });
      cargar();
    } catch (error: unknown) {
      setAviso({
        tipo: 'error',
        texto: error instanceof Error ? error.message : 'No se pudieron guardar los roles',
      });
    }
  }

  async function alternarAcceso(usuario: UsuarioAdmin) {
    try {
      await cambiarHabilitado(usuario.codUser, !usuario.habilitado);
      cargar();
    } catch (error: unknown) {
      setAviso({
        tipo: 'error',
        texto: error instanceof Error ? error.message : 'No se pudo cambiar el acceso',
      });
    }
  }

  const filtrados = useMemo(() => {
    if (estado.tipo !== 'listo') return [];
    const termino = busqueda.trim().toLowerCase();
    if (!termino) return estado.usuarios;
    return estado.usuarios.filter((u) =>
      [u.codUser, u.nombre, u.nuDni, u.deDependencia].some((c) =>
        c?.toLowerCase().includes(termino),
      ),
    );
  }, [estado, busqueda]);

  return (
    <main className="app-main app-main--ancho">
      <div className="state-message admin-intro">
        Los usuarios aparecen aquí <strong>la primera vez que entran</strong>: las credenciales son
        las del SGD y este sistema no las crea ni las modifica. Lo que sí se administra aquí son los
        roles y el acceso a esta aplicación.
      </div>

      {aviso && (
        <div className={`state-message ${aviso.tipo === 'error' ? 'is-error' : ''}`} role="status">
          {aviso.texto}
        </div>
      )}

      {estado.tipo === 'cargando' && <TableSkeleton columnas={6} etiqueta="Cargando usuarios" />}

      {estado.tipo === 'error' && (
        <div className="state-message is-error" role="alert">
          <p>No se pudo cargar la lista de usuarios.</p>
          <p>{estado.mensaje}</p>
          <button className="retry-button" onClick={cargar}>
            Reintentar
          </button>
        </div>
      )}

      {estado.tipo === 'listo' && (
        <>
          <div className="toolbar">
            <input
              type="search"
              className="search-input"
              placeholder="Buscar por nombre, usuario, DNI o dependencia…"
              aria-label="Buscar usuario"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
            />
            <button
              className="boton-secundario"
              onClick={() => (accesos ? setAccesos(null) : fetchAccesos(50).then(setAccesos))}
            >
              {accesos ? 'Ocultar accesos' : 'Ver últimos accesos'}
            </button>
          </div>

          {accesos && (
            <div className="table-card">
              <table className="tabla-expedientes">
                <thead>
                  <tr>
                    <th scope="col">Usuario</th>
                    <th scope="col">Resultado</th>
                    <th scope="col">Motivo</th>
                    <th scope="col">IP</th>
                    <th scope="col">Fecha</th>
                  </tr>
                </thead>
                <tbody>
                  {accesos.map((a, i) => (
                    <tr key={`${a.codUser}-${a.feIntento}-${i}`}>
                      <td>{a.codUser}</td>
                      <td>
                        <span className={`badge ${a.exito ? 'badge-atendido' : 'badge-pendiente'}`}>
                          {a.exito ? 'Entró' : 'Falló'}
                        </span>
                      </td>
                      <td>{a.motivo ?? '—'}</td>
                      <td>{a.ip ?? '—'}</td>
                      <td className="celda-fecha">{new Date(a.feIntento).toLocaleString('es-PE')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="result-count">
            <strong>{filtrados.length}</strong> de {estado.usuarios.length} usuario(s)
          </p>

          <div className="table-card">
            <div className="table-scroll">
              <table className="tabla-expedientes">
                <thead>
                  <tr>
                    <th scope="col">Usuario</th>
                    <th scope="col">Dependencia</th>
                    <th scope="col">Estado en el SGD</th>
                    <th scope="col">Roles</th>
                    <th scope="col">Último acceso</th>
                    <th scope="col">Acceso</th>
                  </tr>
                </thead>
                <tbody>
                  {filtrados.map((u) => (
                    <tr key={u.codUser}>
                      <td>
                        <div className="exp-numero">{u.nombre ?? u.codUser}</div>
                        <div className="exp-nota">
                          {u.codUser}
                          {u.nuDni ? ` · DNI ${u.nuDni}` : ''}
                          {u.codUser === yo?.codUser ? ' · usted' : ''}
                        </div>
                      </td>
                      <td>{u.deDependencia ?? '—'}</td>
                      <td>
                        {u.existeEnSgd ? (
                          <span className={`badge ${u.estadoSgd === 'A' ? 'badge-atendido' : 'badge-pendiente'}`}>
                            {ESTADO_SGD[u.estadoSgd ?? ''] ?? u.estadoSgd ?? '—'}
                          </span>
                        ) : (
                          <span className="badge badge-pendiente">Ya no existe</span>
                        )}
                      </td>
                      <td>
                        <div className="roles-celda">
                          {estado.roles.map((rol) => (
                            <label key={rol.codigo} className="rol-chip">
                              <input
                                type="checkbox"
                                checked={u.roles.includes(rol.codigo)}
                                onChange={() => alternarRol(u, rol.codigo)}
                                aria-label={`${rol.nombre} para ${u.nombre ?? u.codUser}`}
                              />
                              <span>{rol.nombre}</span>
                            </label>
                          ))}
                        </div>
                      </td>
                      <td className="celda-fecha">
                        {u.feUltimoAcceso ? new Date(u.feUltimoAcceso).toLocaleString('es-PE') : 'Nunca'}
                      </td>
                      <td>
                        <button
                          className="boton-enlace"
                          onClick={() => alternarAcceso(u)}
                          disabled={u.codUser === yo?.codUser}
                          title={
                            u.codUser === yo?.codUser
                              ? 'No puede quitarse el acceso a sí mismo'
                              : undefined
                          }
                        >
                          {u.habilitado ? 'Deshabilitar' : 'Habilitar'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
