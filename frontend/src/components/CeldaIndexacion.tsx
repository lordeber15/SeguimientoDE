import { useEffect, useState } from 'react';
import type { EstadoIngestaExpediente } from '../api/chat';
import { ApiError } from '../api/cliente';
import { fetchJob, iniciarIngestaConversion, iniciarIngestaEmbeddings } from '../api/rag';
import { IconoChat } from './IconoChat';
import { IndexacionBadge } from './IndexacionBadge';

interface Props {
  clave: string;
  numeroExpediente: string;
  nuAnnExp: string;
  nuSecExp: string;
  /** `undefined` mientras el mapa bulk todavía no llegó — se pinta solo el icono, sin badge. */
  estado: EstadoIngestaExpediente | undefined;
  puedeGestionar: boolean;
  onAbrirChat: () => void;
  /** Clave de la fila con un job en vuelo, o `null`. Un solo job a la vez en toda la tabla. */
  jobEnCurso: string | null;
  onJobCambio: (clave: string | null) => void;
  /** Tras completar un job: `marcarDocumentosCompletos` es global, así que conviene refrescar
   * el mapa entero, no solo esta fila — otras filas pueden pasar de ámbar a verde de rebote. */
  onRefrescar: () => void;
}

type EstadoAccion =
  | { tipo: 'inactivo' }
  | { tipo: 'lanzando' }
  | { tipo: 'trabajando'; jobId: number }
  | { tipo: 'aviso'; mensaje: string }
  | { tipo: 'error'; mensaje: string };

const INTERVALO_POLL_MS = 1500;

export function CeldaIndexacion({
  clave,
  numeroExpediente,
  nuAnnExp,
  nuSecExp,
  estado,
  puedeGestionar,
  onAbrirChat,
  jobEnCurso,
  onJobCambio,
  onRefrescar,
}: Props) {
  const [accion, setAccion] = useState<EstadoAccion>({ tipo: 'inactivo' });

  // Sondeo del job propio de esta fila — mismo patrón que `UnirPdfModal.tsx`.
  useEffect(() => {
    if (accion.tipo !== 'trabajando') return;

    let vigente = true;
    const jobId = accion.jobId;

    const temporizador = setTimeout(async () => {
      try {
        const job = await fetchJob(jobId);
        if (!vigente) return;

        if (job.estado === 'completado') {
          onJobCambio(null);
          onRefrescar();
          setAccion({ tipo: 'inactivo' });
        } else if (job.estado === 'error') {
          onJobCambio(null);
          setAccion({ tipo: 'error', mensaje: job.mensaje ?? 'La indexación terminó con error' });
        }
        // Cualquier otro estado ('pendiente'/'en_curso'/'pausado'): sigue en 'trabajando', el
        // propio cambio de `accion` (misma referencia de objeto si no cambia) no re-dispara este
        // efecto salvo que React lo considere distinto; para seguir sondeando sin depender de eso
        // se relanza explícitamente el mismo estado.
        else setAccion({ tipo: 'trabajando', jobId });
      } catch (err) {
        if (!vigente) return;
        onJobCambio(null);
        setAccion({ tipo: 'error', mensaje: err instanceof Error ? err.message : 'Error desconocido' });
      }
    }, INTERVALO_POLL_MS);

    return () => {
      vigente = false;
      clearTimeout(temporizador);
    };
  }, [accion, onJobCambio, onRefrescar]);

  async function lanzar(tipo: 'conversion' | 'embeddings') {
    setAccion({ tipo: 'lanzando' });
    onJobCambio(clave);

    try {
      const { jobId } =
        tipo === 'conversion'
          ? await iniciarIngestaConversion({ nuAnnExp, nuSecExp })
          : await iniciarIngestaEmbeddings({ nuAnnExp, nuSecExp });
      setAccion({ tipo: 'trabajando', jobId });
    } catch (err) {
      onJobCambio(null);
      if (err instanceof ApiError && err.status === 404) {
        // No es un error: "nada pendiente con ese filtro" significa que ya estaba al día.
        setAccion({ tipo: 'aviso', mensaje: 'Ya estaba al día' });
        onRefrescar();
      } else {
        setAccion({ tipo: 'error', mensaje: err instanceof Error ? err.message : 'Error desconocido' });
      }
    }
  }

  const bloqueadoPorOtraFila = jobEnCurso !== null && jobEnCurso !== clave;
  const ocupado = accion.tipo === 'lanzando' || accion.tipo === 'trabajando';

  return (
    <div className="celda-chat">
      {/* Icono y badge en la misma línea: apilados, los tres elementos estiraban la celda y le
          robaban ancho al resto de la tabla. */}
      <div className="celda-chat-fila">
        <button
          type="button"
          className="boton-icono"
          onClick={onAbrirChat}
          aria-label={`Abrir el chat sobre el expediente ${numeroExpediente}`}
          title="Chat sobre este expediente"
        >
          <IconoChat />
        </button>

        {estado && <IndexacionBadge estado={estado} />}
      </div>

      {puedeGestionar && estado && (
        <AccionIndexacion
          estado={estado}
          accion={accion}
          deshabilitado={ocupado || bloqueadoPorOtraFila}
          onConvertir={() => lanzar('conversion')}
          onEmbeber={() => lanzar('embeddings')}
        />
      )}

      {!puedeGestionar && estado && !estado.completo && estado.total > 0 && (
        <span className="exp-nota" title="Pida a un administrador que complete la indexación de este expediente">
          Pídalo al admin
        </span>
      )}
    </div>
  );
}

function AccionIndexacion({
  estado,
  accion,
  deshabilitado,
  onConvertir,
  onEmbeber,
}: {
  estado: EstadoIngestaExpediente;
  accion: EstadoAccion;
  deshabilitado: boolean;
  onConvertir: () => void;
  onEmbeber: () => void;
}) {
  if (accion.tipo === 'trabajando' || accion.tipo === 'lanzando') {
    return <span className="exp-nota">Indexando…</span>;
  }
  if (accion.tipo === 'aviso') {
    return <span className="exp-nota">{accion.mensaje}</span>;
  }
  if (accion.tipo === 'error') {
    return (
      <span className="exp-nota is-error" title={accion.mensaje}>
        {accion.mensaje}
      </span>
    );
  }

  // Sin nada indexado no hay acción posible desde aquí, y el badge "Sin indexar" ya explica el caso
  // en su `title`. La frase que iba aquí ("Ejecute un barrido desde el panel de RAG") pedía ~260px
  // de una línea y era la que descuadraba el ancho de toda la tabla.
  if (estado.total === 0) {
    return null;
  }
  if (estado.pendientes > 0) {
    return (
      <button
        type="button"
        className="boton-enlace"
        disabled={deshabilitado}
        onClick={onConvertir}
        title={`Convertir ${estado.pendientes} documento${estado.pendientes === 1 ? '' : 's'} pendiente${estado.pendientes === 1 ? '' : 's'}`}
      >
        Convertir ({estado.pendientes})
      </button>
    );
  }
  if (estado.convertidos > 0) {
    return (
      <button
        type="button"
        className="boton-enlace"
        disabled={deshabilitado}
        onClick={onEmbeber}
        title="Generar embeddings para la búsqueda semántica"
      >
        Embeddings
      </button>
    );
  }
  if (estado.error > 0) {
    return (
      <span className="exp-nota" title={`${estado.error} documento(s) con error — revíselos en el panel de RAG`}>
        {estado.error} con error
      </span>
    );
  }
  return null;
}
