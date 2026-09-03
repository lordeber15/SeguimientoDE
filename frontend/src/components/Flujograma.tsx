import { Fragment, useState } from 'react';
import type { NodoFlujo } from '../api/calidadProcesos';

function formatearHoras(horas: number | null): string {
  if (horas === null) return '—';
  if (horas < 1) return `${Math.round(horas * 60)} min`;
  if (horas < 24) return `${horas.toFixed(1)} h`;
  return `${(horas / 24).toFixed(1)} d`;
}

/** Un motivo de derivación sin descripción se muestra por su código crudo — mejor eso que nada,
 *  y le avisa a quien lo vea que ese código no tiene catálogo en esta instalación del SGD. */
function etiquetaMotivo(codigo: string | null): string {
  return codigo ?? 'Sin motivo';
}

/** Cadena vertical de nodos = oficinas, cada uno con su tiempo mediano y su cobertura sobre el
 *  total de expedientes del proceso. Sin librería de grafos: con "solo columna vertebral" el
 *  diagrama es una cadena lineal, así que un SVG/CSS a mano alcanza y evita sumar una dependencia
 *  nueva al frontend (mismo criterio que `TickOficina` en `DashboardPage.tsx`).
 *
 * Cada nodo se expande al mismo patrón `fila-detalle` que ya usa `ExpedienteTable` — un panel
 * abierto a la vez, con el desglose por persona y los motivos más frecuentes de ese paso.
 */
export function Flujograma({ nodos }: { nodos: NodoFlujo[] }) {
  const [abierto, setAbierto] = useState<number | null>(null);

  if (nodos.length === 0) {
    return <p className="exp-nota">No hay columna vertebral con estos filtros — muy pocos expedientes para calcularla.</p>;
  }

  const maxHoras = Math.max(1, ...nodos.map((n) => n.medianaHoras ?? 0));

  return (
    <div className="flujograma" role="list" aria-label="Flujo del proceso, oficina por oficina">
      {nodos.map((nodo, i) => {
        const estaAbierto = abierto === nodo.orden;
        const anchoBarra = Math.max(4, (100 * (nodo.medianaHoras ?? 0)) / maxHoras);
        return (
          <Fragment key={nodo.coDependencia}>
            <div className="flujograma-nodo" role="listitem">
              <button
                type="button"
                className="flujograma-nodo-boton"
                aria-expanded={estaAbierto}
                onClick={() => setAbierto(estaAbierto ? null : nodo.orden)}
              >
                <div className="flujograma-nodo-cabecera">
                  <span className="flujograma-nodo-orden">{nodo.orden}</span>
                  <span className="flujograma-nodo-nombre">{nodo.nombreDependencia}</span>
                  <span className="flujograma-nodo-cobertura">{nodo.cobertura}% de los expedientes</span>
                </div>
                <div className="flujograma-nodo-tiempo">
                  <div className="flujograma-barra">
                    <div className="flujograma-barra-relleno" style={{ width: `${anchoBarra}%` }} />
                  </div>
                  <span className="flujograma-nodo-mediana">{formatearHoras(nodo.medianaHoras)}</span>
                  <span className="sr-only">{estaAbierto ? 'Ocultar detalle' : 'Ver detalle'} de {nodo.nombreDependencia}</span>
                </div>
              </button>

              {estaAbierto && (
                <div className="flujograma-detalle">
                  <div className="detalle-metricas">
                    <div className="detalle-grupo">
                      <h3>Tiempo dentro de la oficina</h3>
                      <dl>
                        <div><dt>Mediana</dt><dd>{formatearHoras(nodo.medianaHoras)}</dd></div>
                        <div><dt>P25 / P75</dt><dd>{formatearHoras(nodo.p25Horas)} / {formatearHoras(nodo.p75Horas)}</dd></div>
                        <div><dt>Espera</dt><dd>{formatearHoras(nodo.esperaMedianaHoras)}</dd></div>
                        <div><dt>Trabajo</dt><dd>{formatearHoras(nodo.trabajoMedianaHoras)}</dd></div>
                        <div><dt>Visitas totales</dt><dd>{nodo.visitas}</dd></div>
                      </dl>
                    </div>
                    <div className="detalle-grupo">
                      <h3>Motivos más frecuentes</h3>
                      <dl>
                        {nodo.motivos.length === 0 && <div><dt>—</dt><dd>Sin datos</dd></div>}
                        {nodo.motivos.map((m) => (
                          <div key={m.codigo ?? '_'}><dt>{etiquetaMotivo(m.codigo)}</dt><dd>{m.visitas}</dd></div>
                        ))}
                      </dl>
                    </div>
                  </div>

                  <div className="flujograma-empleados">
                    <h3>Por persona</h3>
                    {nodo.porEmpleado.length === 0 ? (
                      <p className="exp-nota">Sin participaciones individuales registradas para este nodo.</p>
                    ) : (
                      <table className="tabla-empleados-nodo">
                        <thead>
                          <tr>
                            <th scope="col">Empleado</th>
                            <th scope="col">Visitas</th>
                            <th scope="col">Tiempo mediano</th>
                          </tr>
                        </thead>
                        <tbody>
                          {nodo.porEmpleado.map((e) => (
                            <tr key={e.coEmpleado}>
                              <td>{e.nombre ?? e.coEmpleado}</td>
                              <td>{e.visitas}</td>
                              <td>{formatearHoras(e.medianaHoras)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}
            </div>

            {i < nodos.length - 1 && (
              <div className="flujograma-conector" aria-hidden="true">
                <svg width="24" height="28" viewBox="0 0 24 28">
                  <line x1="12" y1="0" x2="12" y2="22" stroke="var(--color-border)" strokeWidth="2" />
                  <polygon points="6,20 18,20 12,28" fill="var(--color-border)" />
                </svg>
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
