import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api/cliente';
import type { ClienteReproceso } from '../api/reproceso';
import { PanelReproceso } from './PanelReproceso';

interface Props {
  /** Ruta relativa de la API; el token lo añade `apiFetch`. */
  url: string;
  titulo: string;
  visualizable: boolean;
  onCerrar: () => void;
  /**
   * Si el documento ya está convertido, carga su markdown para mostrarlo al costado del archivo y
   * poder comparar la extracción con el original. Debe ser estable (venir del estado del padre):
   * el efecto que lo llama depende de su identidad.
   */
  cargarMarkdown?: () => Promise<MarkdownVisor>;
  /** Permite volver a extraer el markdown con otro proveedor/modelo desde el panel derecho.
   *  Estable, por la misma razón que `cargarMarkdown`. */
  reproceso?: ClienteReproceso;
  /** El markdown del documento cambió en la base (p.ej. para que la lista refresque su fila). */
  onReprocesado?: () => void;
}

/** Forma común de `MarkdownDocumento` (SGD) y `MarkdownDocumentoStd` (STD). */
export interface MarkdownVisor {
  markdown: string;
  chars: number;
  metodo: string | null;
  truncado: boolean;
}

type EstadoMarkdown =
  | { tipo: 'cargando' }
  | { tipo: 'listo'; datos: MarkdownVisor }
  | { tipo: 'error'; mensaje: string };

type Estado =
  | { tipo: 'cargando' }
  | { tipo: 'listo'; blobUrl: string }
  | { tipo: 'error'; mensaje: string };

/**
 * Visor modal de documentos y anexos.
 *
 * El archivo se descarga con `fetch` y se muestra desde un blob, en vez de apuntar el iframe
 * directamente a la URL de la API. Es la diferencia entre un mensaje claro y que el usuario vea
 * `{"message":"Documento no encontrado..."}` en crudo dentro del visor: solo 7.870 de los 31.404
 * documentos son accesibles desde esta máquina, así que el 404 es un caso frecuente, no un borde.
 */
export function VisorDocumento({ url, titulo, visualizable, onCerrar, cargarMarkdown, reproceso, onReprocesado }: Props) {
  const cerrarRef = useRef<HTMLButtonElement>(null);
  const [estado, setEstado] = useState<Estado>({ tipo: 'cargando' });
  const [estadoMarkdown, setEstadoMarkdown] = useState<EstadoMarkdown>({ tipo: 'cargando' });
  const [mostrarMarkdown, setMostrarMarkdown] = useState(true);
  const [recargaMarkdown, setRecargaMarkdown] = useState(0);
  const dividido = !!cargarMarkdown && mostrarMarkdown;

  useEffect(() => {
    if (!cargarMarkdown) return;
    let vigente = true;
    setEstadoMarkdown({ tipo: 'cargando' });
    cargarMarkdown()
      .then((datos) => {
        if (vigente) setEstadoMarkdown({ tipo: 'listo', datos });
      })
      .catch((error: unknown) => {
        if (vigente) {
          setEstadoMarkdown({ tipo: 'error', mensaje: error instanceof Error ? error.message : 'Error desconocido' });
        }
      });
    return () => {
      vigente = false;
    };
  }, [cargarMarkdown, recargaMarkdown]);

  // Por ref: el padre suele pasar una función nueva en cada render, y eso reiniciaría el sondeo de
  // `PanelReproceso`, que depende de este callback.
  const onReprocesadoRef = useRef(onReprocesado);
  onReprocesadoRef.current = onReprocesado;
  const alReprocesar = useCallback(() => {
    setRecargaMarkdown((n) => n + 1);
    onReprocesadoRef.current?.();
  }, []);

  useEffect(() => {
    let vigente = true;
    let urlCreada: string | null = null;

    apiFetch(url)
      .then(async (res) => {
        if (!res.ok) {
          // El backend responde JSON con el motivo; si no, se usa el código HTTP.
          const detalle = await res
            .json()
            .then((j: { message?: string }) => j.message)
            .catch(() => null);
          throw new Error(detalle ?? `No se pudo obtener el archivo (HTTP ${res.status})`);
        }
        return res.blob();
      })
      .then((blob) => {
        if (!vigente) return;
        urlCreada = URL.createObjectURL(blob);
        setEstado({ tipo: 'listo', blobUrl: urlCreada });
      })
      .catch((error: unknown) => {
        if (!vigente) return;
        setEstado({
          tipo: 'error',
          mensaje: error instanceof Error ? error.message : 'Error desconocido',
        });
      });

    return () => {
      vigente = false;
      if (urlCreada) URL.revokeObjectURL(urlCreada);
    };
  }, [url]);

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

  return (
    <div
      className="modal-fondo"
      role="dialog"
      aria-modal="true"
      aria-label={`Documento: ${titulo}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCerrar();
      }}
    >
      <div className={`modal-caja${cargarMarkdown ? ' modal-caja--dividida' : ''}`}>
        <header className="modal-cabecera">
          <h2 title={titulo}>{titulo}</h2>
          <div className="modal-acciones">
            {cargarMarkdown && (
              <button
                type="button"
                className="boton-secundario"
                onClick={() => setMostrarMarkdown((v) => !v)}
                aria-pressed={mostrarMarkdown}
              >
                {mostrarMarkdown ? 'Ocultar markdown' : 'Ver markdown'}
              </button>
            )}
            {estado.tipo === 'listo' && (
              <a className="boton-secundario" href={estado.blobUrl} download={titulo}>
                Descargar
              </a>
            )}
            <button ref={cerrarRef} className="boton-cerrar" onClick={onCerrar} aria-label="Cerrar">
              ✕
            </button>
          </div>
        </header>

        <div className={`modal-cuerpo${dividido ? ' modal-cuerpo--dividido' : ''}`}>
          <div className="visor-panel">
            {estado.tipo === 'cargando' && (
              <div className="state-message" role="status">
                Cargando documento…
              </div>
            )}

            {estado.tipo === 'error' && (
              <div className="state-message is-error" role="alert">
                <p>No se puede mostrar este documento.</p>
                <p>{estado.mensaje}</p>
                <p className="exp-nota">
                  El documento existe en el SGD, pero su archivo no está en la base de datos ni en el
                  repositorio montado en este servidor.
                </p>
              </div>
            )}

            {estado.tipo === 'listo' &&
              (visualizable ? (
                <iframe src={estado.blobUrl} title={titulo} className="visor-iframe" />
              ) : (
                <div className="state-message">
                  <p>Este tipo de archivo no se puede mostrar en el navegador.</p>
                  <a className="retry-button" href={estado.blobUrl} download={titulo}>
                    Descargar archivo
                  </a>
                </div>
              ))}
          </div>

          {dividido && (
            <section className="visor-panel visor-panel--markdown" aria-label="Markdown extraído">
              {reproceso && <PanelReproceso cliente={reproceso} onTerminado={alReprocesar} />}
              {estadoMarkdown.tipo === 'cargando' && (
                <div className="state-message" role="status">Cargando markdown…</div>
              )}
              {estadoMarkdown.tipo === 'error' && (
                <div className="state-message is-error" role="alert">
                  {estadoMarkdown.mensaje}
                </div>
              )}
              {estadoMarkdown.tipo === 'listo' && (
                <>
                  <p className="exp-nota">
                    {estadoMarkdown.datos.chars} caracteres · método: {estadoMarkdown.datos.metodo ?? '—'}
                    {estadoMarkdown.datos.truncado && ' · mostrando solo el inicio'}
                  </p>
                  {estadoMarkdown.datos.markdown.trim() === '' ? (
                    <p className="exp-nota is-error">El markdown quedó completamente vacío.</p>
                  ) : (
                    <pre className="markdown-crudo">{estadoMarkdown.datos.markdown}</pre>
                  )}
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
