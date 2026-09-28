import { useEffect, useRef, useState } from 'react';
import type { JobIngesta } from '../api/rag';

/** Los dos tipos de job que hoy se encadenan por lotes desde `RagPanelPage`. */
export type TipoCadena = 'conversion' | 'embedding';

interface Props {
  tipo: TipoCadena;
  /** Nº del lote que acaba de terminar — el siguiente sería `lote + 1`. */
  lote: number;
  /** El job recién completado: sus cifras son las de ESTE lote, no las de la cadena. */
  job: JobIngesta;
  acumulado: { procesados: number; errores: number };
  /** Unidades pendientes que quedan en el corpus según el panel ya refrescado (documentos o
   *  fragmentos, según `tipo`). */
  pendientes: number;
  /** Segundos de cuenta atrás, o `null` para exigir una decisión explícita (ver `RagPanelPage`). */
  segundos: number | null;
  onContinuar: () => void;
  onDetener: () => void;
}

const INTERVALO_CUENTA_MS = 1000;

/** Vocabulario que distingue el diálogo de conversión del de embeddings — la mecánica es idéntica. */
const TEXTOS: Record<TipoCadena, { unidad: string; verbo: string; sinAvance: string }> = {
  conversion: {
    unidad: 'documento(s)',
    verbo: 'convertido(s)',
    sinAvance: 'Este lote no convirtió ningún documento, así que no continúa solo: revise el '
      + 'estado de los conversores antes de seguir.',
  },
  embedding: {
    unidad: 'fragmento(s)',
    verbo: 'embebido(s)',
    sinAvance: 'Este lote no embebió ningún fragmento, así que no continúa solo: revise el '
      + 'proveedor de embeddings antes de seguir.',
  },
};

/**
 * Pregunta entre lotes de una conversión o una ingesta de embeddings encadenada.
 *
 * La cadena existe porque un job de ingesta toma como mucho N unidades y termina: para cubrir un
 * corpus entero hay que lanzar un lote tras otro. Este diálogo es el punto de corte entre uno y el
 * siguiente — con cuenta atrás, para que una tanda larga avance desatendida sin renunciar a poder
 * pararla.
 *
 * La cuenta atrás NO se monta cuando `segundos` es `null`: ese caso (un lote que no avanzó nada, o
 * una cadena recuperada al volver a la pestaña) pide una decisión de verdad, y arrancar solo sería
 * justo lo contrario.
 */
export function ModalContinuarLote({
  tipo,
  lote,
  job,
  acumulado,
  pendientes,
  segundos,
  onContinuar,
  onDetener,
}: Props) {
  const { unidad, verbo, sinAvance } = TEXTOS[tipo];
  const [restante, setRestante] = useState(segundos);
  const continuarRef = useRef<HTMLButtonElement>(null);
  // El intervalo puede llegar a 0 en el mismo tick en que el padre desmonta el modal, y en
  // StrictMode el efecto se monta dos veces: sin este cerrojo se lanzarían dos lotes.
  const disparado = useRef(false);

  useEffect(() => {
    continuarRef.current?.focus();

    // Escape = "No, detener": es la salida segura, la que no lanza otras 500 conversiones.
    function alPulsar(e: KeyboardEvent) {
      if (e.key === 'Escape') onDetener();
    }

    document.addEventListener('keydown', alPulsar);
    const overflowPrevio = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', alPulsar);
      document.body.style.overflow = overflowPrevio;
    };
  }, [onDetener]);

  useEffect(() => {
    if (segundos === null) return;

    const id = setInterval(() => {
      setRestante((previo) => {
        if (previo === null) return null;
        if (previo <= 1) {
          clearInterval(id);
          if (!disparado.current) {
            disparado.current = true;
            onContinuar();
          }
          return 0;
        }
        return previo - 1;
      });
    }, INTERVALO_CUENTA_MS);

    return () => clearInterval(id);
  }, [segundos, onContinuar]);

  function continuarYa() {
    if (disparado.current) return;
    disparado.current = true;
    onContinuar();
  }

  const pctRestante = segundos && restante !== null ? Math.round((restante / segundos) * 100) : 0;

  return (
    <div
      className="modal-fondo"
      role="alertdialog"
      aria-modal="true"
      aria-label={`Lote ${lote} terminado`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onDetener();
      }}
    >
      <div className="modal-caja modal-caja--estrecha">
        <header className="modal-cabecera">
          <h2>Lote {lote} terminado</h2>
        </header>

        <div className="modal-cuerpo modal-cuerpo--lote">
          <p>
            Se procesaron <strong>{job.procesados}</strong> de {job.total} {unidad}
            {job.errores > 0 && <> ({job.errores} con error)</>}.
          </p>
          {lote > 1 && (
            <p className="exp-nota">
              En total, esta tanda lleva {acumulado.procesados} {unidad} {verbo} en {lote} lote(s)
              {acumulado.errores > 0 && ` y ${acumulado.errores} con error`}.
            </p>
          )}
          <p>
            Quedan <strong>{pendientes}</strong> {unidad} pendiente(s). ¿Continuar con el
            siguiente lote?
          </p>

          {segundos !== null ? (
            <>
              <p className="cuenta-atras">
                Continúa automáticamente en <strong>{restante}</strong> s si no responde.
              </p>
              <div className="barra-progreso">
                <div className="barra-progreso-relleno" style={{ width: `${pctRestante}%` }} />
              </div>
            </>
          ) : (
            <p className="exp-nota is-error">
              {job.procesados === 0
                ? sinAvance
                : 'El lote terminó mientras esta pantalla no estaba abierta, así que no continúa solo.'}
            </p>
          )}
        </div>

        <div className="modal-acciones modal-acciones--pie">
          <button className="boton-primario" onClick={continuarYa} ref={continuarRef}>
            Continuar ahora
          </button>
          <button className="boton-secundario" onClick={onDetener}>
            No, detener
          </button>
        </div>
      </div>
    </div>
  );
}
