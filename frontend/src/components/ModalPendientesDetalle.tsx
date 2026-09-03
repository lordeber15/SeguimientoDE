import { Fragment, useEffect, useRef, useState } from 'react';
import {
  fetchPendientesDetalle,
  type BucketPendientes,
  type PendienteDetalle,
  type TipoDocumento,
} from '../api/dashboard';
import {
  fetchInteraccionesCompletas,
  nombreLegible,
  rutaDocumento,
  type InteraccionExpedienteCompleta,
} from '../api/documentos';
import { formatearDuracion, formatearFecha } from '../api/seguimiento';
import { EstadoBadge } from './EstadoBadge';

interface Props {
  coDependencia: string;
  nombreDependencia: string | null;
  bucket: BucketPendientes;
  tipoDocumento?: string;
  /** Catálogo ya cargado a nivel de página (mismo que alimenta el filtro "Tipo de documento") —
   *  el detalle solo guarda `coTipDoc`, no la descripción, así que se resuelve aquí. */
  tipos: TipoDocumento[];
  onCerrar: () => void;
  onAbrirDocumento: (url: string, titulo: string, visualizable: boolean) => void;
}

type Estado =
  | { tipo: 'cargando' }
  | { tipo: 'error'; mensaje: string }
  | { tipo: 'listo'; total: number; items: PendienteDetalle[] };

const ETIQUETA_BUCKET: Record<BucketPendientes, string> = {
  todos: 'Todos los pendientes',
  '0a7': 'Pendientes de 0 a 7 días',
  '8a30': 'Pendientes de 8 a 30 días',
  '31mas': 'Pendientes de 31+ días',
};

/** Mismo catálogo verificado que `EstadoBadge` (`IDOSGD.TDTR_ESTADOS`, `DE_TAB='TDTV_DESTINOS'`),
 *  pero acá hace falta la DESCRIPCIÓN, no solo el color: el espejo local no puede hacer JOIN
 *  contra el SGD (son bases distintas), así que `pendientesDetalleOficina` solo trae el código. */
const DESCRIPCION_ES_DOC_REC: Record<string, string> = {
  '0': 'NO LEIDO',
  '1': 'RECIBIDO',
  '2': 'ATENDIDO',
  '3': 'ARCHIVADO',
  '4': 'DERIVADO',
  '5': 'ENVIADO',
  '9': 'ANULADO',
};

const COLUMNAS_DETALLE = 8;

/**
 * Drill-down de un número de la pestaña "Pendientes": los documentos concretos detrás de esa
 * oficina/bucket de antigüedad. Cáscara de modal calcada de `VisorDocumento` (única convención de
 * diálogo del proyecto — no hay un `<Modal>` genérico).
 */
export function ModalPendientesDetalle({
  coDependencia,
  nombreDependencia,
  bucket,
  tipoDocumento,
  tipos,
  onCerrar,
  onAbrirDocumento,
}: Props) {
  const cerrarRef = useRef<HTMLButtonElement>(null);
  const [estado, setEstado] = useState<Estado>({ tipo: 'cargando' });
  const [expandido, setExpandido] = useState<string | null>(null);

  useEffect(() => {
    let vigente = true;
    setEstado({ tipo: 'cargando' });

    fetchPendientesDetalle(coDependencia, bucket, tipoDocumento)
      .then((datos) => vigente && setEstado({ tipo: 'listo', total: datos.total, items: datos.items }))
      .catch((e: unknown) => {
        if (vigente) {
          setEstado({ tipo: 'error', mensaje: e instanceof Error ? e.message : 'Error desconocido' });
        }
      });

    return () => {
      vigente = false;
    };
  }, [coDependencia, bucket, tipoDocumento]);

  useEffect(() => {
    cerrarRef.current?.focus();

    function alPulsar(e: KeyboardEvent) {
      if (e.key === 'Escape') onCerrar();
    }

    document.addEventListener('keydown', alPulsar);
    const overflowPrevio = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', alPulsar);
      document.body.style.overflow = overflowPrevio;
    };
  }, [onCerrar]);

  function descripcionTipo(coTipDoc: string | null): string | null {
    if (!coTipDoc) return null;
    return tipos.find((t) => t.codigo === coTipDoc)?.descripcion ?? coTipDoc;
  }

  const titulo = nombreDependencia ?? coDependencia;

  return (
    <div
      className="modal-fondo"
      role="dialog"
      aria-modal="true"
      aria-label={`${ETIQUETA_BUCKET[bucket]} — ${titulo}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCerrar();
      }}
    >
      <div className="modal-caja">
        <header className="modal-cabecera">
          <h2 title={titulo}>
            {titulo} — {ETIQUETA_BUCKET[bucket]}
            {estado.tipo === 'listo' && ` (${estado.total})`}
          </h2>
          <div className="modal-acciones">
            <button ref={cerrarRef} className="boton-cerrar" onClick={onCerrar} aria-label="Cerrar">
              ✕
            </button>
          </div>
        </header>

        <div className="modal-cuerpo modal-cuerpo--pendientes">
          {estado.tipo === 'cargando' && (
            <div className="state-message" role="status">
              Cargando pendientes…
            </div>
          )}

          {estado.tipo === 'error' && (
            <div className="state-message is-error" role="alert">
              <p>No se pudo obtener el detalle de pendientes.</p>
              <p>{estado.mensaje}</p>
            </div>
          )}

          {estado.tipo === 'listo' && estado.items.length === 0 && (
            <div className="state-message">Ningún documento pendiente en esta categoría.</div>
          )}

          {estado.tipo === 'listo' && estado.items.length > 0 && (
            <>
              {estado.total > estado.items.length && (
                <p className="exp-nota">
                  Mostrando los {estado.items.length} más antiguos de {estado.total} en total.
                </p>
              )}

              <div className="table-card">
                <div className="table-scroll">
                  <table className="tabla-expedientes tabla-pendientes-detalle">
                    <thead>
                      <tr>
                        <th scope="col" className="col-expandir">
                          <span className="sr-only">Ver recorrido</span>
                        </th>
                        <th scope="col" className="col-numero">Expediente</th>
                        <th scope="col">Documento</th>
                        <th scope="col">Asunto</th>
                        <th scope="col" className="col-responsable">Responsable</th>
                        <th scope="col" className="col-fecha">Recibido</th>
                        <th scope="col" className="col-dias">Días</th>
                        <th scope="col" className="col-estado">Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {estado.items.map((item) => {
                        const clave = `${item.nuAnnExp}-${item.nuSecExp}-${item.nuAnn}-${item.nuEmi}-${item.nuDes}`;
                        const abierto = expandido === clave;
                        const nombreDoc = [descripcionTipo(item.coTipDoc), item.numeroDocumento]
                          .filter(Boolean)
                          .join(' ');

                        return (
                          <Fragment key={clave}>
                            <tr className={abierto ? 'fila-expandida' : undefined}>
                              <td className="col-expandir">
                                <button
                                  className="boton-expandir"
                                  aria-expanded={abierto}
                                  aria-label={
                                    abierto
                                      ? `Ocultar recorrido del expediente ${item.numeroExpediente ?? item.nuAnnExp}`
                                      : `Ver recorrido del expediente ${item.numeroExpediente ?? item.nuAnnExp}`
                                  }
                                  onClick={() => setExpandido(abierto ? null : clave)}
                                >
                                  {abierto ? '▾' : '▸'}
                                </button>
                              </td>

                              <td>
                                <div className="exp-numero" title={item.numeroExpediente ?? item.nuAnnExp}>
                                  {item.numeroExpediente ?? `${item.nuAnnExp}-${item.nuSecExp}`}
                                </div>
                              </td>

                              <td>
                                <div className="doc-nombre">{nombreDoc || '—'}</div>
                              </td>

                              <td className="celda-asunto">
                                <span title={item.asunto ?? undefined}>{item.asunto ?? '—'}</span>
                              </td>

                              <td>{item.nombreEmpleado ?? item.coEmpleado}</td>

                              <td className="celda-fecha">{formatearFecha(item.fechaRecepcion)}</td>

                              <td className="celda-tiempo">{item.dias} d</td>

                              <td>
                                <EstadoBadge
                                  codigo={item.esDocRec}
                                  descripcion={item.esDocRec ? DESCRIPCION_ES_DOC_REC[item.esDocRec] ?? item.esDocRec : null}
                                />
                              </td>
                            </tr>

                            {abierto && (
                              <tr className="fila-detalle">
                                <td colSpan={COLUMNAS_DETALLE}>
                                  <RecorridoExpediente
                                    nuAnnExp={item.nuAnnExp}
                                    nuSecExp={item.nuSecExp}
                                    onAbrirDocumento={onAbrirDocumento}
                                  />
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}

type EstadoRecorrido =
  | { tipo: 'cargando' }
  | { tipo: 'error'; mensaje: string }
  | { tipo: 'listo'; items: InteraccionExpedienteCompleta[] };

/**
 * Todos los movimientos del expediente (no solo los de esta persona) — responde la pregunta "¿en
 * qué oficina/persona está este documento AHORA?". Se pide solo al desplegar la fila, igual que
 * los anexos en `InteraccionesExpediente`.
 */
function RecorridoExpediente({
  nuAnnExp,
  nuSecExp,
  onAbrirDocumento,
}: {
  nuAnnExp: string;
  nuSecExp: string;
  onAbrirDocumento: Props['onAbrirDocumento'];
}) {
  const [estado, setEstado] = useState<EstadoRecorrido>({ tipo: 'cargando' });

  useEffect(() => {
    let vigente = true;
    setEstado({ tipo: 'cargando' });

    fetchInteraccionesCompletas(nuAnnExp, nuSecExp)
      .then((datos) => vigente && setEstado({ tipo: 'listo', items: datos.items }))
      .catch((e: unknown) => {
        if (vigente) {
          setEstado({ tipo: 'error', mensaje: e instanceof Error ? e.message : 'Error desconocido' });
        }
      });

    return () => {
      vigente = false;
    };
  }, [nuAnnExp, nuSecExp]);

  if (estado.tipo === 'cargando') {
    return <div className="interacciones-estado">Cargando recorrido…</div>;
  }

  if (estado.tipo === 'error') {
    return (
      <div className="interacciones-estado is-error" role="alert">
        {estado.mensaje}
      </div>
    );
  }

  if (estado.items.length === 0) {
    return <div className="interacciones-estado">Sin movimientos registrados para este expediente.</div>;
  }

  // `fetchInteraccionesCompletas` viene ordenado `fe_envio DESC` (ver documentoService.ts): el
  // primer ítem es el movimiento más reciente, es decir, dónde está el expediente en este momento.
  const actual = estado.items[0];
  const ahoraDependencia = actual.recibidoPor.nombreDependencia ?? actual.recibidoPor.coDependencia ?? '—';
  const ahoraPersona = actual.recibidoPor.nombre ?? `empleado ${actual.recibidoPor.coEmpleado ?? '—'}`;

  return (
    <div className="interacciones">
      <p className="interacciones-titulo">
        Ahora en: <strong>{ahoraDependencia}</strong> — {ahoraPersona}
      </p>

      <ol className="interacciones-lista">
        {estado.items.map((item) => {
          const titulo = item.documento.nombre ?? `${item.nuAnn}-${item.nuEmi}`;
          const receptor = item.recibidoPor.nombre ?? `empleado ${item.recibidoPor.coEmpleado ?? '—'}`;
          const dependencia = item.recibidoPor.nombreDependencia ?? item.recibidoPor.coDependencia;

          return (
            <li key={`${item.nuAnn}-${item.nuEmi}-${item.nuDes}`} className="interaccion">
              <div className="interaccion-cabecera">
                <span className="interaccion-orden">#{item.orden}</span>
                <span className="doc-nombre">{titulo}</span>
                <EstadoBadge codigo={item.estado.codigo} descripcion={item.estado.descripcion} />
              </div>

              {item.asunto && <p className="interaccion-asunto">{item.asunto}</p>}

              <div className="interaccion-datos">
                <span>
                  Recibido por <strong>{receptor}</strong>
                  {dependencia ? ` · ${dependencia}` : ''}
                </span>
                <span>
                  Recibido <strong>{formatearFecha(item.fechaRecepcion)}</strong>
                </span>
                <span>
                  Respondido <strong>{formatearFecha(item.fechaEmision)}</strong>
                </span>
                <span>
                  Atención <strong>{formatearDuracion(item.segundosCorridos) ?? 'sin respuesta'}</strong>
                </span>
              </div>

              <div className="interaccion-archivos">
                {item.tieneArchivo ? (
                  <button
                    className="boton-secundario"
                    onClick={() =>
                      onAbrirDocumento(rutaDocumento(item.nuAnn, item.nuEmi), nombreLegible(titulo), true)
                    }
                  >
                    Ver documento
                  </button>
                ) : (
                  <span className="exp-nota">Sin archivo digital</span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
