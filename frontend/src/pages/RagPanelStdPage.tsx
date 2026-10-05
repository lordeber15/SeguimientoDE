import { useCallback, useEffect, useRef, useState } from 'react';
import toast, { Toaster } from 'react-hot-toast';
import {
  activarBarridoStd,
  activarGcStd,
  activarRetencionStd,
  barrerAhoraStd,
  buscarJobActivoStd,
  cancelarJobIngestaStd,
  ejecutarGcAhoraStd,
  ejecutarRetencionAhoraStd,
  extraerConVisionStd,
  fetchDocumentosStd,
  fetchJobStd,
  fetchJobsStd,
  fetchPanelStd,
  iniciarIngestaConversionStd,
  iniciarIngestaEmbeddingsStd,
  pausarJobIngestaStd,
  reanudarJobIngestaStd,
  reintentarDocumentoStd,
  reintentarTodosSinArchivoStd,
  type DocumentoRagStd,
  type FiltroIngestaStd,
  type JobIngesta,
  type PanelRagStd,
} from '../api/ragStd';
import { rutaAdjuntoStd } from '../api/std';
import { ApiError } from '../api/cliente';
import { ModalContinuarLote, type TipoCadena } from '../components/ModalContinuarLote';
import { PanelJobIngesta } from '../components/PanelJobIngesta';
import { VisorDocumento } from '../components/VisorDocumento';

/**
 * Panel de administración del STD (`std.gestionar`) — página propia y más chica que `RagPanelPage`
 * del SGD, a propósito: el motor de ingesta del STD todavía no tiene reparación masiva,
 * ni "documentos largos sueltos" (ver la cabecera de `ingestaStdService.ts`), así que no hay nada
 * que esas secciones mostrarían aquí. Sí comparte con el SGD la ingesta encadenada por lotes
 * (conversión y embeddings), el reintento masivo de los "sin archivo" y la extracción con IA de
 * visión por documento. Reutiliza `PanelJobIngesta` y `ModalContinuarLote` tal cual (la forma de un job
 * es idéntica en las dos bases — ver `api/ragStd.ts`) y `VisorDocumento` para abrir el PDF citado
 * desde la tabla de documentos.
 */

type Estado =
  | { tipo: 'cargando' }
  | { tipo: 'error'; mensaje: string }
  | { tipo: 'listo'; panel: PanelRagStd };

const ETIQUETA_ESTADO_DOC: Record<string, string> = {
  pendientes: 'Pendientes',
  convertidos: 'Convertidos (sin embeber)',
  ok: 'Completos',
  sinTexto: 'Sin texto útil',
  error: 'Con error',
  noSoportado: 'Sin archivo digital',
};

const ETIQUETA_ESTADO_FILA: Record<string, string> = {
  pendiente: 'Pendiente',
  en_proceso: 'En proceso',
  convertido: 'Convertido',
  ok: 'Completo',
  sin_texto: 'Sin texto',
  error: 'Error',
  omitido: 'Omitido',
  no_soportado: 'Sin archivo',
};

const CLASE_ESTADO_FILA: Record<string, string> = {
  pendiente: 'badge-pendiente',
  en_proceso: 'badge-progreso',
  convertido: 'badge-progreso',
  ok: 'badge-atendido',
  sin_texto: 'badge-anulado',
  error: 'badge-anulado',
  omitido: 'badge-neutro',
  no_soportado: 'badge-neutro',
};

const ESTADOS_FILTRO = [
  { valor: '', etiqueta: 'Todos los estados' },
  { valor: 'sin_texto', etiqueta: 'Sin texto' },
  { valor: 'error', etiqueta: 'Con error' },
  { valor: 'no_soportado', etiqueta: 'Sin archivo digital' },
  { valor: 'pendiente', etiqueta: 'Pendiente' },
  { valor: 'convertido', etiqueta: 'Convertido' },
  { valor: 'ok', etiqueta: 'Completo' },
] as const;

const ESTADOS_REINTENTABLES = new Set(['no_soportado', 'sin_texto', 'error', 'pendiente']);

/** Donde se ofrece la extracción con IA. Incluye "sin archivo": en el STD esa etiqueta a veces la
 *  puso un fallo de lectura y el archivo sí existe — si de verdad no está, el backend lo rechaza. */
const ESTADOS_CON_VISION = new Set(['sin_texto', 'error', 'no_soportado']);

function papelConversor(
  conversion: PanelRagStd['proveedores']['conversion'],
  proveedor: 'markitdown' | 'mineru',
): string {
  if (conversion.proveedorActivo === proveedor) return ' (activo)';
  if (conversion.proveedorRespaldo === proveedor) return ' (respaldo)';
  return '';
}

const INTERVALO_POLL_MS = 1500;

/** Cuenta atrás del diálogo entre lotes: sin respuesta, la cadena sigue sola. */
const SEGUNDOS_CONFIRMACION = 30;

/**
 * Vocabulario y arranque de cada tipo de job que se puede encadenar por lotes — mismo mecanismo
 * que `RagPanelPage` del SGD. `limite` es el tope por job que ya aplica el backend.
 */
const CONFIG_CADENA: Record<TipoCadena, {
  limite: number;
  unidad: string;
  unidadPlural: string;
  verbo: string;
  nombre: string;
  etiquetaTerminada: string;
  etiquetaDetenida: string;
  mensajeSinPendientes: string;
  mensajeError: string;
  iniciar: (filtro: FiltroIngestaStd) => Promise<{ jobId: number }>;
}> = {
  conversion: {
    limite: 500,
    unidad: 'documento(s)',
    unidadPlural: 'documentos',
    verbo: 'convertido(s)',
    nombre: 'conversión',
    etiquetaTerminada: 'Conversión terminada',
    etiquetaDetenida: 'Conversión detenida',
    mensajeSinPendientes: 'No hay documentos del STD pendientes por convertir.',
    mensajeError: 'No se pudo iniciar la conversión',
    iniciar: iniciarIngestaConversionStd,
  },
  embedding: {
    limite: 2000,
    unidad: 'fragmento(s)',
    unidadPlural: 'fragmentos',
    verbo: 'embebido(s)',
    nombre: 'embeddings',
    etiquetaTerminada: 'Ingesta de embeddings terminada',
    etiquetaDetenida: 'Ingesta de embeddings detenida',
    mensajeSinPendientes: 'No hay fragmentos del STD pendientes de embeber.',
    mensajeError: 'No se pudo iniciar la ingesta de embeddings',
    iniciar: iniciarIngestaEmbeddingsStd,
  },
};

/** Una tanda encadenada: `lote` es el que corre ahora; `procesados`/`errores` acumulan los ya cerrados. */
interface Cadena {
  tipo: TipoCadena;
  lote: number;
  procesados: number;
  errores: number;
}

/**
 * La cadena vive en `sessionStorage` para sobrevivir al desmontaje al cambiar de pestaña. Clave
 * PROPIA, distinta de la del SGD: cada base tiene su propio semáforo de jobs, así que las dos
 * cadenas pueden estar vivas a la vez y no deben pisarse.
 */
const CLAVE_CADENA = 'rag.std.cadena';

function leerCadenaGuardada(): Cadena | null {
  try {
    const crudo = sessionStorage.getItem(CLAVE_CADENA);
    if (!crudo) return null;
    const cadena = JSON.parse(crudo) as Partial<Cadena>;
    if (typeof cadena?.lote !== 'number') return null;
    return {
      lote: cadena.lote,
      procesados: cadena.procesados ?? 0,
      errores: cadena.errores ?? 0,
      tipo: cadena.tipo === 'embedding' ? 'embedding' : 'conversion',
    };
  } catch {
    return null;
  }
}

interface DocumentoAbierto {
  url: string;
  titulo: string;
}

export function RagPanelStdPage() {
  const [estado, setEstado] = useState<Estado>({ tipo: 'cargando' });
  const [jobActivo, setJobActivo] = useState<JobIngesta | null>(null);
  const [reintentoPoll, setReintentoPoll] = useState(0);
  const [barriendo, setBarriendo] = useState(false);
  const [purgando, setPurgando] = useState(false);
  const [recolectando, setRecolectando] = useState(false);
  /** Casillas de cada botón: encadenar lotes o hacer uno solo. */
  const [encadenar, setEncadenar] = useState(true);
  const [encadenarEmbeddings, setEncadenarEmbeddings] = useState(true);
  const [cadena, setCadena] = useState<Cadena | null>(null);
  const [confirmacion, setConfirmacion] = useState<
    { job: JobIngesta; segundos: number | null } | null
  >(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [filtroEstado, setFiltroEstado] = useState('sin_texto');
  const [filtroTexto, setFiltroTexto] = useState('');
  const [jobIdFiltro, setJobIdFiltro] = useState<number | null>(null);
  const [documentos, setDocumentos] = useState<DocumentoRagStd[] | null>(null);
  const [totalDocumentos, setTotalDocumentos] = useState(0);
  const [cargandoDocs, setCargandoDocs] = useState(false);
  const [accionFila, setAccionFila] = useState<number | null>(null);
  const [documentoAbierto, setDocumentoAbierto] = useState<DocumentoAbierto | null>(null);

  const cargar = useCallback(() => {
    fetchPanelStd()
      .then((panel) => setEstado({ tipo: 'listo', panel }))
      .catch((error: unknown) =>
        setEstado({ tipo: 'error', mensaje: error instanceof Error ? error.message : 'Error desconocido' }),
      );
  }, []);

  useEffect(() => cargar(), [cargar]);

  const cargarDocumentos = useCallback(() => {
    setCargandoDocs(true);
    fetchDocumentosStd({
      estado: filtroEstado || undefined,
      q: filtroTexto || undefined,
      jobId: jobIdFiltro ?? undefined,
    })
      .then((r) => {
        setDocumentos(r.items);
        setTotalDocumentos(r.total);
      })
      .catch(() => {
        setDocumentos([]);
        setTotalDocumentos(0);
      })
      .finally(() => setCargandoDocs(false));
  }, [filtroEstado, filtroTexto, jobIdFiltro]);

  useEffect(() => cargarDocumentos(), [cargarDocumentos]);

  /** Única puerta de escritura de la cadena: el estado y su copia persistida nunca divergen. */
  const aplicarCadena = useCallback((siguiente: Cadena | null) => {
    setCadena(siguiente);
    try {
      if (siguiente) sessionStorage.setItem(CLAVE_CADENA, JSON.stringify(siguiente));
      else sessionStorage.removeItem(CLAVE_CADENA);
    } catch {
      // Sin almacenamiento la cadena dura lo que dure la pantalla; no es motivo para fallar.
    }
  }, []);

  // Re-enganche al job que siguió corriendo mientras esta pantalla no existía — mismo motivo que
  // `RagPanelPage` del SGD: `App.tsx` desmonta este componente al navegar a otra pestaña.
  useEffect(() => {
    let vigente = true;
    const guardada = leerCadenaGuardada();

    buscarJobActivoStd()
      .then(async (job) => {
        if (!vigente) return;
        if (job) {
          setJobActivo(job);
          setJobIdFiltro(job.id);
          if (guardada) aplicarCadena(guardada);
          return;
        }

        // Sin job vivo pero con cadena guardada: el lote terminó mientras esta pantalla no
        // existía. Se pregunta ahora, sin cuenta atrás — nadie ha visto el resultado del lote.
        if (!guardada) return;
        const [ultimo] = await fetchJobsStd();
        if (!vigente) return;
        if (ultimo?.tipo === guardada.tipo && ultimo.estado === 'completado') {
          aplicarCadena({
            tipo: guardada.tipo,
            lote: guardada.lote,
            procesados: guardada.procesados + ultimo.procesados,
            errores: guardada.errores + ultimo.errores,
          });
          setJobIdFiltro(ultimo.id);
          setConfirmacion({ job: ultimo, segundos: null });
        } else {
          aplicarCadena(null);
        }
      })
      .catch(() => {});
    return () => {
      vigente = false;
    };
  }, [aplicarCadena]);

  useEffect(() => {
    if (!jobActivo || (jobActivo.estado !== 'en_curso' && !jobActivo.procesoActual)) return;
    pollRef.current = setTimeout(async () => {
      try {
        const job = await fetchJobStd(jobActivo.id);
        const yaNoEstaEnCurso = job.estado !== 'en_curso' && jobActivo.estado === 'en_curso';
        const documentoEnVueloTermino = !job.procesoActual && !!jobActivo.procesoActual;
        setJobActivo(job);
        if (yaNoEstaEnCurso || documentoEnVueloTermino) {
          cargar();
          cargarDocumentos();
        }

        // Fin de lote de una tanda encadenada — misma lógica que el SGD: solo `completado` abre la
        // pregunta, y un lote que no procesó nada exige decisión explícita (sin cuenta atrás).
        if (cadena && yaNoEstaEnCurso && job.estado === 'completado') {
          aplicarCadena({
            tipo: cadena.tipo,
            lote: cadena.lote,
            procesados: cadena.procesados + job.procesados,
            errores: cadena.errores + job.errores,
          });
          setConfirmacion({ job, segundos: job.procesados > 0 ? SEGUNDOS_CONFIRMACION : null });
        } else if (cadena && yaNoEstaEnCurso && (job.estado === 'cancelado' || job.estado === 'error')) {
          aplicarCadena(null);
          if (job.estado === 'error') {
            toast.error(
              `El job de ${CONFIG_CADENA[cadena.tipo].nombre} terminó con error`
              + (job.mensaje ? `: ${job.mensaje}` : '.'),
            );
          }
        }
      } catch {
        setReintentoPoll((n) => n + 1);
      }
    }, INTERVALO_POLL_MS);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [jobActivo, reintentoPoll, cargar, cargarDocumentos, cadena, aplicarCadena]);

  async function alternarBarrido(activo: boolean) {
    try {
      await activarBarridoStd(activo);
      toast.success(activo ? 'Barrido activado.' : 'Barrido desactivado.');
      cargar();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo cambiar');
    }
  }

  async function barrer() {
    setBarriendo(true);
    const id = toast.loading('Barrido en curso… puede tardar unos minutos.');
    try {
      const r = await barrerAhoraStd();
      toast.success(`Barrido completado: ${r.documentosNuevos} nuevo(s), ${r.documentosCambiados} cambiado(s).`, { id });
      cargar();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo barrer', { id });
    } finally {
      setBarriendo(false);
    }
  }

  async function alternarRetencion(activo: boolean) {
    try {
      await activarRetencionStd(activo);
      toast.success(activo ? 'Retención activada.' : 'Retención desactivada.');
      cargar();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo cambiar');
    }
  }

  async function correrRetencion() {
    setPurgando(true);
    const id = toast.loading('Purgando registros antiguos…');
    try {
      const r = await ejecutarRetencionAhoraStd();
      toast.success(
        `Retención ejecutada: ${r.usoToken} uso(s) de token, ${r.retrievalLog} consulta(s) de log purgadas.`,
        { id },
      );
      cargar();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo ejecutar la retención', { id });
    } finally {
      setPurgando(false);
    }
  }

  async function alternarGC(activo: boolean) {
    try {
      await activarGcStd(activo);
      toast.success(activo ? 'Recolector de basura activado.' : 'Recolector de basura desactivado.');
      cargar();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo cambiar');
    }
  }

  async function correrGC() {
    setRecolectando(true);
    const id = toast.loading('Recolectando huérfanos…');
    try {
      const r = await ejecutarGcAhoraStd();
      toast.success(
        `Recolector ejecutado: ${r.marcados} contenido(s) marcado(s) huérfano(s), ${r.recolectados} recolectado(s) (${r.chunksBorrados} chunks borrados; el markdown se conserva siempre).`,
        { id },
      );
      cargar();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo ejecutar el recolector', { id });
    } finally {
      setRecolectando(false);
    }
  }

  /**
   * Lanza un lote de `tipo`. Devuelve `false` cuando ya no quedaba nada que procesar (404 del
   * backend), la señal natural de fin de una cadena.
   */
  const lanzarLote = useCallback(async (tipo: TipoCadena): Promise<boolean> => {
    const config = CONFIG_CADENA[tipo];
    try {
      const { jobId } = await config.iniciar({ limite: config.limite });
      setJobActivo(await fetchJobStd(jobId));
      setJobIdFiltro(jobId);
      return true;
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 404) return false;
      toast.error(error instanceof Error ? error.message : config.mensajeError);
      throw error;
    }
  }, []);

  /** Arranque común de conversión y embeddings. La cadena se abre ANTES de lanzar: un lote muy
   *  corto podría completarse antes de que el estado se actualizara y perderse la pregunta. */
  async function iniciarTanda(tipo: TipoCadena, conCadena: boolean) {
    aplicarCadena(conCadena ? { tipo, lote: 1, procesados: 0, errores: 0 } : null);
    setConfirmacion(null);
    try {
      if (!(await lanzarLote(tipo))) {
        aplicarCadena(null);
        toast.success(CONFIG_CADENA[tipo].mensajeSinPendientes);
      }
    } catch {
      aplicarCadena(null); // `lanzarLote` ya avisó del error
    }
  }

  const convertir = () => iniciarTanda('conversion', encadenar);
  const embeber = () => iniciarTanda('embedding', encadenarEmbeddings);

  /** Siguiente lote de la tanda: lo llama el botón del diálogo y también su cuenta atrás. */
  const continuarCadena = useCallback(async () => {
    const enCurso = cadena;
    setConfirmacion(null);
    if (!enCurso) return;
    const config = CONFIG_CADENA[enCurso.tipo];

    try {
      if (await lanzarLote(enCurso.tipo)) {
        aplicarCadena({ ...enCurso, lote: enCurso.lote + 1 });
        return;
      }
      toast.success(
        `${config.etiquetaTerminada}: ${enCurso.procesados} ${config.unidad} en ${enCurso.lote} lote(s). `
        + `No quedan ${config.unidadPlural} pendientes.`,
      );
    } catch {
      // `lanzarLote` ya avisó; la cadena se cierra para no dejarla colgando sin job que sondear.
    }
    aplicarCadena(null);
  }, [cadena, lanzarLote, aplicarCadena]);

  const detenerCadena = useCallback(() => {
    const enCurso = cadena;
    setConfirmacion(null);
    aplicarCadena(null);
    if (enCurso) {
      const config = CONFIG_CADENA[enCurso.tipo];
      toast.success(
        `${config.etiquetaDetenida} tras ${enCurso.lote} lote(s): ${enCurso.procesados} ${config.unidad} ${config.verbo}.`,
      );
    }
  }, [cadena, aplicarCadena]);

  async function reintentarSinArchivo() {
    const total = estado.tipo === 'listo' ? estado.panel.corpus.documentos.noSoportado : 0;
    if (!window.confirm(
      `Se volverán a intentar los ${total} documento(s) "sin archivo", incluidos los que ya agotaron `
        + 'sus intentos. Asegúrese de que el repositorio de archivos del STD (uploads/) esté montado. ¿Continuar?',
    )) return;
    try {
      const { jobId, total: encolados } = await reintentarTodosSinArchivoStd();
      toast.success(`${encolados} documento(s) "sin archivo" en cola de reintento.`);
      setJobActivo(await fetchJobStd(jobId));
      setJobIdFiltro(jobId);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudieron reintentar los documentos sin archivo');
    }
  }

  async function pausar() {
    if (!jobActivo) return;
    try {
      setJobActivo(await pausarJobIngestaStd(jobActivo.id));
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo pausar el trabajo');
    }
  }

  async function reanudar() {
    if (!jobActivo) return;
    try {
      setJobActivo(await reanudarJobIngestaStd(jobActivo.id));
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo reanudar el trabajo');
    }
  }

  async function detener() {
    if (!jobActivo) return;
    try {
      setJobActivo(await cancelarJobIngestaStd(jobActivo.id));
      // Parar a mano es parar la tanda entera; pausar, en cambio, no la corta.
      aplicarCadena(null);
      setConfirmacion(null);
      cargar();
      cargarDocumentos();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo detener el trabajo');
    }
  }

  async function reintentarFila(doc: DocumentoRagStd) {
    setAccionFila(doc.id);
    try {
      const r = await reintentarDocumentoStd(doc.id);
      if (r.enCurso) {
        toast('Sigue convirtiéndose en segundo plano — actualice en unos segundos.');
      } else if (r.mensaje) {
        toast(r.mensaje);
      } else {
        toast.success(`Documento actualizado: ${ETIQUETA_ESTADO_FILA[r.documento.estado] ?? r.documento.estado}.`);
      }
      cargarDocumentos();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo reintentar el documento');
    } finally {
      setAccionFila(null);
    }
  }

  async function extraerVision(doc: DocumentoRagStd) {
    setAccionFila(doc.id);
    const id = toast.loading('Extrayendo el texto con IA… puede tardar un minuto.');
    try {
      const { documento } = await extraerConVisionStd(doc.id);
      toast.success(
        documento.estado === 'sin_texto'
          ? 'La IA tampoco encontró texto legible en este documento.'
          : `Texto extraído con IA: ${documento.chunksGenerados ?? 0} fragmento(s).`,
        { id },
      );
      cargarDocumentos();
      cargar();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo extraer el texto con IA', { id });
    } finally {
      setAccionFila(null);
    }
  }

  function abrirArchivo(doc: DocumentoRagStd) {
    const titulo = [`STD ${doc.nroStd ?? doc.idDocumento}`, doc.tipoDoc, doc.documento]
      .filter(Boolean)
      .join(' · ');
    setDocumentoAbierto({ url: rutaAdjuntoStd(doc.idAdjunto), titulo });
  }

  if (estado.tipo === 'cargando') {
    return (
      <main className="app-main">
        <div className="state-message" role="status">Cargando el estado de la base de conocimientos del STD…</div>
      </main>
    );
  }

  if (estado.tipo === 'error') {
    return (
      <main className="app-main">
        <div className="state-message is-error" role="alert">
          <p>No se pudo cargar el panel.</p>
          <p>{estado.mensaje}</p>
          <button className="retry-button" onClick={cargar}>Reintentar</button>
        </div>
      </main>
    );
  }

  const { panel } = estado;
  const { documentos: docsResumen } = panel.corpus;

  return (
    <main className="app-main app-main--ancho">
      <Toaster position="top-right" />

      <div className="rag-grid">
        {/* Barrido de detección */}
        <section className="rag-tarjeta">
          <h2>Barrido de detección</h2>
          <label className="checkbox-linea">
            <input
              type="checkbox"
              checked={panel.barrido.activo}
              onChange={(e) => alternarBarrido(e.target.checked)}
            />
            <span>
              Automático
              <span className="exp-nota">
                Detecta documentos del STD nuevos o cambiados. Nunca ingesta por su cuenta: solo
                actualiza el estado. Cadencia de {panel.barrido.cadenciaMin} min — el STD casi no
                cambia, a diferencia del SGD.
              </span>
            </span>
          </label>

          <p className={panel.barrido.horasDesdeUltimo === null || panel.barrido.horasDesdeUltimo > 48 ? 'exp-nota is-error' : 'exp-nota'}>
            {panel.barrido.ultimo
              ? `Último barrido: ${new Date(panel.barrido.ultimo.feInicio).toLocaleString('es-PE')} `
                + `(${panel.barrido.ultimo.disparo}) — ${panel.barrido.ultimo.documentosNuevos} nuevo(s)`
              : 'Todavía no se ha ejecutado ningún barrido: las cifras de abajo pueden no reflejar el STD actual.'}
          </p>

          <button className="boton-secundario" onClick={barrer} disabled={barriendo} aria-busy={barriendo}>
            {barriendo && <span className="boton-spinner" aria-hidden="true" />}
            {barriendo ? 'Barriendo…' : 'Barrer ahora'}
          </button>
        </section>

        {/* Proveedores de IA */}
        <section className="rag-tarjeta">
          <h2>Proveedores de IA</h2>
          <dl className="rag-datos">
            <dt>Embeddings</dt>
            <dd>
              <span className={`badge ${panel.proveedores.embedding.disponible ? 'badge-atendido' : 'badge-pendiente'}`}>
                {panel.proveedores.embedding.proveedor}
              </span>
              {!panel.proveedores.embedding.disponible && (
                <span className="exp-nota">{panel.proveedores.embedding.motivo}</span>
              )}
            </dd>
            <dt>Chat</dt>
            <dd><span className="badge badge-pendiente">{panel.proveedores.chat.proveedor}</span></dd>
            <dt>Extracción con IA</dt>
            <dd>
              <span className={`badge ${panel.proveedores.vision.disponible ? 'badge-atendido' : 'badge-pendiente'}`}>
                {panel.proveedores.vision.disponible ? 'disponible' : 'no disponible'}
              </span>
              {!panel.proveedores.vision.disponible && (
                <span className="exp-nota">{panel.proveedores.vision.motivo}</span>
              )}
            </dd>
            <dt>markitdown{papelConversor(panel.proveedores.conversion, 'markitdown')}</dt>
            <dd>
              <span className={`badge ${panel.proveedores.markitdown.disponible ? 'badge-atendido' : 'badge-pendiente'}`}>
                {panel.proveedores.markitdown.disponible ? 'disponible' : 'no responde'}
              </span>
            </dd>
            <dt>mineru{papelConversor(panel.proveedores.conversion, 'mineru')}</dt>
            <dd>
              <span className={`badge ${panel.proveedores.mineru.disponible ? 'badge-atendido' : 'badge-pendiente'}`}>
                {panel.proveedores.mineru.disponible ? 'disponible' : 'no responde'}
              </span>
            </dd>
          </dl>
          <p className="exp-nota">
            markitdown y MinerU son infraestructura compartida con el SGD: el mismo proceso del
            backend, no hay una instancia aparte por sistema.
          </p>
          {panel.proveedores.problemas.length > 0 && (
            <ul className="rag-problemas">
              {panel.proveedores.problemas.map((p) => (
                <li key={p.variable}><strong>{p.variable}</strong>: {p.mensaje}</li>
              ))}
            </ul>
          )}
        </section>

        {/* Cobertura del corpus */}
        <section className="rag-tarjeta rag-tarjeta--ancha">
          <h2>Cobertura del corpus</h2>
          <div className="rag-barras">
            <div className="rag-barra-item">
              <span>Conversión — {panel.corpus.cobertura.conversionPct}%</span>
              <div className="barra-progreso"><div className="barra-progreso-relleno" style={{ width: `${panel.corpus.cobertura.conversionPct}%` }} /></div>
            </div>
            <div className="rag-barra-item">
              <span>Embeddings — {panel.corpus.cobertura.embeddingPct}%</span>
              <div className="barra-progreso"><div className="barra-progreso-relleno" style={{ width: `${panel.corpus.cobertura.embeddingPct}%` }} /></div>
            </div>
          </div>

          <div className="table-card">
            <table className="tabla-expedientes">
              <thead>
                <tr><th scope="col">Estado</th><th scope="col">Documentos</th></tr>
              </thead>
              <tbody>
                {(['ok', 'convertidos', 'pendientes', 'sinTexto', 'error', 'noSoportado'] as const).map((clave) => (
                  <tr key={clave}>
                    <td>{ETIQUETA_ESTADO_DOC[clave]}</td>
                    <td>{docsResumen[clave]}</td>
                  </tr>
                ))}
                <tr><td><strong>Total</strong></td><td><strong>{docsResumen.total}</strong></td></tr>
              </tbody>
            </table>
          </div>
          <p className="exp-nota">
            {panel.corpus.contenido.unicos} contenido(s) único(s) · {panel.corpus.contenido.chunks} fragmento(s)
            · {panel.corpus.documentosStd.completos} de {panel.corpus.documentosStd.total} N° STD completos
          </p>
        </section>

        {/* Acciones de ingesta */}
        <section className="rag-tarjeta rag-tarjeta--ancha">
          <h2>Ingesta</h2>
          <div className="rag-acciones">
            <div>
              <button className="boton-primario" onClick={convertir} disabled={!!jobActivo && jobActivo.estado === 'en_curso'}>
                Convertir documentos pendientes
              </button>
              <p className="exp-nota">
                Descarga del repositorio del STD, convierte a texto y trocea. Usa{' '}
                {panel.proveedores.conversion.proveedorActivo}
                {panel.proveedores.conversion.proveedorRespaldo
                  && `, y reintenta con ${panel.proveedores.conversion.proveedorRespaldo} los documentos que fallen`}.
              </p>
              <label className="checkbox-linea">
                <input
                  type="checkbox"
                  aria-label="Continuar por lotes (conversión)"
                  checked={encadenar}
                  onChange={(e) => setEncadenar(e.target.checked)}
                  disabled={!!cadena || (!!jobActivo && jobActivo.estado === 'en_curso')}
                />
                <span>
                  Continuar por lotes
                  <span className="exp-nota">
                    Cada lote toma {CONFIG_CADENA.conversion.limite} documento(s). Al terminar cada
                    uno se pregunta si seguir con el siguiente; sin respuesta en{' '}
                    {SEGUNDOS_CONFIRMACION} s, continúa solo. Sin marcar, se hace un único lote.
                  </span>
                </span>
              </label>
            </div>
            <div>
              <button
                className="boton-primario"
                onClick={embeber}
                disabled={(!!jobActivo && jobActivo.estado === 'en_curso') || !panel.proveedores.embedding.disponible}
                title={panel.proveedores.embedding.disponible ? undefined : panel.proveedores.embedding.motivo ?? undefined}
              >
                Generar embeddings
              </button>
              <p className="exp-nota">
                {panel.proveedores.embedding.disponible
                  ? 'Convierte los fragmentos ya troceados en vectores de búsqueda.'
                  : `Bloqueado: ${panel.proveedores.embedding.motivo}`}
              </p>
              <label className="checkbox-linea">
                <input
                  type="checkbox"
                  aria-label="Continuar por lotes (embeddings)"
                  checked={encadenarEmbeddings}
                  onChange={(e) => setEncadenarEmbeddings(e.target.checked)}
                  disabled={!!cadena || (!!jobActivo && jobActivo.estado === 'en_curso')}
                />
                <span>
                  Continuar por lotes
                  <span className="exp-nota">
                    Cada lote toma {CONFIG_CADENA.embedding.limite} fragmento(s). Al terminar cada
                    uno se pregunta si seguir con el siguiente; sin respuesta en{' '}
                    {SEGUNDOS_CONFIRMACION} s, continúa solo. Sin marcar, se hace un único lote.
                  </span>
                </span>
              </label>
            </div>
            <div>
              <button
                className="boton-secundario"
                onClick={reintentarSinArchivo}
                disabled={(!!jobActivo && jobActivo.estado === 'en_curso') || docsResumen.noSoportado === 0}
              >
                Reintentar todos los sin archivo
              </button>
              <p className="exp-nota">
                Vuelve a buscar el archivo de los {docsResumen.noSoportado} documento(s) "sin
                archivo", incluidos los que ya agotaron sus intentos (por ejemplo, porque se
                marcaron con <code>uploads/</code> del STD desmontado). Se rechaza si el repositorio
                sigue sin montar.
              </p>
            </div>
          </div>

          {jobActivo && (
            <PanelJobIngesta
              job={jobActivo}
              onPausar={pausar}
              onReanudar={reanudar}
              onDetener={detener}
              onVerDocumentos={() => setJobIdFiltro(jobActivo.id)}
            />
          )}

          {confirmacion && cadena && (
            <ModalContinuarLote
              tipo={cadena.tipo}
              lote={cadena.lote}
              job={confirmacion.job}
              acumulado={cadena}
              pendientes={
                cadena.tipo === 'conversion' ? docsResumen.pendientes : panel.corpus.embeddings.chunksSinEmbedding
              }
              segundos={confirmacion.segundos}
              onContinuar={continuarCadena}
              onDetener={detenerCadena}
            />
          )}
        </section>

        {/* Documentos individuales */}
        <section className="rag-tarjeta rag-tarjeta--ancha">
          <h2>Documentos</h2>
          <p className="exp-nota">
            Revise documento por documento cuáles quedaron vacíos o con error para abrirlos
            manualmente.
          </p>

          <div className="toolbar">
            <select
              aria-label="Filtrar por estado"
              value={filtroEstado}
              onChange={(e) => setFiltroEstado(e.target.value)}
            >
              {ESTADOS_FILTRO.map((o) => <option key={o.valor} value={o.valor}>{o.etiqueta}</option>)}
            </select>
            <input
              type="search"
              className="search-input"
              placeholder="Buscar por N° STD o asunto…"
              aria-label="Buscar documentos del STD"
              value={filtroTexto}
              onChange={(e) => setFiltroTexto(e.target.value)}
            />
            {jobIdFiltro && (
              <button type="button" className="boton-enlace" onClick={() => setJobIdFiltro(null)}>
                Quitar filtro del trabajo #{jobIdFiltro}
              </button>
            )}
          </div>

          {cargandoDocs && <div className="state-message" role="status">Cargando documentos…</div>}

          {!cargandoDocs && documentos !== null && (
            <div className="table-card">
              <div className="table-scroll">
                <table className="tabla-expedientes">
                  <thead>
                    <tr>
                      <th scope="col">N° STD</th>
                      <th scope="col">Origen</th>
                      <th scope="col">Tipo / documento</th>
                      <th scope="col">Asunto</th>
                      <th scope="col">Estado</th>
                      <th scope="col">Fragmentos</th>
                      <th scope="col">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {documentos.length === 0 && (
                      <tr><td colSpan={7}>No hay documentos con este filtro.</td></tr>
                    )}
                    {documentos.map((d) => (
                      <tr key={d.id}>
                        <td>{d.nroStd ?? d.idDocumento}</td>
                        <td>{d.origen}</td>
                        <td>{[d.tipoDoc, d.documento].filter(Boolean).join(' ') || '—'}</td>
                        <td title={d.asunto ?? undefined}>{d.asunto ?? '—'}</td>
                        <td>
                          <span className={`badge ${CLASE_ESTADO_FILA[d.estado] ?? 'badge-neutro'}`}>
                            {ETIQUETA_ESTADO_FILA[d.estado] ?? d.estado}
                          </span>
                          {d.motivoError && <div className="exp-nota is-error" title={d.motivoError}>{d.motivoError}</div>}
                        </td>
                        <td className="celda-tiempo">{d.chunksGenerados ?? '—'}</td>
                        <td>
                          <div className="lista-documentos-acciones">
                            <button type="button" className="boton-enlace" onClick={() => abrirArchivo(d)}>
                              Ver archivo
                            </button>
                            {ESTADOS_REINTENTABLES.has(d.estado) && (
                              <button
                                type="button"
                                className="boton-enlace"
                                disabled={accionFila === d.id}
                                aria-busy={accionFila === d.id}
                                onClick={() => reintentarFila(d)}
                              >
                                {accionFila === d.id ? 'Reintentando…' : 'Reintentar'}
                              </button>
                            )}
                            {ESTADOS_CON_VISION.has(d.estado) && (
                              <button
                                type="button"
                                className="boton-enlace"
                                disabled={accionFila !== null || !panel.proveedores.vision.disponible}
                                title={
                                  panel.proveedores.vision.disponible
                                    ? 'Último recurso: transcribe el archivo con IA de visión (consume tokens).'
                                    : panel.proveedores.vision.motivo ?? 'La extracción con IA no está disponible.'
                                }
                                aria-busy={accionFila === d.id}
                                onClick={() => extraerVision(d)}
                              >
                                Extraer con ChatGPT
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="exp-nota">{totalDocumentos} documento(s) en total con este filtro.</p>
        </section>

        {/* Tokens consumidos */}
        <section className="rag-tarjeta">
          <h2>Tokens consumidos</h2>
          <p>Hoy: <strong>{panel.tokens.hoy.reduce((n, t) => n + t.tokensIn + t.tokensOut, 0).toLocaleString('es-PE')}</strong></p>
          <p>Acumulado: <strong>{(panel.tokens.acumulado.tokensIn + panel.tokens.acumulado.tokensOut).toLocaleString('es-PE')}</strong></p>
          {panel.tokens.acumulado.costeUsd > 0 && <p>Coste estimado: ${panel.tokens.acumulado.costeUsd.toFixed(2)}</p>}
        </section>

        {/* Mantenimiento: retención de logs y recolector de basura */}
        <section className="rag-tarjeta rag-tarjeta--ancha">
          <h2>Mantenimiento</h2>
          <div className="rag-acciones">
            <div>
              <label className="checkbox-linea">
                <input
                  type="checkbox"
                  checked={panel.mantenimiento.retencion.activa}
                  onChange={(e) => alternarRetencion(e.target.checked)}
                />
                <span>
                  Retención de logs
                  <span className="exp-nota">
                    Purga consumo de tokens y consultas de chat del STD de más de{' '}
                    {panel.mantenimiento.retencion.dias} días. Nunca contenido ingerido — arranca
                    ACTIVADA.
                  </span>
                </span>
              </label>
              <p className="exp-nota">
                {panel.mantenimiento.retencion.ultimo
                  ? `Última ejecución: ${new Date(panel.mantenimiento.retencion.ultimo.feInicio).toLocaleString('es-PE')} — ${panel.mantenimiento.retencion.ultimo.filasAfectadas} fila(s) purgada(s)`
                  : 'Todavía no se ha ejecutado.'}
              </p>
              <button className="boton-secundario" onClick={correrRetencion} disabled={purgando} aria-busy={purgando}>
                {purgando && <span className="boton-spinner" aria-hidden="true" />}
                {purgando ? 'Purgando…' : 'Purgar ahora'}
              </button>
            </div>

            <div>
              <label className="checkbox-linea">
                <input
                  type="checkbox"
                  checked={panel.mantenimiento.gc.activo}
                  onChange={(e) => alternarGC(e.target.checked)}
                />
                <span>
                  Recolector de basura
                  <span className="exp-nota">
                    Borra chunks y embeddings de contenidos que ningún documento vivo referencia ya,
                    con {panel.mantenimiento.gc.graciaDias} días de margen. Nunca borra el markdown.
                    Arranca DESACTIVADO.
                  </span>
                </span>
              </label>
              <p className="exp-nota">
                {panel.mantenimiento.gc.huerfanosPendientes} contenido(s) huérfano(s) hoy
                {panel.mantenimiento.gc.ultimo
                  ? ` · última recolección: ${new Date(panel.mantenimiento.gc.ultimo.feInicio).toLocaleString('es-PE')} (${panel.mantenimiento.gc.ultimo.filasAfectadas} recolectado(s))`
                  : ' · todavía no se ha ejecutado'}
              </p>
              <button className="boton-secundario" onClick={correrGC} disabled={recolectando} aria-busy={recolectando}>
                {recolectando && <span className="boton-spinner" aria-hidden="true" />}
                {recolectando ? 'Recolectando…' : 'Recolectar ahora'}
              </button>
            </div>
          </div>
        </section>

        {/* Evaluación del retrieval */}
        <section className="rag-tarjeta">
          <h2>Evaluación del retrieval ({panel.evaluacion.ventanaDias} días)</h2>
          <dl className="rag-datos">
            <dt>Consultas</dt>
            <dd>{panel.evaluacion.totalConsultas}</dd>
            <dt>Sin resultados</dt>
            <dd>{panel.evaluacion.sinResultados}</dd>
            <dt>Con citas inventadas</dt>
            <dd>{panel.evaluacion.conAlucinaciones}</dd>
            <dt>% escaneo exacto</dt>
            <dd>{panel.evaluacion.escaneoExactoPct}%</dd>
            <dt>ms promedio</dt>
            <dd>{panel.evaluacion.msPromedio}</dd>
          </dl>
        </section>
      </div>

      {documentoAbierto && (
        <VisorDocumento
          url={documentoAbierto.url}
          titulo={documentoAbierto.titulo}
          visualizable
          onCerrar={() => setDocumentoAbierto(null)}
        />
      )}
    </main>
  );
}
