import { useEffect, useState } from 'react';
import { fetchTextoChunk, type CitaChat } from '../api/chat';
import { TextoChunk } from './TextoChunk';

/**
 * Una cita del chat, como badge plegado.
 *
 * Antes cada cita volcaba el fragmento entero debajo del enlace: tres o cuatro citas por respuesta
 * llenaban varias pantallas de markdown crudo y la conversación se volvía ilegible. Ahora la cita
 * ocupa una línea y el texto se pide al backend (`fetchTextoChunk`) la PRIMERA vez que se despliega
 * — cerrada no cuesta ni red ni DOM.
 *
 * Una vez cargado, el cuerpo se queda montado aunque se cierre: es lo que permite que el plegado
 * anime en los dos sentidos, y el texto ya está en memoria, así que desmontarlo no ahorraría nada.
 */

/** `id` del elemento de una cita — los marcadores `[Dn]` del texto saltan hasta aquí. */
export function idCita(mensajeId: string, numero: number): string {
  return `cita-${mensajeId}-${numero}`;
}

interface Props {
  cita: CitaChat;
  mensajeId: string;
  abierta: boolean;
  onToggle: () => void;
  onAbrirDocumento: (cita: CitaChat) => void;
}

export function CitaBadge({ cita, mensajeId, abierta, onToggle, onAbrirDocumento }: Props) {
  const [texto, setTexto] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Se pide una sola vez: al cerrar y volver a abrir, `texto` ya no es null y el efecto no hace
  // nada. Reintenta solo si la primera vez falló y el usuario vuelve a desplegar.
  useEffect(() => {
    if (!abierta || texto !== null || cargando) return;

    let vigente = true;
    setCargando(true);
    setError(null);

    fetchTextoChunk(cita.chunkId)
      .then((r) => vigente && setTexto(r.texto))
      .catch((e) => {
        if (vigente) setError(e instanceof Error ? e.message : 'No se pudo cargar el fragmento');
      })
      .finally(() => {
        if (vigente) setCargando(false);
      });

    return () => {
      vigente = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abierta, cita.chunkId]);

  const idPanel = `${idCita(mensajeId, cita.numero)}-panel`;
  const montado = texto !== null || cargando || error !== null;

  return (
    <li
      id={idCita(mensajeId, cita.numero)}
      className={`chat-cita${abierta ? ' is-abierta' : ''}${cita.usada ? '' : ' chat-cita--no-usada'}`}
    >
      <button
        type="button"
        className="chat-cita-cabecera"
        aria-expanded={abierta}
        aria-controls={idPanel}
        onClick={onToggle}
      >
        <span className="chat-cita-marca">D{cita.numero}</span>
        <span className="chat-cita-titulo">
          <span className="chat-cita-ruta">{cita.rutaTitulos ?? 'Fragmento del documento'}</span>
          {!abierta && <span className="chat-cita-extracto">{cita.extracto}</span>}
        </span>
        <svg className="chat-cita-chevron" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
          <path d="M5 7.5 10 12.5 15 7.5" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* `grid-template-rows: 0fr → 1fr` anima la altura automática sin medir el DOM desde JS. */}
      <div className="chat-cita-plegado" id={idPanel} role="region" hidden={!abierta && !montado}>
        <div className="chat-cita-plegado-interior">
          {montado && (
            <div className="chat-cita-cuerpo">
              {cargando && (
                <div className="chat-cita-esqueleto" aria-label="Cargando el fragmento">
                  <div className="skeleton-block" />
                  <div className="skeleton-block" />
                  <div className="skeleton-block" />
                </div>
              )}

              {error && <p className="exp-nota is-error">{error}</p>}

              {texto !== null && (
                <>
                  <div className="chat-cita-texto">
                    <TextoChunk texto={texto} />
                  </div>
                  <div className="chat-cita-pie">
                    <button
                      type="button"
                      className="boton-secundario chat-cita-abrir"
                      onClick={() => onAbrirDocumento(cita)}
                    >
                      Abrir documento
                      <svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
                        <path d="M7 4h9v9M16 4 6 14M4 9v7h7" fill="none" stroke="currentColor"
                          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    <span className="chat-cita-tamano">
                      {cita.chars.toLocaleString('es-PE')} caracteres
                    </span>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

interface PropsLista {
  citas: CitaChat[];
  mensajeId: string;
  /** Número de la cita desplegada en este mensaje, o `null`. Vive en `ChatPage` porque los
   *  marcadores `[Dn]` del propio texto también pueden abrirla. */
  abierta: number | null;
  onToggle: (numero: number) => void;
  onAbrirDocumento: (cita: CitaChat) => void;
}

/**
 * Las citas de un mensaje, separando las que el modelo llegó a citar de las que solo se le
 * ofrecieron. `usada` venía del backend desde el principio pero la interfaz la ignoraba, así que
 * los fragmentos que el modelo descartó ocupaban tanto sitio como los que sustentan la respuesta.
 */
export function ListaCitas({ citas, mensajeId, abierta, onToggle, onAbrirDocumento }: PropsLista) {
  const [verNoUsadas, setVerNoUsadas] = useState(false);

  const usadas = citas.filter((c) => c.usada);
  const noUsadas = citas.filter((c) => !c.usada);
  // Si el modelo no citó ninguna, se muestran todas: esconderlas todas dejaría la respuesta sin
  // ninguna forma de verificarse, que es justamente lo que las citas existen para dar.
  const principales = usadas.length > 0 ? usadas : noUsadas;
  const secundarias = usadas.length > 0 ? noUsadas : [];

  const pintar = (c: CitaChat) => (
    <CitaBadge
      key={c.numero}
      cita={c}
      mensajeId={mensajeId}
      abierta={abierta === c.numero}
      onToggle={() => onToggle(c.numero)}
      onAbrirDocumento={onAbrirDocumento}
    />
  );

  return (
    <div className="chat-citas-bloque">
      <p className="chat-citas-titulo">
        {principales.length === 1 ? '1 fuente' : `${principales.length} fuentes`}
      </p>

      <ul className="chat-citas">{principales.map(pintar)}</ul>

      {secundarias.length > 0 && (
        <>
          <button
            type="button"
            className="boton-enlace chat-citas-mas"
            aria-expanded={verNoUsadas}
            onClick={() => setVerNoUsadas((v) => !v)}
          >
            {verNoUsadas
              ? 'Ocultar fragmentos consultados'
              : `Mostrar ${secundarias.length} fragmento(s) consultado(s) sin citar`}
          </button>
          {verNoUsadas && <ul className="chat-citas">{secundarias.map(pintar)}</ul>}
        </>
      )}
    </div>
  );
}
