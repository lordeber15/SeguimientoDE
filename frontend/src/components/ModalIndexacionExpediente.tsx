import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchEstadoIngestaExpediente, type EstadoIngestaExpediente } from '../api/chat';
import { ApiError } from '../api/cliente';
import {
  fetchJob,
  fetchPanel,
  iniciarIngestaConversion,
  iniciarIngestaEmbeddings,
  iniciarIngestaReparacion,
  type JobIngesta,
  type PanelRag,
} from '../api/rag';
import { ListaDocumentosRag } from './ListaDocumentosRag';
import { PanelJobIngesta } from './PanelJobIngesta';

interface Props {
  nuAnnExp: string;
  nuSecExp: string;
  numeroExpediente: string;
  onCerrar: () => void;
  /** Se llama cuando el estado de ingesta pudo cambiar, para que el chat refresque su aviso. */
  onCambio: () => void;
}

type EstadoResumen =
  | { tipo: 'cargando' }
  | { tipo: 'error'; mensaje: string }
  | { tipo: 'listo'; estado: EstadoIngestaExpediente };

const INTERVALO_POLL_MS = 1500;

/**
 * Detalle y corrección de la ingesta de UN expediente, abierto desde el aviso amarillo del chat
 * (PLAN-RAG.md §9). El panel de RAG lista todo el corpus; este modal reutiliza exactamente el
 * mismo componente de tabla (`ListaDocumentosRag`) pero acotado a `nuAnnExp`/`nuSecExp`, con las
 * mismas acciones globales que ya existen en `RagPanelPage` — la diferencia es el filtro, no el
 * mecanismo.
 *
 * El polling del job es ÚNICO para todo el modal (global, selección o lanzado desde una fila),
 * igual patrón que `CeldaIndexacion`/`UnirPdfModal`: así una fila que lanza un embeddings suelto no
 * abre un segundo temporizador independiente, sino que reporta su `jobId` hacia aquí.
 */
export function ModalIndexacionExpediente({
  nuAnnExp, nuSecExp, numeroExpediente, onCerrar, onCambio,
}: Props) {
  const [resumen, setResumen] = useState<EstadoResumen>({ tipo: 'cargando' });
  const [panelInfo, setPanelInfo] = useState<PanelRag | null>(null);
  const [jobActivo, setJobActivo] = useState<JobIngesta | null>(null);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);
  const [seleccion, setSeleccion] = useState<Set<number>>(new Set());
  const [recargaSenal, setRecargaSenal] = useState(0);
  const cerrarRef = useRef<HTMLButtonElement>(null);

  const cargarResumen = useCallback(() => {
    fetchEstadoIngestaExpediente(nuAnnExp, nuSecExp)
      .then((estado) => setResumen({ tipo: 'listo', estado }))
      .catch((err: unknown) =>
        setResumen({
          tipo: 'error',
          mensaje: err instanceof Error ? err.message : 'No se pudo cargar el estado de ingesta',
        }),
      );
  }, [nuAnnExp, nuSecExp]);

  useEffect(() => cargarResumen(), [cargarResumen]);

  // Disponibilidad de proveedores (embeddings, visión, circuito del conversor activo) — mismo dato que
  // alimenta el panel de RAG. Falla en silencio a propósito: sin él, los botones simplemente
  // quedan sin `title` explicativo y el 409 del backend explica el motivo igual al intentarlo.
  useEffect(() => {
    fetchPanel().then(setPanelInfo).catch(() => {});
  }, []);

  // Escape + foco + scroll lock — mismo patrón que VisorDocumento/UnirPdfModal.
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

  // Sondeo del job en curso — se detiene solo al terminar; `vigente` corta si el modal se cierra
  // antes. Al completarse, refresca tanto el resumen de este modal como la lista de documentos.
  // Sigue mientras haya un documento en vuelo aunque el job ya no esté "en_curso": ese ítem nunca
  // se aborta a mitad, así que conviene mostrar cómo termina en vez de congelar la última foto.
  useEffect(() => {
    if (!jobActivo || (jobActivo.estado !== 'en_curso' && !jobActivo.procesoActual)) return;

    let vigente = true;
    const temporizador = setTimeout(async () => {
      try {
        const job = await fetchJob(jobActivo.id);
        if (!vigente) return;
        // Comparado contra el ESTADO ANTERIOR (capturado en el cierre), no contra "sigue sin estar
        // en_curso": con el sondeo ahora extendido para ver terminar el documento en vuelo, ese
        // segundo caso se repetiría en cada tick mientras se espera y refrescaría la lista sin
        // necesidad. Cada evento se refresca UNA sola vez, en el tick en que ocurre de verdad.
        const yaNoEstaEnCurso = job.estado !== 'en_curso' && jobActivo.estado === 'en_curso';
        const documentoEnVueloTermino = !job.procesoActual && !!jobActivo.procesoActual;
        setJobActivo(job);
        if (yaNoEstaEnCurso || documentoEnVueloTermino) {
          cargarResumen();
          setRecargaSenal((n) => n + 1);
          onCambio();
        }
      } catch {
        // Un fallo de red al sondear no debe tumbar el modal; se reintenta en el próximo tick.
      }
    }, INTERVALO_POLL_MS);

    return () => {
      vigente = false;
      clearTimeout(temporizador);
    };
  }, [jobActivo, cargarResumen, onCambio]);

  const jobEnCurso = jobActivo?.estado === 'en_curso';
  const filtroExpediente = { nuAnnExp, nuSecExp };

  async function lanzar(iniciar: () => Promise<{ jobId: number }>, mensajeError: string) {
    setAviso(null);
    try {
      const { jobId } = await iniciar();
      setJobActivo(await fetchJob(jobId));
    } catch (err: unknown) {
      // Un 404 aquí significa "nada pendiente con ese filtro" — no es un error, es que ya está al
      // día. Mismo criterio que `CeldaIndexacion.tsx`.
      if (err instanceof ApiError && err.status === 404) {
        setAviso({ tipo: 'ok', texto: 'Ya estaba al día — no había nada pendiente con ese filtro.' });
        cargarResumen();
      } else {
        setAviso({ tipo: 'error', texto: err instanceof Error ? err.message : mensajeError });
      }
    }
  }

  async function procesarSeleccion(tipo: 'conversion' | 'embeddings') {
    const documentoIds = [...seleccion];
    if (documentoIds.length === 0) return;
    await lanzar(
      () => (tipo === 'conversion'
        ? iniciarIngestaConversion({ ...filtroExpediente, documentoIds })
        : iniciarIngestaEmbeddings({ ...filtroExpediente, documentoIds })),
      tipo === 'conversion' ? 'No se pudo iniciar la conversión' : 'No se pudo iniciar la ingesta de embeddings',
    );
    setSeleccion(new Set());
  }

  return (
    <div
      className="modal-fondo"
      role="dialog"
      aria-modal="true"
      aria-label={`Indexación del expediente ${numeroExpediente}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCerrar();
      }}
    >
      <div className="modal-caja">
        <header className="modal-cabecera">
          <h2>Indexación — expediente {numeroExpediente}</h2>
          <button ref={cerrarRef} className="boton-cerrar" onClick={onCerrar} aria-label="Cerrar">
            ✕
          </button>
        </header>

        <div className="modal-cuerpo modal-cuerpo--indexacion">
          {resumen.tipo === 'cargando' && (
            <div className="state-message">Cargando el estado de ingesta…</div>
          )}
          {resumen.tipo === 'error' && (
            <div className="state-message is-error" role="alert">
              {resumen.mensaje}
            </div>
          )}
          {resumen.tipo === 'listo' && <ResumenIndexacion estado={resumen.estado} />}

          {aviso && (
            <div className={`state-message ${aviso.tipo === 'error' ? 'is-error' : ''}`} role="status">
              {aviso.texto}
            </div>
          )}

          <div className="rag-acciones modal-indexacion-acciones">
            <button
              type="button"
              className="boton-primario"
              disabled={jobEnCurso || resumen.tipo !== 'listo' || resumen.estado.pendientes === 0}
              onClick={() => lanzar(
                () => iniciarIngestaConversion(filtroExpediente),
                'No se pudo iniciar la conversión',
              )}
            >
              Convertir pendientes
            </button>
            <button
              type="button"
              className="boton-primario"
              disabled={
                jobEnCurso
                || resumen.tipo !== 'listo'
                || resumen.estado.convertidos === 0
                || panelInfo?.proveedores.embedding.disponible === false
              }
              title={panelInfo?.proveedores.embedding.disponible === false
                ? panelInfo.proveedores.embedding.motivo ?? undefined
                : undefined}
              onClick={() => lanzar(
                () => iniciarIngestaEmbeddings(filtroExpediente),
                'No se pudo iniciar la ingesta de embeddings',
              )}
            >
              Generar embeddings
            </button>
            <button
              type="button"
              className="boton-secundario"
              disabled={
                jobEnCurso
                || resumen.tipo !== 'listo'
                || resumen.estado.sinTexto + resumen.estado.noSoportado === 0
              }
              onClick={() => lanzar(
                () => iniciarIngestaReparacion(filtroExpediente),
                'No se pudo iniciar la reparación',
              )}
            >
              Reparar recuperables
            </button>
          </div>

          {jobActivo && <PanelJobIngesta job={jobActivo} />}

          {seleccion.size > 0 && (
            <div className="toolbar modal-indexacion-seleccion">
              <span className="exp-nota">
                {seleccion.size} documento{seleccion.size === 1 ? '' : 's'} seleccionado{seleccion.size === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                className="boton-secundario"
                disabled={jobEnCurso}
                onClick={() => procesarSeleccion('conversion')}
              >
                Convertir seleccionados
              </button>
              <button
                type="button"
                className="boton-secundario"
                disabled={jobEnCurso}
                onClick={() => procesarSeleccion('embeddings')}
              >
                Embeber seleccionados
              </button>
            </div>
          )}

          <ListaDocumentosRag
            nuAnnExp={nuAnnExp}
            nuSecExp={nuSecExp}
            estadoInicial=""
            jobEnCurso={jobEnCurso}
            circuitoAbierto={
              panelInfo?.proveedores.conversion.proveedorActivo === 'mineru'
                ? panelInfo?.proveedores.mineru.circuitoAbierto
                : panelInfo?.proveedores.markitdown.circuitoAbierto
            }
            visionDisponible={panelInfo?.proveedores.vision.disponible}
            visionMotivo={panelInfo?.proveedores.vision.motivo}
            embeddingDisponible={panelInfo?.proveedores.embedding.disponible}
            embeddingMotivo={panelInfo?.proveedores.embedding.motivo}
            seleccionables
            seleccion={seleccion}
            onSeleccionCambio={setSeleccion}
            recargaSenal={recargaSenal}
            onCambio={() => {
              cargarResumen();
              onCambio();
            }}
            onJobLanzado={(jobId) => {
              fetchJob(jobId).then(setJobActivo).catch(() => {});
            }}
          />
        </div>
      </div>
    </div>
  );
}

const CHIPS_RESUMEN: { clave: keyof EstadoIngestaExpediente; etiqueta: string; clase: string }[] = [
  { clave: 'listos', etiqueta: 'Completos', clase: 'badge-atendido' },
  { clave: 'pendientes', etiqueta: 'Pendientes', clase: 'badge-pendiente' },
  { clave: 'convertidos', etiqueta: 'Convertidos', clase: 'badge-progreso' },
  { clave: 'sinTexto', etiqueta: 'Sin texto', clase: 'badge-anulado' },
  { clave: 'error', etiqueta: 'Con error', clase: 'badge-anulado' },
  { clave: 'noSoportado', etiqueta: 'Sin archivo', clase: 'badge-neutro' },
];

function ResumenIndexacion({ estado }: { estado: EstadoIngestaExpediente }) {
  return (
    <div className="modal-indexacion-resumen">
      {CHIPS_RESUMEN.map(({ clave, etiqueta, clase }) => (
        <span key={clave} className={`badge ${clase}`}>
          {estado[clave]} {etiqueta}
        </span>
      ))}
    </div>
  );
}
