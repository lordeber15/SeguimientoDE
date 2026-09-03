import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api/cliente';

interface Props {
  /** Ruta relativa de la API; el token lo añade `apiFetch`. */
  url: string;
  titulo: string;
  visualizable: boolean;
  onCerrar: () => void;
}

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
export function VisorDocumento({ url, titulo, visualizable, onCerrar }: Props) {
  const cerrarRef = useRef<HTMLButtonElement>(null);
  const [estado, setEstado] = useState<Estado>({ tipo: 'cargando' });

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
      <div className="modal-caja">
        <header className="modal-cabecera">
          <h2 title={titulo}>{titulo}</h2>
          <div className="modal-acciones">
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

        <div className="modal-cuerpo">
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
      </div>
    </div>
  );
}
