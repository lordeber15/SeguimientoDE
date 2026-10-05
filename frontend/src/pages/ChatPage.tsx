import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type {
  AdaptadorChat,
  BloqueParticipantesChat,
  CitaBasica,
  DocumentoChat,
  FilaResultadoChat,
  ReferenciaExpediente,
  TablaResultadosChat as Tabla,
  TarjetaDocumentoChat,
  TipoRespuestaChat,
} from '../api/chatComun';
import { ParticipantesChat, TarjetaUltimoDocumento } from '../components/RespuestasEstructuradasChat';
import { TablaResultadosChat } from '../components/TablaResultadosChat';
import { useSesion } from '../auth/SesionContext';
import { idCita, ListaCitas } from '../components/CitaBadge';
import { OrbePensando } from '../components/OrbePensando';
import { idPanel, idPestana, Pestanas } from '../components/Pestanas';
import { RespuestaConCitas } from '../components/RespuestaConCitas';
import { VisorDocumento } from '../components/VisorDocumento';

type Modo = 'general' | 'contexto';

interface MensajeUI<C extends CitaBasica> {
  id: string;
  rol: 'user' | 'assistant';
  tipo?: TipoRespuestaChat;
  texto: string;
  citas?: C[];
  tabla?: Tabla;
  documento?: TarjetaDocumentoChat;
  participantes?: BloqueParticipantesChat;
  marcadoresAlucinados?: number;
}

interface DocumentoAbierto {
  url: string;
  titulo: string;
  visualizable: boolean;
}

interface EstadoIngestaGenerico {
  total: number;
  listos: number;
  convertidos: number;
  pendientes: number;
  sinTexto: number;
  error: number;
  noSoportado: number;
  completo: boolean;
}

interface Props<E, C extends CitaBasica> {
  adaptador: AdaptadorChat<E, C>;
  /** Presente cuando se llega con una entidad ya elegida desde otra pantalla (ej. "Chat de este
   *  expediente" en Seguimiento). `null`/ausente arranca en el buscador. */
  contextoInicial?: E | null;
  /** Modal de gestión de indexación ("Documentos (n)") — propio de cada sistema (hoy solo el
   *  SGD tiene uno, ver `ModalIndexacionExpediente`). Sin esto, el botón no se muestra. */
  renderModalGestion?: (args: { entidad: E; cerrar: () => void; onCambio: () => void }) => ReactNode;
}

const LARGO_MIN_BUSQUEDA = 3; // mismo umbral que exige el backend
const ALTO_MAX_ENTRADA = 132; // ~5 líneas: a partir de ahí el campo hace scroll en vez de crecer
/** El backend no hace streaming: pasado este tiempo se asume que ya terminó la búsqueda y el
 *  modelo está redactando. Es una aproximación del flujo RAG, no una señal real del servidor. */
const MS_HASTA_REDACTAR = 3000;

/** Respeta la preferencia del sistema — el mismo criterio que el `@media` de `index.css`. */
function prefiereMenosMovimiento(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Chat sobre un corpus RAG — PLAN-RAG.md §9. Genérico sobre el sistema (SGD o STD): todo lo que
 * cambia entre ellos (cómo se busca el contexto, cómo se etiqueta, cómo se abre el documento
 * citado) vive en el `adaptador` (ver `api/chatComun.ts`); esta página solo orquesta el flujo de
 * conversación, que es idéntico en ambos.
 *
 * Sin resaltado de página/offset todavía: la cita ya muestra el texto literal del fragmento y
 * enlaza al documento real, que es lo que hace la cita "verificable"; saltar al punto exacto
 * dentro del PDF es una mejora de UX aparte.
 *
 * Bloqueado hasta que haya un proveedor de chat configurado — el backend responde con un mensaje
 * explícito en ese caso (igual que "Generar embeddings" en el panel de RAG).
 */
export function ChatPage<E, C extends CitaBasica>({ adaptador, contextoInicial, renderModalGestion }: Props<E, C>) {
  const { puede } = useSesion();
  const puedeGestionar = puede(adaptador.permisoGestionar);
  const [modo, setModo] = useState<Modo>(contextoInicial ? 'contexto' : 'general');
  const [seleccionado, setSeleccionado] = useState<E | null>(contextoInicial ?? null);
  const [termino, setTermino] = useState('');
  const [resultados, setResultados] = useState<E[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [errorBusqueda, setErrorBusqueda] = useState<string | null>(null);
  const [sesionId, setSesionId] = useState<number | undefined>();
  const [mensajes, setMensajes] = useState<MensajeUI<C>[]>([]);
  const [entrada, setEntrada] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [redactando, setRedactando] = useState(false);
  const [cargandoInicial, setCargandoInicial] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documentoAbierto, setDocumentoAbierto] = useState<DocumentoAbierto | null>(null);
  const [estadoIngesta, setEstadoIngesta] = useState<EstadoIngestaGenerico | null>(null);
  const [modalGestionAbierto, setModalGestionAbierto] = useState(false);
  /** Cita desplegada por mensaje. Vive aquí, y no en cada cita, porque un marcador `[Dn]` del
   *  propio texto también puede abrirla — y solo una a la vez por mensaje. */
  const [citaAbierta, setCitaAbierta] = useState<Record<string, number | null>>({});

  const listaRef = useRef<HTMLOListElement>(null);
  const entradaRef = useRef<HTMLTextAreaElement>(null);

  const claveSeleccionado = seleccionado ? adaptador.claveEntidad(seleccionado) : null;

  const puedeEnviar =
    entrada.trim().length > 0 && !enviando && !cargandoInicial && (modo === 'general' || seleccionado !== null);

  // Precarga de sesión + historial de ESTA entidad — corre cada vez que cambia la selección, ya sea
  // porque se llegó con `contextoInicial` o porque se acaba de buscar y elegir aquí mismo. El
  // componente se remonta entero cada vez que `App.tsx` navega a esta pestaña (no hay router), así
  // que a la llegada este efecto siempre corre limpio una sola vez.
  useEffect(() => {
    if (modo !== 'contexto' || !seleccionado) return;
    let vigente = true;
    setSesionId(undefined);
    setMensajes([]);
    setCitaAbierta({});
    setError(null);
    setCargandoInicial(true);

    (async () => {
      try {
        const sesion = await adaptador.fetchSesion(seleccionado);
        if (!vigente) return;
        if (sesion) {
          setSesionId(sesion.id);
          const historial = await adaptador.fetchHistorial(sesion.id);
          if (!vigente) return;
          setMensajes(
            historial.map((m) => ({
              id: String(m.id), rol: m.rol, tipo: m.tipo, texto: m.texto, citas: m.citas,
              tabla: m.tabla, documento: m.documento, participantes: m.participantes,
            })),
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
  }, [modo, claveSeleccionado]);

  // Aviso de cobertura: corre sin importar cómo se llegó a la entidad (contexto inicial, o buscada y
  // elegida aquí mismo). Falla en silencio a propósito — es un aviso informativo, no debe ensuciar
  // el flujo de chat si esta consulta puntual falla. Se expone como función aparte para poder
  // refrescarlo a demanda cuando el modal de gestión cambia algo, sin duplicar la llamada.
  const refrescarEstadoIngesta = useCallback(() => {
    if (modo !== 'contexto' || !seleccionado) return;
    adaptador.fetchEstadoIngesta(seleccionado).then(setEstadoIngesta).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modo, claveSeleccionado]);

  useEffect(() => {
    if (modo !== 'contexto' || !seleccionado) {
      setEstadoIngesta(null);
      return;
    }
    refrescarEstadoIngesta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modo, claveSeleccionado]);

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

  // Fase del indicador: "Buscando…" al enviar y "Redactando…" pasados unos segundos.
  useEffect(() => {
    setRedactando(false);
    if (!enviando) return;
    const temporizador = window.setTimeout(() => setRedactando(true), MS_HASTA_REDACTAR);
    return () => window.clearTimeout(temporizador);
  }, [enviando]);

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
    // Cambiar de modo empieza una conversación nueva: la entidad en curso forma parte del contexto
    // del chat, así que mezclar sesiones de dos modos distintos no tendría sentido.
    setModo(nuevo);
    setSesionId(undefined);
    setMensajes([]);
    setCitaAbierta({});
    setError(null);
  }

  async function buscarEntidad(e: React.FormEvent) {
    e.preventDefault();
    const consulta = termino.trim();
    if (consulta.length < LARGO_MIN_BUSQUEDA || buscando) return;

    setBuscando(true);
    setErrorBusqueda(null);
    setResultados(null);

    try {
      const encontrados = await adaptador.buscar(consulta);
      if (encontrados.length === 1) {
        elegirEntidad(encontrados[0]);
      } else {
        setResultados(encontrados);
      }
    } catch (err) {
      setErrorBusqueda(err instanceof Error ? err.message : 'No se pudo buscar');
    } finally {
      setBuscando(false);
    }
  }

  function elegirEntidad(e: E) {
    setSeleccionado(e);
    setResultados(null);
    setTermino('');
    setErrorBusqueda(null);
  }

  /** "Chatear" desde una fila de un listado: pasa al modo por contexto con esa entidad ya elegida. */
  function chatearConFila(fila: FilaResultadoChat) {
    const entidad = adaptador.entidadDesdeFila?.(fila);
    if (!entidad) return;
    cambiarModo('contexto');
    elegirEntidad(entidad);
  }

  function chatearConExpediente(ref: ReferenciaExpediente) {
    const entidad = adaptador.entidadDesdeExpediente?.(ref);
    if (!entidad) return;
    cambiarModo('contexto');
    elegirEntidad(entidad);
  }

  function abrirDocumentoTarjeta(doc: DocumentoChat) {
    if (!adaptador.abrirDocumento) return;
    const abierto = adaptador.abrirDocumento(doc);
    // Un documento del STD sin PDF principal no tiene nada que abrir.
    if (abierto.url) setDocumentoAbierto(abierto);
  }

  function cambiarEntidad() {
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
      const respuesta = modo === 'general'
        ? await adaptador.enviarGeneral(texto, sesionId)
        : await adaptador.enviarContexto(seleccionado as E, texto, sesionId);

      setSesionId(respuesta.sesionId);
      setMensajes((m) => [
        ...m,
        {
          id: String(respuesta.mensajeId),
          rol: 'assistant',
          tipo: respuesta.tipo,
          texto: respuesta.texto,
          citas: respuesta.citas,
          tabla: respuesta.tabla,
          documento: respuesta.documento,
          participantes: respuesta.participantes,
          marcadoresAlucinados: respuesta.marcadoresAlucinados,
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo enviar el mensaje');
    } finally {
      setEnviando(false);
    }
  }

  function abrirCita(cita: C) {
    const { url, titulo, visualizable } = adaptador.abrirCita(cita);
    setDocumentoAbierto({ url, titulo, visualizable });
  }

  const pestanas = [
    { clave: 'general' as const, etiqueta: adaptador.etiquetaPestanaGeneral },
    { clave: 'contexto' as const, etiqueta: adaptador.etiquetaPestanaContexto },
  ];

  return (
    <main className="app-main app-main--ancho">
      <section className="rag-tarjeta rag-tarjeta--ancha chat-tarjeta">
        <Pestanas pestanas={pestanas} activa={modo} onCambiar={cambiarModo} etiqueta="Alcance del chat" />

        <div role="tabpanel" id={idPanel(modo)} aria-labelledby={idPestana(modo)}>
          {modo === 'general' && <p className="exp-nota">{adaptador.notaGeneral}</p>}

          {modo === 'contexto' && !seleccionado && (
            <form className="busqueda-expediente" onSubmit={buscarEntidad}>
              <label htmlFor="chat-buscar-entidad">{adaptador.labelBusqueda}</label>
              <div className="busqueda-expediente-campo">
                <input
                  id="chat-buscar-entidad"
                  type="search"
                  value={termino}
                  onChange={(e) => setTermino(e.target.value)}
                  placeholder={adaptador.placeholderBusqueda}
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
            <div className="state-message">{adaptador.notaSinResultados}</div>
          )}

          {resultados !== null && resultados.length > 0 && (
            <ul className="resultados-expediente">
              {resultados.map((r) => (
                <li key={adaptador.claveEntidad(r)}>
                  <button type="button" className="boton-enlace" onClick={() => elegirEntidad(r)}>
                    {adaptador.etiquetaEntidad(r)}
                  </button>
                  <span className="exp-nota">{adaptador.descripcionResultado(r)}</span>
                </li>
              ))}
            </ul>
          )}

          {modo === 'contexto' && seleccionado && (
            <div className="chat-expediente-elegido">
              <span>{adaptador.etiquetaEntidad(seleccionado)}</span>
              <button type="button" className="boton-enlace" onClick={cambiarEntidad}>
                Cambiar
              </button>
              {renderModalGestion && puedeGestionar && (
                <button
                  type="button"
                  className="boton-enlace"
                  onClick={() => setModalGestionAbierto(true)}
                >
                  Documentos{estadoIngesta ? ` (${estadoIngesta.total})` : ''}
                </button>
              )}
            </div>
          )}

          {modo === 'contexto' && seleccionado && estadoIngesta && (
            <AvisoIngesta
              estado={estadoIngesta}
              sustantivoContexto={adaptador.sustantivoContexto}
              puedeGestionar={puedeGestionar && !!renderModalGestion}
              onCorregir={() => setModalGestionAbierto(true)}
            />
          )}

          <ol className="chat-lista" aria-live="polite" ref={listaRef}>
            {cargandoInicial && (
              <li className="exp-nota chat-escribiendo">
                <OrbePensando estado="breathing" />
                Cargando conversación anterior…
              </li>
            )}
            {!cargandoInicial && mensajes.length === 0 && (
              <li className="exp-nota chat-vacio">
                {modo === 'general'
                  ? adaptador.notaVacioGeneral
                  : seleccionado
                    ? adaptador.notaVacioConSeleccion
                    : adaptador.notaVacioSinSeleccion}
              </li>
            )}
            {mensajes.map((m) => (
              <li
                key={m.id}
                className={`chat-mensaje chat-mensaje--${m.rol}${m.tipo === 'fijo' ? ' chat-mensaje--fijo' : ''}${m.tabla || m.documento || m.participantes ? ' chat-mensaje--tabla' : ''}`}
              >
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

                {m.tabla && adaptador.fetchResultados && adaptador.etiquetaFila && (
                  <TablaResultadosChat
                    tabla={m.tabla}
                    mensajeId={m.id}
                    cargarPagina={adaptador.fetchResultados}
                    etiquetaFila={adaptador.etiquetaFila}
                    onChatear={adaptador.entidadDesdeFila ? chatearConFila : undefined}
                    encabezadoNumero={adaptador.sustantivoContexto.charAt(0).toUpperCase() + adaptador.sustantivoContexto.slice(1)}
                  />
                )}

                {m.documento && (
                  <TarjetaUltimoDocumento
                    documento={m.documento}
                    mostrarExpediente={modo === 'general'}
                    sustantivo={adaptador.sustantivoContexto}
                    onAbrir={adaptador.abrirDocumento ? abrirDocumentoTarjeta : undefined}
                    onChatear={adaptador.entidadDesdeExpediente ? chatearConExpediente : undefined}
                  />
                )}

                {m.participantes && (
                  <ParticipantesChat
                    participantes={m.participantes}
                    sustantivo={adaptador.sustantivoContexto}
                    onChatear={modo === 'general' && adaptador.entidadDesdeExpediente ? chatearConExpediente : undefined}
                  />
                )}

                {m.citas && m.citas.length > 0 && (
                  <ListaCitas
                    citas={m.citas}
                    mensajeId={m.id}
                    abierta={citaAbierta[m.id] ?? null}
                    onToggle={(numero) => alternarCita(m.id, numero)}
                    onAbrirDocumento={abrirCita}
                    fetchTexto={adaptador.fetchTexto}
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
                <OrbePensando estado={redactando ? 'composing' : 'searching'} />
                <span className="chat-escribiendo-texto">
                  {redactando ? 'Redactando la respuesta…' : 'Buscando en los documentos…'}
                </span>
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

      {modalGestionAbierto && seleccionado && renderModalGestion && renderModalGestion({
        entidad: seleccionado,
        cerrar: () => setModalGestionAbierto(false),
        onCambio: refrescarEstadoIngesta,
      })}
    </main>
  );
}

/** Aviso no bloqueante: el usuario puede seguir preguntando con cobertura parcial. */
function AvisoIngesta({
  estado, sustantivoContexto, puedeGestionar, onCorregir,
}: {
  estado: EstadoIngestaGenerico;
  sustantivoContexto: string;
  puedeGestionar: boolean;
  onCorregir: () => void;
}) {
  if (estado.completo) return null;

  if (estado.total === 0) {
    return (
      <div className="chat-aviso">
        Este {sustantivoContexto} todavía no tiene documentos indexados en la base de
        conocimientos — las respuestas del chat no van a encontrar nada de este {sustantivoContexto}.
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
        {estado.listos} de {estado.total} documentos de este {sustantivoContexto} están
        totalmente indexados
        {detalles.length > 0 && ` (${detalles.join(', ')})`} — las respuestas pueden estar
        incompletas.
      </p>
      {puedeGestionar && (
        <button type="button" className="boton-secundario chat-aviso-boton" onClick={onCorregir}>
          Ver y corregir indexación
        </button>
      )}
    </div>
  );
}
