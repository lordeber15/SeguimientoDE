import { useEffect, useState } from 'react';
import {
  esVisualizable,
  fetchAnexos,
  fetchInteracciones,
  nombreLegible,
  rutaAnexo,
  rutaDocumento,
  type AnexoListado,
  type InteraccionExpediente,
} from '../api/documentos';
import { formatearDuracion, formatearFecha } from '../api/seguimiento';
import { EstadoBadge } from './EstadoBadge';

interface Props {
  nuAnnExp: string;
  nuSecExp: string;
  coDependencia: string;
  coEmpleado: string;
  onAbrirDocumento: (url: string, titulo: string, visualizable: boolean) => void;
}

type Estado =
  | { tipo: 'cargando' }
  | { tipo: 'error'; mensaje: string }
  | { tipo: 'listo'; items: InteraccionExpediente[] };

/** Anexos de un documento: se piden solo al desplegarlos, no al abrir el expediente. */
function Anexos({
  nuAnn,
  nuEmi,
  cantidad,
  onAbrirDocumento,
}: {
  nuAnn: string;
  nuEmi: string;
  cantidad: number;
  onAbrirDocumento: Props['onAbrirDocumento'];
}) {
  const [abierto, setAbierto] = useState(false);
  const [anexos, setAnexos] = useState<AnexoListado[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!abierto || anexos) return;

    let vigente = true;
    fetchAnexos(nuAnn, nuEmi)
      .then((datos) => vigente && setAnexos(datos))
      .catch((e: unknown) => vigente && setError(e instanceof Error ? e.message : 'Error'));

    return () => {
      vigente = false;
    };
  }, [abierto, anexos, nuAnn, nuEmi]);

  return (
    <div className="anexos">
      <button className="boton-enlace" onClick={() => setAbierto((v) => !v)} aria-expanded={abierto}>
        {abierto ? '▾' : '▸'} {cantidad} {cantidad === 1 ? 'anexo' : 'anexos'}
      </button>

      {abierto && error && <div className="exp-nota is-error">{error}</div>}
      {abierto && !anexos && !error && <div className="exp-nota">Cargando anexos…</div>}

      {abierto && anexos && (
        <ul className="anexos-lista">
          {anexos.map((anexo) => {
            const nombre = anexo.nombreArchivo ?? anexo.titulo;
            return (
              <li key={anexo.nuAne}>
                <button
                  className="boton-enlace"
                  onClick={() =>
                    onAbrirDocumento(
                      rutaAnexo(nuAnn, nuEmi, anexo.nuAne),
                      nombre ?? `Anexo ${anexo.nuAne}`,
                      esVisualizable(nombre),
                    )
                  }
                >
                  <span className="anexo-num">{anexo.nuAne}</span> {nombre ?? 'Sin nombre'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function InteraccionesExpediente({
  nuAnnExp,
  nuSecExp,
  coDependencia,
  coEmpleado,
  onAbrirDocumento,
}: Props) {
  const [estado, setEstado] = useState<Estado>({ tipo: 'cargando' });

  useEffect(() => {
    let vigente = true;
    setEstado({ tipo: 'cargando' });

    fetchInteracciones(nuAnnExp, nuSecExp, coDependencia, coEmpleado)
      .then((datos) => vigente && setEstado({ tipo: 'listo', items: datos.items }))
      .catch((e: unknown) => {
        if (vigente) {
          setEstado({ tipo: 'error', mensaje: e instanceof Error ? e.message : 'Error desconocido' });
        }
      });

    return () => {
      vigente = false;
    };
  }, [nuAnnExp, nuSecExp, coDependencia, coEmpleado]);

  if (estado.tipo === 'cargando') {
    return <div className="interacciones-estado">Cargando interacciones…</div>;
  }

  if (estado.tipo === 'error') {
    return (
      <div className="interacciones-estado is-error" role="alert">
        {estado.mensaje}
      </div>
    );
  }

  if (estado.items.length === 0) {
    return <div className="interacciones-estado">Sin interacciones registradas.</div>;
  }

  return (
    <div className="interacciones">
      <h3 className="interacciones-titulo">
        {estado.items.length} {estado.items.length === 1 ? 'interacción' : 'interacciones'} en este
        expediente
      </h3>

      <ol className="interacciones-lista">
        {estado.items.map((item) => {
          const titulo = item.documento.nombre ?? `${item.nuAnn}-${item.nuEmi}`;

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
                  Recibido <strong>{formatearFecha(item.fechaRecepcion)}</strong>
                </span>
                <span>
                  Respondido <strong>{formatearFecha(item.fechaEmision)}</strong>
                </span>
                <span>
                  Atención{' '}
                  <strong>{formatearDuracion(item.segundosCorridos) ?? 'sin respuesta'}</strong>
                </span>
              </div>

              <div className="interaccion-archivos">
                {item.tieneArchivo ? (
                  <button
                    className="boton-secundario"
                    onClick={() =>
                      onAbrirDocumento(
                        rutaDocumento(item.nuAnn, item.nuEmi),
                        nombreLegible(titulo),
                        true,
                      )
                    }
                  >
                    Ver documento
                  </button>
                ) : (
                  <span className="exp-nota">Sin archivo digital</span>
                )}

                {item.numAnexos > 0 && (
                  <Anexos
                    nuAnn={item.nuAnn}
                    nuEmi={item.nuEmi}
                    cantidad={item.numAnexos}
                    onAbrirDocumento={onAbrirDocumento}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
