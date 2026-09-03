import { useEffect, useState } from 'react';
import {
  extraerConVision,
  fetchDocumentos,
  fetchMarkdownDocumento,
  iniciarIngestaEmbeddings,
  reintentarDocumento,
  type DocumentoRag,
  type MarkdownDocumento,
} from '../api/rag';
import { rutaAnexo, rutaDocumento } from '../api/documentos';
import { VisorDocumento } from './VisorDocumento';

const ETIQUETA_ESTADO: Record<string, string> = {
  pendiente: 'Pendiente',
  en_proceso: 'En proceso',
  convertido: 'Convertido',
  ok: 'Completo',
  sin_texto: 'Sin texto',
  error: 'Error',
  omitido: 'Omitido',
  no_soportado: 'Sin archivo',
};

const CLASE_ESTADO: Record<string, string> = {
  pendiente: 'badge-pendiente',
  en_proceso: 'badge-progreso',
  convertido: 'badge-progreso',
  ok: 'badge-atendido',
  sin_texto: 'badge-anulado',
  error: 'badge-anulado',
  omitido: 'badge-neutro',
  no_soportado: 'badge-neutro',
};

// `no_soportado` no siempre significa "irrecuperable": los fallos reintentables (circuito de
// markitdown, timeout, red) devuelven el documento a `pendiente` sin dejar `motivo_error` — por
// diseño (ver ingestaService.ts), para que el siguiente job los recoja solos. Si aquí apareciera
// algún `error` sin motivo sería justamente ese caso, pero no debería ocurrir: se documenta la
// regla en el propio filtro para que quien mire la lista no se sorprenda si un día lo ve.
const ESTADOS_FILTRO = [
  { valor: '', etiqueta: 'Todos los estados' },
  { valor: 'sin_texto', etiqueta: 'Sin texto' },
  { valor: 'error', etiqueta: 'Con error' },
  { valor: 'no_soportado', etiqueta: 'Sin archivo digital' },
  { valor: 'pendiente', etiqueta: 'Pendiente' },
  { valor: 'convertido', etiqueta: 'Convertido' },
  { valor: 'ok', etiqueta: 'Completo' },
] as const;

interface DocumentoAbierto {
  url: string;
  titulo: string;
  visualizable: boolean;
}

type EstadoMarkdown =
  | { tipo: 'cargando' }
  | { tipo: 'error'; mensaje: string }
  | { tipo: 'listo'; datos: MarkdownDocumento };

/** Estados en los que reintentar de verdad puede cambiar algo. */
const ESTADOS_REINTENTABLES = new Set(['no_soportado', 'sin_texto', 'error', 'pendiente']);

/**
 * Último recurso manual: solo tiene sentido cuando markitdown ya falló en darnos texto. No se
 * ofrece en `no_soportado` (ahí no hay archivo que mandarle a la IA) ni en estados ya resueltos.
 */
const ESTADOS_CON_VISION = new Set(['sin_texto', 'error']);

interface AvisoFila {
  tipo: 'ok' | 'error';
  texto: string;
}

interface Props {
  /** Acota la lista a los documentos de un trabajo de ingesta puntual (ver RagPanelPage). */
  jobId?: number;
  /** Vuelve a la lista global de documentos, sin acotar por trabajo. */
  onQuitarFiltroJob?: () => void;
  /** Hay un job masivo corriendo — reintentar un documento ahora quedaría en cola detrás de él. */
  jobEnCurso?: boolean;
  /** El circuito de markitdown está abierto — un reintento ahora mismo se rechazaría igual. */
  circuitoAbierto?: boolean;
  /** ¿Hay clave de OpenAI configurada para la extracción con IA? */
  visionDisponible?: boolean;
  /** Motivo a mostrar cuando `visionDisponible` es falso (p.ej. "OPENAI_API_KEY: falta…"). */
  visionMotivo?: string | null;
  /** Acota la lista a los documentos de UN expediente (usado por el modal de indexación del chat). */
  nuAnnExp?: string;
  nuSecExp?: string;
  /** Filtro de estado con el que arranca la lista. El panel usa 'sin_texto'; el modal, '' (todos). */
  estadoInicial?: string;
  /** ¿Hay un modelo de embeddings activo y su proveedor disponible? */
  embeddingDisponible?: boolean;
  /** Motivo a mostrar cuando `embeddingDisponible` es falso. */
  embeddingMotivo?: string | null;
  /** Muestra una columna de casillas para elegir un subconjunto de filas (modal de indexación). */
  seleccionables?: boolean;
  seleccion?: Set<number>;
  onSeleccionCambio?: (ids: Set<number>) => void;
  /** Se llama tras cualquier acción por fila que pudo cambiar el estado del expediente. */
  onCambio?: () => void;
  /** Se llama cuando una acción por fila lanza un job — para que el modal lo sondee en un único sitio. */
  onJobLanzado?: (jobId: number) => void;
  /** Cambia para forzar un refetch externo (p.ej. al completarse un job del modal que la contiene). */
  recargaSenal?: number;
}

export function ListaDocumentosRag({
  jobId, onQuitarFiltroJob, jobEnCurso, circuitoAbierto, visionDisponible, visionMotivo,
  nuAnnExp, nuSecExp, estadoInicial, embeddingDisponible, embeddingMotivo,
  seleccionables, seleccion, onSeleccionCambio, onCambio, onJobLanzado, recargaSenal,
}: Props = {}) {
  const [filtroEstado, setFiltroEstado] = useState(estadoInicial ?? 'sin_texto');
  const [filtroTexto, setFiltroTexto] = useState('');
  const [pagina, setPagina] = useState(1);
  const [recarga, setRecarga] = useState(0);

  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<DocumentoRag[]>([]);
  const [total, setTotal] = useState(0);
  const [porPagina, setPorPagina] = useState(50);

  const [documentoAbierto, setDocumentoAbierto] = useState<DocumentoAbierto | null>(null);
  const [markdownAbierto, setMarkdownAbierto] = useState<{ titulo: string } | null>(null);
  const [estadoMarkdown, setEstadoMarkdown] = useState<EstadoMarkdown>({ tipo: 'cargando' });

  // Una sola acción manual en vuelo a la vez, en todo el componente — así un despiste no encadena
  // varios reintentos a la vez contra un pipeline de concurrencia 1.
  const [idEnCurso, setIdEnCurso] = useState<number | null>(null);
  const [avisoFila, setAvisoFila] = useState<Record<number, AvisoFila>>({});

  // Cambiar de filtro vuelve a la página 1 — sin esto, filtrar en la página 3 podría dejar una
  // lista vacía si el nuevo filtro tiene menos resultados.
  useEffect(() => setPagina(1), [filtroEstado, filtroTexto, jobId, nuAnnExp, nuSecExp]);

  // Un trabajo incluye documentos en cualquier estado (pendientes, ok, error…), no solo
  // "sin texto" o "con error" — el filtro de estado por defecto escondería la mayoría de sus
  // documentos si no se limpiara al entrar a ver un trabajo concreto.
  useEffect(() => {
    if (jobId) setFiltroEstado('');
  }, [jobId]);

  useEffect(() => {
    let vigente = true;
    setCargando(true);
    setError(null);

    fetchDocumentos({
      estado: filtroEstado || undefined,
      q: filtroTexto || undefined,
      nuAnnExp,
      nuSecExp,
      jobId,
      pagina,
    })
      .then((datos) => {
        if (!vigente) return;
        setItems(datos.items);
        setTotal(datos.total);
        setPorPagina(datos.porPagina);
      })
      .catch((err: unknown) => {
        if (vigente) setError(err instanceof Error ? err.message : 'No se pudo cargar la lista');
      })
      .finally(() => {
        if (vigente) setCargando(false);
      });

    return () => {
      vigente = false;
    };
  }, [filtroEstado, filtroTexto, nuAnnExp, nuSecExp, jobId, pagina, recarga, recargaSenal]);

  function abrirDocumento(doc: DocumentoRag) {
    const url = doc.nuAne > 0 ? rutaAnexo(doc.nuAnn, doc.nuEmi, doc.nuAne) : rutaDocumento(doc.nuAnn, doc.nuEmi);
    setDocumentoAbierto({ url, titulo: doc.titulo ?? `${doc.nuAnn}-${doc.nuEmi}`, visualizable: true });
  }

  /**
   * Al terminar NO se recarga la lista: recargar bajo el filtro por defecto ("sin_texto") haría
   * desaparecer la fila justo al tener éxito, escondiendo el resultado que se estaba esperando. En
   * su lugar, la fila devuelta se inserta en su sitio y queda con una nota hasta "Actualizar".
   */
  async function reintentar(doc: DocumentoRag) {
    setIdEnCurso(doc.id);
    setAvisoFila((a) => {
      const { [doc.id]: _omitido, ...resto } = a;
      return resto;
    });

    try {
      const resultado = await reintentarDocumento(doc.id);
      setItems((xs) => xs.map((x) => (x.id === doc.id ? resultado.documento : x)));

      const texto = resultado.enCurso
        ? 'Sigue en proceso — pulse "Actualizar" en un momento para ver el resultado.'
        : resultado.mensaje
          ?? `${ETIQUETA_ESTADO[resultado.documento.estado] ?? resultado.documento.estado}`
            + ` — ${resultado.documento.chars ?? 0} caracteres, ${resultado.documento.chunksGenerados ?? 0} fragmento(s).`;
      setAvisoFila((a) => ({ ...a, [doc.id]: { tipo: 'ok', texto } }));
      onCambio?.();
    } catch (err: unknown) {
      setAvisoFila((a) => ({
        ...a,
        [doc.id]: { tipo: 'error', texto: err instanceof Error ? err.message : 'No se pudo reintentar' },
      }));
    } finally {
      setIdEnCurso(null);
    }
  }

  function motivoReintentarDeshabilitado(doc: DocumentoRag): string | undefined {
    if (idEnCurso !== null) return 'Espere a que termine la acción en curso.';
    if (doc.estado === 'en_proceso') return 'Este documento ya se está procesando.';
    if (circuitoAbierto) return 'El servicio de conversión no responde ahora mismo.';
    if (jobEnCurso) return 'Hay un trabajo masivo en curso; espere a que termine.';
    return undefined;
  }

  /** Mismo patrón que `reintentar`: sin recarga, la fila se actualiza en su sitio. */
  async function extraerVision(doc: DocumentoRag) {
    setIdEnCurso(doc.id);
    setAvisoFila((a) => {
      const { [doc.id]: _omitido, ...resto } = a;
      return resto;
    });

    try {
      const { documento } = await extraerConVision(doc.id);
      setItems((xs) => xs.map((x) => (x.id === doc.id ? documento : x)));
      setAvisoFila((a) => ({
        ...a,
        [doc.id]: {
          tipo: 'ok',
          texto: `Extraído con IA — ${documento.chars ?? 0} caracteres, ${documento.chunksGenerados ?? 0} fragmento(s).`,
        },
      }));
      onCambio?.();
    } catch (err: unknown) {
      setAvisoFila((a) => ({
        ...a,
        [doc.id]: { tipo: 'error', texto: err instanceof Error ? err.message : 'No se pudo extraer con IA' },
      }));
    } finally {
      setIdEnCurso(null);
    }
  }

  function motivoVisionDeshabilitado(): string | undefined {
    if (idEnCurso !== null) return 'Espere a que termine la acción en curso.';
    if (!visionDisponible) return visionMotivo ?? 'La extracción con IA no está disponible.';
    return undefined;
  }

  /**
   * Embeber un solo documento: a diferencia de `reintentar`/`extraerVision`, esto lanza un JOB
   * asíncrono (aunque acotado a un único documento) en vez de resolver en la propia respuesta HTTP
   * — el pipeline de embeddings no tiene un camino síncrono. Por eso no actualiza `items` en sitio:
   * reporta el `jobId` hacia arriba (`onJobLanzado`) para que el modal lo sondee en un único punto,
   * igual que ya hace con los tres botones globales.
   */
  async function embeberDocumento(doc: DocumentoRag) {
    setIdEnCurso(doc.id);
    setAvisoFila((a) => {
      const { [doc.id]: _omitido, ...resto } = a;
      return resto;
    });

    try {
      const { jobId } = await iniciarIngestaEmbeddings({ documentoIds: [doc.id] });
      setAvisoFila((a) => ({
        ...a,
        [doc.id]: { tipo: 'ok', texto: `Trabajo #${jobId} en curso — véalo arriba.` },
      }));
      onJobLanzado?.(jobId);
      onCambio?.();
    } catch (err: unknown) {
      setAvisoFila((a) => ({
        ...a,
        [doc.id]: {
          tipo: 'error',
          texto: err instanceof Error ? err.message : 'No se pudo iniciar la ingesta de embeddings',
        },
      }));
    } finally {
      setIdEnCurso(null);
    }
  }

  function motivoEmbeberDeshabilitado(): string | undefined {
    if (idEnCurso !== null) return 'Espere a que termine la acción en curso.';
    if (jobEnCurso) return 'Hay un trabajo masivo en curso; espere a que termine.';
    if (embeddingDisponible === false) return embeddingMotivo ?? 'La generación de embeddings no está disponible.';
    return undefined;
  }

  function alternarSeleccionTodos(marcar: boolean) {
    if (!onSeleccionCambio) return;
    const siguiente = new Set(seleccion);
    for (const doc of items) {
      if (marcar) siguiente.add(doc.id);
      else siguiente.delete(doc.id);
    }
    onSeleccionCambio(siguiente);
  }

  function alternarSeleccionUno(id: number, marcar: boolean) {
    if (!onSeleccionCambio) return;
    const siguiente = new Set(seleccion);
    if (marcar) siguiente.add(id);
    else siguiente.delete(id);
    onSeleccionCambio(siguiente);
  }

  function abrirMarkdown(doc: DocumentoRag) {
    setMarkdownAbierto({ titulo: doc.titulo ?? `${doc.nuAnn}-${doc.nuEmi}` });
    setEstadoMarkdown({ tipo: 'cargando' });
    fetchMarkdownDocumento(doc.id)
      .then((datos) => setEstadoMarkdown({ tipo: 'listo', datos }))
      .catch((err: unknown) =>
        setEstadoMarkdown({ tipo: 'error', mensaje: err instanceof Error ? err.message : 'Error desconocido' }),
      );
  }

  const totalPaginas = Math.max(1, Math.ceil(total / porPagina));

  return (
    <div className="lista-documentos-rag">
      {jobId && (
        <div className="state-message">
          Mostrando solo los documentos del trabajo #{jobId} ({total}).
          {onQuitarFiltroJob && (
            <>
              {' '}
              <button type="button" className="boton-enlace" onClick={onQuitarFiltroJob}>
                Ver todos los documentos
              </button>
            </>
          )}
        </div>
      )}

      <div className="toolbar">
        <select
          aria-label="Filtrar por estado"
          value={filtroEstado}
          onChange={(e) => setFiltroEstado(e.target.value)}
        >
          {ESTADOS_FILTRO.map((e) => (
            <option key={e.valor} value={e.valor}>
              {e.etiqueta}
            </option>
          ))}
        </select>
        <input
          type="search"
          className="search-input"
          placeholder="Buscar por título o asunto…"
          aria-label="Buscar documentos"
          value={filtroTexto}
          onChange={(e) => setFiltroTexto(e.target.value)}
        />
        <button type="button" className="boton-secundario" onClick={() => setRecarga((n) => n + 1)}>
          Actualizar
        </button>
      </div>

      {(filtroEstado === 'sin_texto' || filtroEstado === 'error') && (
        <p className="exp-nota">
          Un fallo transitorio (circuito de markitdown, tiempo agotado) devuelve el documento a
          "Pendiente" para reintentarlo solo — no queda visible aquí como error.
        </p>
      )}

      {error && (
        <div className="state-message is-error" role="alert">
          {error}
        </div>
      )}

      {cargando && <div className="state-message">Cargando documentos…</div>}

      {!cargando && !error && items.length === 0 && (
        <div className="state-message">Ningún documento coincide con el filtro.</div>
      )}

      {!cargando && !error && items.length > 0 && (
        <>
          <div className="table-card">
            <div className="table-scroll">
              <table className="tabla-expedientes">
                <thead>
                  <tr>
                    {seleccionables && (
                      <th scope="col" className="celda-casilla">
                        <input
                          type="checkbox"
                          aria-label="Seleccionar todos los documentos visibles"
                          checked={items.length > 0 && items.every((d) => seleccion?.has(d.id))}
                          onChange={(e) => alternarSeleccionTodos(e.target.checked)}
                        />
                      </th>
                    )}
                    <th scope="col">{jobId ? 'Estado en el trabajo' : 'Estado'}</th>
                    <th scope="col">Título</th>
                    <th scope="col">Expediente</th>
                    <th scope="col">Caracteres</th>
                    <th scope="col">Chunks</th>
                    <th scope="col">Método</th>
                    <th scope="col">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((doc) => {
                    // El estado del documento (persistente) manda siempre — es la clasificación real
                    // del contenido. El estado del ítem es solo "¿esta pasada del trabajo lanzó una
                    // excepción?": un fallo reintentable devuelve el documento a 'pendiente' sin dejar
                    // rastro ahí, así que se muestra aparte para no perder esa señal.
                    const destacado = doc.estado === 'sin_texto' || doc.estado === 'error'
                      || (!!jobId && doc.estadoItem === 'error');
                    return (
                      <tr key={doc.id} className={destacado ? 'fila-destacada' : undefined}>
                        {seleccionables && (
                          <td className="celda-casilla">
                            <input
                              type="checkbox"
                              aria-label={`Seleccionar ${doc.titulo ?? `${doc.nuAnn}-${doc.nuEmi}`}`}
                              checked={!!seleccion?.has(doc.id)}
                              onChange={(e) => alternarSeleccionUno(doc.id, e.target.checked)}
                            />
                          </td>
                        )}
                        <td>
                          <span className={`badge ${CLASE_ESTADO[doc.estado] ?? 'badge-neutro'}`}>
                            {ETIQUETA_ESTADO[doc.estado] ?? doc.estado}
                          </span>
                          {jobId && doc.estadoItem && doc.estadoItem !== 'ok' && (
                            <div className="exp-nota">
                              en este trabajo: {ETIQUETA_ESTADO[doc.estadoItem] ?? doc.estadoItem}
                            </div>
                          )}
                        </td>
                        <td>
                          <div className="doc-nombre">{doc.titulo ?? `${doc.nuAnn}-${doc.nuEmi}`}</div>
                          {doc.motivoError && (
                            <div className="exp-nota is-error" title={doc.motivoError}>
                              {doc.motivoError}
                            </div>
                          )}
                          {jobId && doc.motivoErrorItem && doc.motivoErrorItem !== doc.motivoError && (
                            <div className="exp-nota is-error" title={doc.motivoErrorItem}>
                              en este trabajo: {doc.motivoErrorItem}
                            </div>
                          )}
                        </td>
                        <td>{doc.numeroExpediente ?? (doc.nuAnnExp ? `${doc.nuAnnExp}-${doc.nuSecExp}` : '—')}</td>
                        <td className="celda-tiempo">{doc.chars ?? '—'}</td>
                        <td className="celda-tiempo">{doc.chunksGenerados ?? '—'}</td>
                        <td>{doc.metodo ?? '—'}</td>
                        <td>
                          <div className="lista-documentos-acciones">
                            {doc.chars !== null && (
                              <button type="button" className="boton-enlace" onClick={() => abrirMarkdown(doc)}>
                                Ver markdown
                              </button>
                            )}
                            <button type="button" className="boton-enlace" onClick={() => abrirDocumento(doc)}>
                              Ver documento
                            </button>
                            {ESTADOS_REINTENTABLES.has(doc.estado) && (
                              <button
                                type="button"
                                className="boton-enlace"
                                onClick={() => reintentar(doc)}
                                disabled={!!motivoReintentarDeshabilitado(doc)}
                                title={motivoReintentarDeshabilitado(doc)}
                                aria-busy={idEnCurso === doc.id}
                              >
                                {idEnCurso === doc.id ? 'Reintentando…' : 'Reintentar'}
                              </button>
                            )}
                            {ESTADOS_CON_VISION.has(doc.estado) && (
                              <button
                                type="button"
                                className="boton-enlace"
                                onClick={() => extraerVision(doc)}
                                disabled={!!motivoVisionDeshabilitado()}
                                title={motivoVisionDeshabilitado()}
                                aria-busy={idEnCurso === doc.id}
                              >
                                {idEnCurso === doc.id ? 'Extrayendo…' : 'Extraer con ChatGPT'}
                              </button>
                            )}
                            {/* Nombre distinto del botón global "Generar embeddings" del panel a
                                propósito: evita que ambos se confundan cuando esta lista se embebe
                                dentro de una pantalla que también ofrece la acción masiva. */}
                            {doc.estado === 'convertido' && (
                              <button
                                type="button"
                                className="boton-enlace"
                                onClick={() => embeberDocumento(doc)}
                                disabled={!!motivoEmbeberDeshabilitado()}
                                title={motivoEmbeberDeshabilitado()}
                                aria-busy={idEnCurso === doc.id}
                              >
                                {idEnCurso === doc.id ? 'Embebiendo…' : 'Embeber este documento'}
                              </button>
                            )}
                          </div>
                          {ESTADOS_CON_VISION.has(doc.estado) && (
                            <div className="exp-nota">"Extraer con ChatGPT" consume tokens de OpenAI.</div>
                          )}
                          {avisoFila[doc.id] && (
                            <div className={`exp-nota ${avisoFila[doc.id].tipo === 'error' ? 'is-error' : ''}`}>
                              {avisoFila[doc.id].texto}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="toolbar">
            <p className="result-count">
              {total} documento{total === 1 ? '' : 's'} · página {pagina} de {totalPaginas}
            </p>
            <div className="lista-documentos-paginado">
              <button
                type="button"
                className="boton-secundario"
                disabled={pagina <= 1}
                onClick={() => setPagina((p) => p - 1)}
              >
                Anterior
              </button>
              <button
                type="button"
                className="boton-secundario"
                disabled={pagina >= totalPaginas}
                onClick={() => setPagina((p) => p + 1)}
              >
                Siguiente
              </button>
            </div>
          </div>
        </>
      )}

      {documentoAbierto && (
        <VisorDocumento
          url={documentoAbierto.url}
          titulo={documentoAbierto.titulo}
          visualizable={documentoAbierto.visualizable}
          onCerrar={() => setDocumentoAbierto(null)}
        />
      )}

      {markdownAbierto && (
        <div
          className="modal-fondo"
          role="dialog"
          aria-modal="true"
          aria-label={`Markdown de ${markdownAbierto.titulo}`}
          onClick={(e) => {
            if (e.target === e.currentTarget) setMarkdownAbierto(null);
          }}
        >
          <div className="modal-caja modal-caja--estrecha">
            <header className="modal-cabecera">
              <h2>Markdown — {markdownAbierto.titulo}</h2>
              <button className="boton-cerrar" onClick={() => setMarkdownAbierto(null)} aria-label="Cerrar">
                ✕
              </button>
            </header>
            <div className="modal-cuerpo modal-cuerpo--markdown">
              {estadoMarkdown.tipo === 'cargando' && <div className="state-message">Cargando…</div>}
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
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
