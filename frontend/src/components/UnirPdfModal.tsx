import { useEffect, useRef, useState } from 'react';
import {
  consultarUnion,
  descargarUnion,
  ETIQUETA_FASE,
  iniciarUnion,
  type EstadoJobUnion,
} from '../api/unirPdf';

interface Props {
  nuAnnExp: string;
  nuSecExp: string;
  numeroExpediente: string;
  onCerrar: () => void;
}

type Estado =
  | { tipo: 'configurando' }
  | { tipo: 'trabajando'; job: EstadoJobUnion }
  | { tipo: 'listo'; job: EstadoJobUnion; blobUrl: string }
  | { tipo: 'error'; mensaje: string; errores?: EstadoJobUnion['errores'] };

const INTERVALO_POLL_MS = 1500;

/**
 * Genera el PDF unificado del expediente.
 *
 * El trabajo es asíncrono con polling porque un expediente de 90 documentos tarda cerca de un
 * minuto: mantener la petición abierta la mataría el proxy o el navegador antes de terminar.
 */
export function UnirPdfModal({ nuAnnExp, nuSecExp, numeroExpediente, onCerrar }: Props) {
  const [incluirAnexos, setIncluirAnexos] = useState(true);
  const [estado, setEstado] = useState<Estado>({ tipo: 'configurando' });
  const [verPdf, setVerPdf] = useState(false);
  const cerrarRef = useRef<HTMLButtonElement>(null);

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

  // El PDF unido puede pesar decenas de MB: liberar el blob al cerrar, no dejarlo en memoria.
  useEffect(() => {
    if (estado.tipo !== 'listo') return;
    const url = estado.blobUrl;
    return () => URL.revokeObjectURL(url);
  }, [estado]);

  // Sondeo del job. Se detiene solo al terminar; `vigente` corta si el modal se cierra antes.
  useEffect(() => {
    if (estado.tipo !== 'trabajando') return;

    let vigente = true;
    const jobId = estado.job.jobId;

    const temporizador = setTimeout(async () => {
      try {
        const job = await consultarUnion(jobId);
        if (!vigente) return;
        if (job.estado === 'completado') {
          // La descarga va con token y se sirve desde un blob, así que se hace ya: el enlace
          // debe estar listo cuando el usuario lo pulse.
          const blobUrl = await descargarUnion(jobId);
          if (!vigente) {
            URL.revokeObjectURL(blobUrl);
            return;
          }
          setEstado({ tipo: 'listo', job, blobUrl });
        } else if (job.estado === 'error') {
          setEstado({
            tipo: 'error',
            mensaje: job.mensajeError ?? 'La unión terminó con error',
            errores: job.errores,
          });
        } else setEstado({ tipo: 'trabajando', job });
      } catch (error: unknown) {
        if (!vigente) return;
        setEstado({
          tipo: 'error',
          mensaje: error instanceof Error ? error.message : 'Error desconocido',
        });
      }
    }, INTERVALO_POLL_MS);

    return () => {
      vigente = false;
      clearTimeout(temporizador);
    };
  }, [estado]);

  async function generar() {
    setEstado({
      tipo: 'trabajando',
      job: {
        jobId: '',
        estado: 'procesando',
        fase: 'consultando',
        total: 0,
        procesados: 0,
        errores: [],
        mensajeError: null,
        filename: '',
      },
    });

    try {
      const jobId = await iniciarUnion(nuAnnExp, nuSecExp, incluirAnexos);
      setEstado({ tipo: 'trabajando', job: await consultarUnion(jobId) });
    } catch (error: unknown) {
      setEstado({
        tipo: 'error',
        mensaje: error instanceof Error ? error.message : 'Error desconocido',
      });
    }
  }

  const progreso =
    estado.tipo === 'trabajando' && estado.job.total > 0
      ? Math.round((estado.job.procesados / estado.job.total) * 100)
      : 0;

  return (
    <div
      className="modal-fondo"
      role="dialog"
      aria-modal="true"
      aria-label={`PDF unificado del expediente ${numeroExpediente}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCerrar();
      }}
    >
      <div className={`modal-caja${estado.tipo === 'listo' && verPdf ? '' : ' modal-caja--estrecha'}`}>
        <header className="modal-cabecera">
          <h2>PDF unificado — expediente {numeroExpediente}</h2>
          <div className="modal-acciones">
            {estado.tipo === 'listo' && verPdf && (
              <a className="boton-secundario" href={estado.blobUrl} download={estado.job.filename}>
                Descargar
              </a>
            )}
            <button ref={cerrarRef} className="boton-cerrar" onClick={onCerrar} aria-label="Cerrar">
              ✕
            </button>
          </div>
        </header>

        <div
          className={`modal-cuerpo${estado.tipo === 'listo' && verPdf ? '' : ' modal-cuerpo--union'}`}
        >
          {estado.tipo === 'configurando' && (
            <>
              <p>
                Se unirán en un solo PDF todos los documentos del expediente, en orden cronológico,
                con un índice paginado al principio.
              </p>
              <label className="checkbox-linea">
                <input
                  type="checkbox"
                  checked={incluirAnexos}
                  onChange={(e) => setIncluirAnexos(e.target.checked)}
                />
                <span>
                  Incluir anexos
                  <span className="exp-nota">
                    Los anexos son la mayor parte del peso. Sin ellos el PDF se genera antes y pesa
                    mucho menos.
                  </span>
                </span>
              </label>
              <button className="boton-primario" onClick={generar}>
                Generar PDF
              </button>
            </>
          )}

          {estado.tipo === 'trabajando' && (
            <div role="status" aria-live="polite">
              <p>{ETIQUETA_FASE[estado.job.fase]}</p>
              <div className="barra-progreso" aria-hidden="true">
                <div className="barra-progreso-relleno" style={{ width: `${progreso}%` }} />
              </div>
              <p className="exp-nota">
                {estado.job.total > 0
                  ? `${estado.job.procesados} de ${estado.job.total} · ${progreso}%`
                  : 'Preparando…'}
              </p>
              <p className="exp-nota">
                Puede cerrar esta ventana: el trabajo sigue en el servidor, pero tendrá que
                generarlo de nuevo para descargarlo.
              </p>
            </div>
          )}

          {estado.tipo === 'listo' &&
            (verPdf ? (
              <iframe
                src={estado.blobUrl}
                title={`PDF unificado del expediente ${numeroExpediente}`}
                className="visor-iframe"
              />
            ) : (
              <>
                <p className="union-ok">PDF generado con {estado.job.total} elemento(s).</p>
                <button className="boton-primario" onClick={() => setVerPdf(true)}>
                  Ver PDF
                </button>
                <ListaErrores errores={estado.job.errores} />
              </>
            ))}

          {estado.tipo === 'error' && (
            <div className="state-message is-error" role="alert">
              <p>No se pudo generar el PDF unificado.</p>
              <p>{estado.mensaje}</p>
              <ListaErrores errores={estado.errores ?? []} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Los documentos que no se pudieron incorporar se listan siempre: en el índice del PDF salen como
 * "no incluido", y quien lo descarga necesita saber por qué sin tener que abrirlo.
 */
function ListaErrores({ errores }: { errores: EstadoJobUnion['errores'] }) {
  if (errores.length === 0) return null;

  return (
    <details className="union-errores">
      <summary>{errores.length} elemento(s) no se pudieron incluir</summary>
      <ul>
        {errores.map((error, i) => (
          <li key={`${error.nuEmi}-${error.nuAne ?? 'doc'}-${i}`}>
            <strong>{error.documento}</strong>
            {error.anexo ? ` · anexo ${error.nuAne}: ${error.anexo}` : ''} — {error.motivo}
          </li>
        ))}
      </ul>
    </details>
  );
}
