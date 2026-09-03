import { Fragment, useState, type ReactNode } from 'react';
import { claveExpediente, type EstadoIngestaExpediente } from '../api/chat';
import {
  formatearDuracion,
  formatearFecha,
  partirFecha,
  type ExpedienteSeguimiento,
} from '../api/seguimiento';
import { CeldaIndexacion } from './CeldaIndexacion';
import { EstadoBadge } from './EstadoBadge';
import { InteraccionesExpediente } from './InteraccionesExpediente';

export type ModoTiempo = 'corridas' | 'habiles';

export interface Indexacion {
  estados: Map<string, EstadoIngestaExpediente>;
  puedeGestionar: boolean;
  jobEnCurso: string | null;
  onJobCambio: (clave: string | null) => void;
  onRefrescar: () => void;
}

interface Props {
  expedientes: ExpedienteSeguimiento[];
  modoTiempo: ModoTiempo;
  coDependencia: string;
  coEmpleado: string;
  onAbrirDocumento: (url: string, titulo: string, visualizable: boolean) => void;
  onUnirPdf: (nuAnnExp: string, nuSecExp: string, numeroExpediente: string) => void;
  /** Ausente si el usuario no tiene permiso `rag.consultar` — la columna de chat no se renderiza. */
  onAbrirChat?: (nuAnnExp: string, nuSecExp: string, numeroExpediente: string) => void;
  indexacion?: Indexacion;
}

export function ExpedienteTable({
  expedientes,
  modoTiempo,
  coDependencia,
  coEmpleado,
  onAbrirDocumento,
  onUnirPdf,
  onAbrirChat,
  indexacion,
}: Props) {
  // Un solo expediente abierto a la vez: cada uno dispara su propia consulta al backend.
  const [expandido, setExpandido] = useState<string | null>(null);
  const mostrarColumnaChat = Boolean(onAbrirChat);
  const columnas = mostrarColumnaChat ? 9 : 8;

  return (
    <div className="table-card">
      <div className="table-scroll">
        {/* Los anchos de columna viven en `.tabla-seguimiento` (index.css): con `table-layout:
            fixed` los declara el `<thead>`, y "Documento" y "Asunto" van sin clase de ancho a
            propósito para repartirse el espacio sobrante. */}
        <table className="tabla-expedientes tabla-seguimiento">
          <thead>
            <tr>
              <th scope="col" className="col-expandir">
                <span className="sr-only">Ver interacciones</span>
              </th>
              <th scope="col" className="col-numero">N° expediente</th>
              <th scope="col">Documento</th>
              <th scope="col">Asunto</th>
              <th scope="col" className="col-estado">Estado</th>
              <th scope="col" className="col-fecha">Fecha de recepción</th>
              <th scope="col" className="col-fecha">Fecha de emisión</th>
              <th scope="col" className="col-tiempo">Tiempo de atención</th>
              {mostrarColumnaChat && <th scope="col" className="col-chat">Chat</th>}
            </tr>
          </thead>
          <tbody>
            {expedientes.map((exp) => {
              const clave = claveExpediente(exp.nuAnnExp, exp.nuSecExp);
              const abierto = expandido === clave;
              const segundos = modoTiempo === 'habiles' ? exp.segundosHabiles : exp.segundosCorridos;
              const duracion = formatearDuracion(segundos);

              return (
                <Fragment key={clave}>
                  <tr className={abierto ? 'fila-expandida' : undefined}>
                    <td className="col-expandir">
                      <button
                        className="boton-expandir"
                        aria-expanded={abierto}
                        aria-label={
                          abierto
                            ? `Ocultar interacciones del expediente ${exp.numeroExpediente ?? clave}`
                            : `Ver interacciones del expediente ${exp.numeroExpediente ?? clave}`
                        }
                        onClick={() => setExpandido(abierto ? null : clave)}
                      >
                        {abierto ? '▾' : '▸'}
                      </button>
                    </td>

                    <td>
                      {/* `title` porque un número como "PMESTPOMSE20260000044" no tiene ningún
                          punto de corte y `overflow-wrap: anywhere` lo parte a media palabra. */}
                      <div className="exp-numero" title={exp.numeroExpediente ?? clave}>
                        {exp.numeroExpediente ?? clave}
                      </div>
                      {exp.participaciones > 1 && (
                        <div
                          className="exp-nota"
                          title="El usuario participó varias veces; la fila muestra la última"
                        >
                          {exp.participaciones} participaciones
                        </div>
                      )}
                      <button
                        className="boton-enlace"
                        onClick={() =>
                          onUnirPdf(exp.nuAnnExp, exp.nuSecExp, exp.numeroExpediente ?? clave)
                        }
                        title="Unir todos los documentos del expediente en un solo PDF"
                      >
                        PDF unificado
                      </button>
                    </td>

                    <td>
                      <div className="doc-nombre">{exp.documento.nombre ?? '—'}</div>
                    </td>

                    <td className="celda-asunto">
                      <span title={exp.asunto ?? undefined}>{exp.asunto ?? '—'}</span>
                    </td>

                    <td>
                      <EstadoBadge codigo={exp.estado.codigo} descripcion={exp.estado.descripcion} />
                    </td>

                    <CeldaFecha
                      valor={exp.fechaRecepcion}
                      nota={
                        exp.fechaApertura ? (
                          <div className="exp-nota">
                            <div>abierto</div>
                            <div>{formatearFecha(exp.fechaApertura)}</div>
                          </div>
                        ) : (
                          <div className="exp-nota">sin abrir</div>
                        )
                      }
                    />

                    <CeldaFecha
                      valor={exp.fechaEmision}
                      nota={
                        exp.documentoRespuesta ? (
                          <div className="exp-nota">{exp.documentoRespuesta}</div>
                        ) : null
                      }
                    />

                    <td className="celda-tiempo">
                      {duracion ?? <span className="badge badge-pendiente">Sin respuesta</span>}
                    </td>

                    {mostrarColumnaChat && onAbrirChat && (
                      <td>
                        <CeldaIndexacion
                          clave={clave}
                          numeroExpediente={exp.numeroExpediente ?? clave}
                          nuAnnExp={exp.nuAnnExp}
                          nuSecExp={exp.nuSecExp}
                          estado={indexacion?.estados.get(clave)}
                          puedeGestionar={indexacion?.puedeGestionar ?? false}
                          onAbrirChat={() => onAbrirChat(exp.nuAnnExp, exp.nuSecExp, exp.numeroExpediente ?? clave)}
                          jobEnCurso={indexacion?.jobEnCurso ?? null}
                          onJobCambio={indexacion?.onJobCambio ?? (() => {})}
                          onRefrescar={indexacion?.onRefrescar ?? (() => {})}
                        />
                      </td>
                    )}
                  </tr>

                  {abierto && (
                    <tr className="fila-detalle">
                      <td colSpan={columnas}>
                        <InteraccionesExpediente
                          nuAnnExp={exp.nuAnnExp}
                          nuSecExp={exp.nuSecExp}
                          coDependencia={coDependencia}
                          coEmpleado={coEmpleado}
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
  );
}

/**
 * Día y hora en líneas separadas: la columna cabe en 124px en vez de los ~166 que pedía la fecha
 * completa en una sola línea (`.celda-fecha` es `white-space: nowrap`, así que ese ancho era un
 * mínimo duro no negociable, y entre las dos columnas de fecha se comían ~370px).
 *
 * Son `<div>` hermanos dentro del `<td>`, no un flex sobre el propio `<td>`: eso último le pisa el
 * `display: table-cell` y lo saca del reparto de columnas — ver el aviso junto a `.celda-nivel`.
 */
function CeldaFecha({ valor, nota }: { valor: string | null; nota?: ReactNode }) {
  const partes = partirFecha(valor);

  return (
    <td className="celda-fecha">
      {partes === null ? (
        <div>—</div>
      ) : (
        <>
          <div>{partes.dia}</div>
          {partes.hora && <div className="fecha-hora">{partes.hora}</div>}
        </>
      )}
      {nota}
    </td>
  );
}
