import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  buscarExpedientesChat,
  enviarMensajeExpediente,
  enviarMensajeGeneral,
  etiquetaExpediente,
  fetchEstadoIngestaExpediente,
  fetchHistorialSesion,
  fetchSesionExpediente,
  type CitaChat,
  type EstadoIngestaExpediente,
  type ExpedienteChat,
  type RespuestaChat,
} from '../api/chat';
import { rutaAnexo, rutaDocumento } from '../api/documentos';
import { useSesion } from '../auth/SesionContext';
import { idCita, ListaCitas } from '../components/CitaBadge';
import { ModalIndexacionExpediente } from '../components/ModalIndexacionExpediente';
import { idPanel, idPestana, Pestanas } from '../components/Pestanas';
import { RespuestaConCitas } from '../components/RespuestaConCitas';
import { VisorDocumento } from '../components/VisorDocumento';

type Modo = 'general' | 'expediente';

const PESTANAS_CHAT = [
  { clave: 'general', etiqueta: 'General SGD' },
  { clave: 'expediente', etiqueta: 'Por expediente' },
] as const satisfies readonly { clave: Modo; etiqueta: string }[];

interface MensajeUI {
  id: string;
  rol: 'user' | 'assistant';
  texto: string;
  citas?: CitaChat[];
  marcadoresAlucinados?: number;
}

interface DocumentoAbierto {
  url: string;
  titulo: string;
  visualizable: boolean;
}

interface Props {
  /** Presente cuando se llega desde el botón "Chat de este expediente" de la tabla de Seguimiento. */
  expedienteInicial?: { nuAnnExp: string; nuSecExp: string; numeroExpediente?: string | null } | null;
}

const LARGO_MIN_BUSQUEDA = 3; // mismo umbral que exige el backend
const ALTO_MAX_ENTRADA = 132; // ~5 líneas: a partir de ahí el campo hace scroll en vez de crecer

/** Respeta la preferencia del sistema — el mismo criterio que el `@media` de `index.css`. */
function prefiereMenosMovimiento(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** El expediente que llega desde Seguimiento, con la forma que usa el resto de la página. */
function desdeSeguimiento(inicial: Props['expedienteInicial']): ExpedienteChat | null {
  if (!inicial) return null;
  return {
    nuAnnExp: inicial.nuAnnExp,
    nuSecExp: inicial.nuSecExp,
    numeroExpediente: inicial.numeroExpediente ?? null,
    // Los contadores solo alimentan la lista de resultados de búsqueda; el aviso de cobertura que
    // se pinta abajo los pide aparte y en vivo (`fetchEstadoIngestaExpediente`).
    documentos: 0,
    ingestados: 0,
  };
}

/**
 * Chat sobre el corpus RAG — PLAN-RAG.md §9. Sin resaltado de página/offset todavía: la cita ya
 * muestra el texto literal del fragmento y enlaza al documento real, que es lo que hace la cita
 * "verificable"; saltar al punto exacto dentro del PDF es una mejora de UX aparte.
 *
 * Bloqueado hasta que haya un proveedor de chat configurado — el backend responde con un mensaje
 * explícito en ese caso (igual que "Generar embeddings" en el panel de RAG).
 */
export function ChatPage({ expedienteInicial }: Props) {
  const { puede } = useSesion();
  const puedeGestionarRag = puede('rag.gestionar');
  const [modo, setModo] = useState<Modo>(expedienteInicial ? 'expediente' : 'general');
  const [seleccionado, setSeleccionado] = useState<ExpedienteChat | null>(desdeSeguimiento(expedienteInicial));
  const [termino, setTermino] = useState('');
  const [resultados, setResultados] = useState<ExpedienteChat[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [errorBusqueda, setErrorBusqueda] = useState<string | null>(null);
  const [sesionId, setSesionId] = useState<number | undefined>();
  const [mensajes, setMensajes] = useState<MensajeUI[]>([]);
  const [entrada, setEntrada] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [cargandoInicial, setCargandoInicial] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documentoAbierto, setDocumentoAbierto] = useState<DocumentoAbierto | null>(null);
  const [estadoIngesta, setEstadoIngesta] = useState<EstadoIngestaExpediente | null>(null);
  const [modalIndexacionAbierto, setModalIndexacionAbierto] = useState(false);
  /** Cita desplegada por mensaje. Vive aquí, y no en cada cita, porque un marcador `[Dn]` del
   *  propio texto también puede abrirla — y solo una a la vez por mensaje. */
  const [citaAbierta, setCitaAbierta] = useState<Record<string, number | null>>({});

  const listaRef = useRef<HTMLOListElement>(null);
  const entradaRef = useRef<HTMLTextAreaElement>(null);

  const puedeEnviar =
    entrada.trim().length > 0 && !enviando && !cargandoInicial && (modo === 'general' || seleccionado !== null);

  // Precarga de sesión + historial de ESTE expediente — corre cada vez que cambia la selección, ya
  // sea porque se llegó desde el botón de Seguimiento o porque se acaba de buscar y elegir aquí
  // mismo. El componente se remonta entero cada vez que `App.tsx` navega a la pestaña "Chat" (no
  // hay router), así que a la llegada este efecto siempre corre limpio una sola vez.
  useEffect(() => {
    if (modo !== 'expediente' || !seleccionado) return;
    let vigente = true;
    setSesionId(undefined);
    setMensajes([]);
    setCitaAbierta({});
    setError(null);
    setCargandoInicial(true);

    (async () => {
      try {
        const sesion = await fetchSesionExpediente(seleccionado.nuAnnExp, seleccionado.nuSecExp);
        if (!vigente) return;
        if (sesion) {
          setSesionId(sesion.id);
          const historial = await fetchHistorialSesion(sesion.id);
          if (!vigente) return;
          setMensajes(
            historial.map((m) => ({ id: String(m.id), rol: m.rol, texto: m.texto, citas: m.citas })),
          );
        }
      } catch (err) {
        if (vigente) setError(err instanceof Error ? err.message : 'No se pudo cargar la conversación anterior');
      } finally {
        if (vigente) setCargandoInicial(false);
      }
    })();

    return () => {
      vigente = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modo, seleccionado?.nuAnnExp, seleccionado?.nuSecExp]);

  // Aviso de cobertura: corre sin importar cómo se llegó al expediente (botón, o buscado y elegido
  // aquí mismo). Falla en silencio a propósito — es un aviso informativo, no debe ensuciar el flujo
  // de chat si esta consulta puntual falla. Se expone como función aparte para poder refrescarlo a
  // demanda cuando el modal de indexación cambia algo, sin duplicar la llamada.
  const refrescarEstadoIngesta = useCallback(() => {
    if (modo !== 'expediente' || !seleccionado) return;
    fetchEstadoIngestaExpediente(seleccionado.nuAnnExp, seleccionado.nuSecExp)
      .then(setEstadoIngesta)
      .catch(() => {});
  }, [modo, seleccionado?.nuAnnExp, seleccionado?.nuSecExp]);

  useEffect(() => {
    if (modo !== 'expediente' || !seleccionado) {
      setEstadoIngesta(null);
      return;
    }
    refrescarEstadoIngesta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modo, seleccionado?.nuAnnExp, seleccionado?.nuSecExp]);

  // Al llegar un mensaje nuevo la conversación baja sola: sin esto la respuesta aparecía fuera de
  // la vista y había que buscarla a mano en el scroll. También sigue al indicador de "escribiendo".
  useEffect(() => {
    const lista = listaRef.current;
    if (!lista) return;
    lista.scrollTo({
      top: lista.scrollHeight,
      behavior: prefiereMenosMovimiento() ? 'auto' : 'smooth',
    });
  }, [mensajes.length, enviando, cargandoInicial]);

  // El campo crece con el texto hasta 5 líneas. `useLayoutEffect` para que el alto se ajuste en el
  // mismo cuadro en que se escribe y no haya un parpadeo de una línea.
  useLayoutEffect(() => {
    const campo = entradaRef.current;
    if (!campo) return;
    campo.style.height = 'auto';
    campo.style.height = `${Math.min(campo.scrollHeight, ALTO_MAX_ENTRADA)}px`;
  }, [entrada]);

  const alternarCita = useCallback((mensajeId: string, numero: number) => {
    setCitaAbierta((previo) => ({
      ...previo,
      [mensajeId]: previo[mensajeId] === numero ? null : numero,
    }));
  }, []);

  /** Un marcador `[Dn]` del texto despliega su cita y la trae a la vista. */
  const irACita = useCallback((mensajeId: string, numero: number) => {
    setCitaAbierta((previo) => ({ ...previo, [mensajeId]: numero }));
    // Tras el repintado: el panel acaba de montarse y su posición final aún no existe.
    requestAnimationFrame(() => {
      document.getElementById(idCita(mensajeId, numero))?.scrollIntoView({
        behavior: prefiereMenosMovimiento() ? 'auto' : 'smooth',
        block: 'nearest',
      });
    });
  }, []);

  function cambiarModo(nuevo: Modo) {
    // Cambiar de modo empieza una conversación nueva: el expediente en curso forma parte del
    // contexto del chat, así que mezclar sesiones de dos modos distintos no tendría sentido.
    setModo(nuevo);
    setSesionId(undefined);
    setMensajes([]);
    setCitaAbierta({});
    setError(null);
  }

  async function buscarExpediente(e: React.FormEvent) {
    e.preventDefault();
    const consulta = termino.trim();
    if (consulta.length < LARGO_MIN_BUSQUEDA || buscando) return;

    setBuscando(true);
    setErrorBusqueda(null);
    setResultados(null);

    try {
      const encontrados = await buscarExpedientesChat(consulta);
      if (encontrados.length === 1) {
        elegirExpediente(encontrados[0]);
      } else {
        setResultados(encontrados);
      }
    } catch (err) {
      setErrorBusqueda(err instanceof Error ? err.message : 'No se pudo buscar el expediente');
    } finally {
      setBuscando(false);
    }
  }

  function elegirExpediente(exp: ExpedienteChat) {
    setSeleccionado(exp);
    setResultados(null);
    setTermino('');
    setErrorBusqueda(null);
  }

  function cambiarExpediente() {
    setSeleccionado(null);
    setSesionId(undefined);
    setMensajes([]);
    setCitaAbierta({});
    setError(null);
  }

  function alTeclearEntrada(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter envía, Shift+Enter salta de línea — el campo pasó de `<input>` a `<textarea>` para
    // poder escribir preguntas de varias líneas sin perder el envío con una sola tecla.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (puedeEnviar) void enviar();
    }
  }

  async function enviar(e?: React.FormEvent) {
    e?.preventDefault();
    const texto = entrada.trim();
    if (!texto || enviando) return;

    setError(null);
    setMensajes((m) => [...m, { id: `u-${Date.now()}`, rol: 'user', texto }]);
    setEntrada('');
    setEnviando(true);

    try {
      const respuesta: RespuestaChat = modo === 'general'
        ? await enviarMensajeGeneral(texto, sesionId)
        : await enviarMensajeExpediente(seleccionado!.nuAnnExp, seleccionado!.nuSecExp, texto, sesionId);

      setSesionId(respuesta.sesionId);
      setMensajes((m) => [
        ...m,
        {
          id: String(respuesta.mensajeId),
          rol: 'assistant',
          texto: respuesta.texto,
          citas: respuesta.citas,
          marcadoresAlucinados: respuesta.marcadoresAlucinados,
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo enviar el mensaje');
    } finally {
      setEnviando(false);
    }
  }

  function abrirCita(cita: CitaChat) {
    const url = cita.nuAne > 0
      ? rutaAnexo(cita.nuAnn, cita.nuEmi, cita.nuAne)
      : rutaDocumento(cita.nuAnn, cita.nuEmi);
    setDocumentoAbierto({
      url,
      titulo: `[D${cita.numero}] ${cita.rutaTitulos ?? 'Documento citado'}`,
      // La mayoría del corpus es PDF; si no lo es, el visor igual ofrece "Descargar" en la cabecera.
      visualizable: true,
    });
  }

  return (
    <main className="app-main app-main--ancho">
      <section className="rag-tarjeta rag-tarjeta--ancha chat-tarjeta">
        <Pestanas
          pestanas={PESTANAS_CHAT}
          activa={modo}
          onCambiar={cambiarModo}
          etiqueta="Alcance del chat"
        />

        <div role="tabpanel" id={idPanel(modo)} aria-labelledby={idPestana(modo)}>
          {modo === 'general' && (
            <p className="exp-nota">
              Pregunta sobre todos los documentos del SGD accesibles para su cuenta.
            </p>
          )}

          {modo === 'expediente' && !seleccionado && (
            <form className="busqueda-expediente" onSubmit={buscarExpediente}>
              <label htmlFor="chat-buscar-expediente">N° de expediente</label>
              <div className="busqueda-expediente-campo">
                <input
                  id="chat-buscar-expediente"
                  type="search"
                  value={termino}
                  onChange={(e) => setTermino(e.target.value)}
                  placeholder="Ej. DE000020260000062 o 2026-0000325"
                />
                <button
                  type="submit"
                  className="boton-secundario"
                  disabled={buscando || termino.trim().length < LARGO_MIN_BUSQUEDA}
                >
                  {buscando ? 'Buscando…' : 'Buscar'}
                </button>
              </div>
            </form>
          )}

          {errorBusqueda && (
            <div className="state-message is-error" role="alert">
              {errorBusqueda}
            </div>
          )}

          {resultados !== null && resultados.length === 0 && (
            <div className="state-message">No se encontró ningún expediente con ese número.</div>
          )}

          {resultados !== null && resultados.length > 0 && (
            <ul className="resultados-expediente">
              {resultados.map((r) => (
                <li key={`${r.nuAnnExp}-${r.nuSecExp}`}>
                  <button type="button" className="boton-enlace" onClick={() => elegirExpediente(r)}>
                    {etiquetaExpediente(r)}
                  </button>
                  <span className="exp-nota">
                    {r.ingestados} de {r.documentos} documentos indexados
                  </span>
                </li>
              ))}
            </ul>
          )}

          {modo === 'expediente' && seleccionado && (
            <div className="chat-expediente-elegido">
              <span>
                Expediente <strong>{etiquetaExpediente(seleccionado)}</strong>
              </span>
              <button type="button" className="boton-enlace" onClick={cambiarExpediente}>
                Cambiar
              </button>
              {puedeGestionarRag && (
                <button
                  type="button"
                  className="boton-enlace"
                  onClick={() => setModalIndexacionAbierto(true)}
                >
                  Documentos{estadoIngesta ? ` (${estadoIngesta.total})` : ''}
                </button>
              )}
            </div>
          )}

          {modo === 'expediente' && seleccionado && estadoIngesta && (
            <AvisoIngesta
              estado={estadoIngesta}
              puedeGestionarRag={puedeGestionarRag}
              onCorregir={() => setModalIndexacionAbierto(true)}
            />
          )}

          <ol className="chat-lista" aria-live="polite" ref={listaRef}>
            {cargandoInicial && <li className="exp-nota">Cargando conversación anterior…</li>}
            {!cargandoInicial && mensajes.length === 0 && (
              <li className="exp-nota chat-vacio">
                {modo === 'general'
                  ? 'Escriba una pregunta sobre los documentos del SGD a los que tiene acceso.'
                  : seleccionado
                    ? 'Escriba una pregunta sobre este expediente.'
                    : 'Busque el expediente por su número para empezar.'}
              </li>
            )}
            {mensajes.map((m) => (
              <li key={m.id} className={`chat-mensaje chat-mensaje--${m.rol}`}>
                {m.rol === 'assistant' && m.citas && m.citas.length > 0 ? (
                  <RespuestaConCitas
                    texto={m.texto}
                    numerosValidos={new Set(m.citas.map((c) => c.numero))}
                    mensajeId={m.id}
                    onIrACita={(numero) => irACita(m.id, numero)}
                  />
                ) : (
                  <p className="chat-texto">{m.texto}</p>
                )}

                {m.citas && m.citas.length > 0 && (
                  <ListaCitas
                    citas={m.citas}
                    mensajeId={m.id}
                    abierta={citaAbierta[m.id] ?? null}
                    onToggle={(numero) => alternarCita(m.id, numero)}
                    onAbrirDocumento={abrirCita}
                  />
                )}

                {!!m.marcadoresAlucinados && m.marcadoresAlucinados > 0 && (
                  <p className="exp-nota is-error">
                    El modelo mencionó {m.marcadoresAlucinados} cita(s) que no corresponden a ningún
                    fragmento real; se quitaron de la respuesta.
                  </p>
                )}
              </li>
            ))}
            {enviando && (
              <li className="chat-mensaje chat-mensaje--assistant chat-escribiendo">
                <span className="chat-punto" />
                <span className="chat-punto" />
                <span className="chat-punto" />
                <span className="chat-escribiendo-texto">Buscando en los documentos…</span>
              </li>
            )}
          </ol>

          {error && (
            <div className="state-message is-error" role="alert">
              {error}
            </div>
          )}

          <form className="chat-form" onSubmit={enviar}>
            <textarea
              ref={entradaRef}
              rows={1}
              value={entrada}
              onChange={(e) => setEntrada(e.target.value)}
              onKeyDown={alTeclearEntrada}
              placeholder="Escriba su pregunta…"
              disabled={enviando}
            />
            <button type="submit" className="boton-primario" disabled={!puedeEnviar}>
              Enviar
            </button>
          </form>
        </div>
      </section>

      {documentoAbierto && (
        <VisorDocumento
          url={documentoAbierto.url}
          titulo={documentoAbierto.titulo}
          visualizable={documentoAbierto.visualizable}
          onCerrar={() => setDocumentoAbierto(null)}
        />
      )}

      {modalIndexacionAbierto && seleccionado && (
        <ModalIndexacionExpediente
          nuAnnExp={seleccionado.nuAnnExp}
          nuSecExp={seleccionado.nuSecExp}
          numeroExpediente={etiquetaExpediente(seleccionado)}
          onCerrar={() => setModalIndexacionAbierto(false)}
          onCambio={refrescarEstadoIngesta}
        />
      )}
    </main>
  );
}

/** Aviso no bloqueante: el usuario puede seguir preguntando con cobertura parcial. */
function AvisoIngesta({
  estado, puedeGestionarRag, onCorregir,
}: {
  estado: EstadoIngestaExpediente;
  puedeGestionarRag: boolean;
  onCorregir: () => void;
}) {
  if (estado.completo) return null;

  if (estado.total === 0) {
    return (
      <div className="chat-aviso">
        Este expediente todavía no tiene documentos indexados en la base de conocimientos — las
        respuestas del chat no van a encontrar nada de este expediente.
      </div>
    );
  }

  const detalles: string[] = [];
  if (estado.pendientes > 0) detalles.push(`${estado.pendientes} pendiente(s)`);
  if (estado.convertidos > 0) detalles.push(`${estado.convertidos} convertido(s) sin embeddings`);
  if (estado.sinTexto > 0) detalles.push(`${estado.sinTexto} sin texto extraíble`);
  if (estado.error > 0) detalles.push(`${estado.error} con error`);
  if (estado.noSoportado > 0) detalles.push(`${estado.noSoportado} de formato no soportado`);

  return (
    <div className="chat-aviso">
      <p>
        {estado.listos} de {estado.total} documentos de este expediente están totalmente indexados
        {detalles.length > 0 && ` (${detalles.join(', ')})`} — las respuestas pueden estar
        incompletas.
      </p>
      {puedeGestionarRag && (
        <button type="button" className="boton-secundario chat-aviso-boton" onClick={onCorregir}>
          Ver y corregir indexación
        </button>
      )}
    </div>
  );
}
