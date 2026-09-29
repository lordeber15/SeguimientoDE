import { useCallback, useEffect, useRef, useState } from 'react';
import toast, { Toaster } from 'react-hot-toast';
import { ListaDocumentosRag } from '../components/ListaDocumentosRag';
import { ModalContinuarLote, type TipoCadena } from '../components/ModalContinuarLote';
import { PanelJobIngesta } from '../components/PanelJobIngesta';
import { ApiError } from '../api/cliente';
import {
  activarBarrido,
  activarGC,
  activarRetencion,
  barrerAhora,
  buscarJobActivo,
  cancelarJobIngesta,
  ejecutarGcAhora,
  ejecutarRetencionAhora,
  fetchJob,
  fetchJobs,
  fetchPanel,
  type FiltroIngesta,
  iniciarIngestaConversion,
  iniciarIngestaEmbeddings,
  iniciarIngestaLargos,
  iniciarIngestaReparacion,
  reintentarTodosSinArchivo,
  type JobIngesta,
  type PanelRag,
  pausarJobIngesta,
  reanudarJobIngesta,
} from '../api/rag';

type Estado =
  | { tipo: 'cargando' }
  | { tipo: 'error'; mensaje: string }
  | { tipo: 'listo'; panel: PanelRag };

const ETIQUETA_ESTADO_DOC: Record<string, string> = {
  pendientes: 'Pendientes',
  convertidos: 'Convertidos (sin embeber)',
  ok: 'Completos',
  sinTexto: 'Sin texto útil',
  error: 'Con error',
  noSoportado: 'Sin archivo digital',
};

/** " (activo)" / " (respaldo)" junto al nombre del conversor, o nada si no juega ningún papel. */
function papelConversor(
  conversion: PanelRag['proveedores']['conversion'],
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
 * Vocabulario y arranque de cada tipo de job que se puede encadenar por lotes. `limite` es el tope
 * por job que ya aplicaba el backend — se repite aquí, no se descubre por prueba y error, porque el
 * frontend lo necesita para pedir el lote siguiente con el mismo tamaño.
 */
const CONFIG_CADENA: Record<TipoCadena, {
  limite: number;
  unidad: string;
  /** Plural liso ("documentos", no "documento(s)"), para frases donde el "(s)" ya sobra por
   *  contexto — ej. "No quedan documentos pendientes." */
  unidadPlural: string;
  verbo: string;
  /** Sustantivo para mensajes de error ("el job de …"): sin flexionar, distinto de las etiquetas
   *  de abajo, que ya vienen concordadas en género y número. */
  nombre: string;
  etiquetaTerminada: string;
  etiquetaDetenida: string;
  mensajeSinPendientes: string;
  mensajeError: string;
  iniciar: (filtro: FiltroIngesta) => Promise<{ jobId: number }>;
}> = {
  conversion: {
    limite: 500,
    unidad: 'documento(s)',
    unidadPlural: 'documentos',
    verbo: 'convertido(s)',
    nombre: 'conversión',
    etiquetaTerminada: 'Conversión terminada',
    etiquetaDetenida: 'Conversión detenida',
    mensajeSinPendientes: 'No hay documentos pendientes por convertir.',
    mensajeError: 'No se pudo iniciar la conversión',
    iniciar: iniciarIngestaConversion,
  },
  embedding: {
    limite: 2000,
    unidad: 'fragmento(s)',
    unidadPlural: 'fragmentos',
    verbo: 'embebido(s)',
    nombre: 'embeddings',
    etiquetaTerminada: 'Ingesta de embeddings terminada',
    etiquetaDetenida: 'Ingesta de embeddings detenida',
    mensajeSinPendientes: 'No hay fragmentos pendientes de embeber.',
    mensajeError: 'No se pudo iniciar la ingesta de embeddings',
    iniciar: iniciarIngestaEmbeddings,
  },
};

/**
 * Una tanda encadenada de conversión o de embeddings: el backend procesa como mucho
 * `CONFIG_CADENA[tipo].limite` unidades por job y termina, así que cubrir el corpus entero es
 * lanzar un lote tras otro. `lote` es el que está corriendo ahora; `procesados`/`errores` acumulan
 * los lotes YA cerrados.
 */
interface Cadena {
  tipo: TipoCadena;
  lote: number;
  procesados: number;
  errores: number;
}

/**
 * La cadena vive en `sessionStorage` por la misma razón que existe `buscarJobActivo`: cambiar de
 * pestaña desmonta esta página y se lleva su estado, pero el lote sigue corriendo en el servidor.
 * Sin esto, salir del panel un momento mataría la tanda en silencio.
 *
 * Una sola clave basta para los dos tipos: solo puede haber un job de ingesta a la vez (el backend
 * es un semáforo de 1), así que nunca hay dos cadenas vivas al mismo tiempo.
 */
const CLAVE_CADENA = 'rag.cadena.conversion';

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
      // Una cadena guardada antes de que este campo existiera es, por definición, de conversión —
      // era el único tipo que se encadenaba.
      tipo: cadena.tipo === 'embedding' ? 'embedding' : 'conversion',
    };
  } catch {
    // Almacenamiento bloqueado o contenido corrupto: se trabaja sin cadena recuperada.
    return null;
  }
}

export function RagPanelPage() {
  const [estado, setEstado] = useState<Estado>({ tipo: 'cargando' });
  const [jobActivo, setJobActivo] = useState<JobIngesta | null>(null);
  const [jobIdFiltro, setJobIdFiltro] = useState<number | null>(null);
  const [barriendo, setBarriendo] = useState(false);
  const [purgando, setPurgando] = useState(false);
  const [recolectando, setRecolectando] = useState(false);
  /** Casillas de cada botón: encadenar lotes o hacer uno solo, como se hacía siempre. */
  const [encadenar, setEncadenar] = useState(true);
  const [encadenarEmbeddings, setEncadenarEmbeddings] = useState(true);
  const [cadena, setCadena] = useState<Cadena | null>(null);
  const [confirmacion, setConfirmacion] = useState<
    { job: JobIngesta; segundos: number | null } | null
  >(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cargar = useCallback(() => {
    fetchPanel()
      .then((panel) => setEstado({ tipo: 'listo', panel }))
      .catch((error: unknown) =>
        setEstado({ tipo: 'error', mensaje: error instanceof Error ? error.message : 'Error desconocido' }),
      );
  }, []);

  useEffect(() => cargar(), [cargar]);

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

  // Re-enganche al job que siguió corriendo mientras esta pantalla no existía.
  //
  // El job vive en el backend, no en el navegador: `App.tsx` renderiza las vistas con
  // `{clave === 'rag' && <RagPanelPage />}`, así que cambiar de pestaña DESMONTA este componente y
  // se lleva `jobActivo`. El trabajo no se entera y sigue convirtiendo, pero al volver la pantalla
  // arrancaba en blanco: parecía cancelado. Y como el `disabled` de los botones depende de
  // `jobActivo`, volver a pulsar apilaba un segundo job sobre el mismo pool de documentos.
  //
  // Solo repuebla el estado inicial: el `useEffect` de sondeo de abajo se encarga a partir de ahí.
  useEffect(() => {
    let vigente = true;
    const guardada = leerCadenaGuardada();

    buscarJobActivo()
      .then(async (job) => {
        if (!vigente) return;
        if (job) {
          setJobActivo(job);
          setJobIdFiltro(job.id); // devuelve también la lista de documentos a donde estaba
          if (guardada) aplicarCadena(guardada);
          return;
        }

        // Sin job vivo pero con una cadena guardada: el lote terminó mientras esta pantalla no
        // existía. Se pregunta ahora, ya sin cuenta atrás — lanzar otros 500 documentos sin que
        // nadie lo haya visto es justo lo que la pregunta existe para evitar.
        if (!guardada) return;
        const [ultimo] = await fetchJobs();
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
          aplicarCadena(null); // se detuvo o falló: la cadena ya no tiene sentido
        }
      })
      .catch(() => {
        // Sin re-enganche la pantalla sigue siendo usable; no merece tumbarla ni avisar.
      });
    return () => {
      vigente = false;
    };
  }, [aplicarCadena]);

  // Sondeo del job de ingesta en curso, si lo hay. Sigue mientras haya un documento en vuelo
  // aunque el job ya no esté "en_curso" (pausado/cancelado): ese ítem nunca se aborta a mitad
  // (no hay forma de cortar una llamada HTTP al conversor), así que el panel debe poder mostrar
  // cómo termina en vez de congelarse con la última foto antes de Detener/Pausar.
  useEffect(() => {
    if (!jobActivo || (jobActivo.estado !== 'en_curso' && !jobActivo.procesoActual)) return;
    pollRef.current = setTimeout(async () => {
      try {
        const job = await fetchJob(jobActivo.id);
        // Comparado contra el ESTADO ANTERIOR (capturado en el cierre), no contra "sigue sin estar
        // en_curso": con el sondeo ahora extendido para ver terminar el documento en vuelo, ese
        // segundo caso se repetiría en cada tick mientras se espera y refrescaría el panel sin
        // necesidad. Cada evento se refresca UNA sola vez, en el tick en que ocurre de verdad.
        const yaNoEstaEnCurso = job.estado !== 'en_curso' && jobActivo.estado === 'en_curso';
        const documentoEnVueloTermino = !job.procesoActual && !!jobActivo.procesoActual;
        setJobActivo(job);
        if (yaNoEstaEnCurso || documentoEnVueloTermino) cargar(); // refresca el panel con las cifras finales

        // Fin de lote de una tanda encadenada: toca preguntar si se sigue con el siguiente. Solo
        // `completado` cuenta — 'cancelado' es una parada deliberada y 'pausado' no es un fin. La
        // condición se cumple UNA sola vez: compara contra el estado anterior, y en el próximo
        // tick el efecto ya ni siquiera sondea (el job dejó de estar en curso).
        if (cadena && yaNoEstaEnCurso && job.estado === 'completado') {
          aplicarCadena({
            tipo: cadena.tipo,
            lote: cadena.lote,
            procesados: cadena.procesados + job.procesados,
            errores: cadena.errores + job.errores,
          });
          // Un lote que no procesó NADA no arranca solo: en conversión los `no_soportado` vuelven
          // a la cola mientras `intentos < 10`, y en embeddings un lote vacío suele ser un
          // proveedor caído — en ambos casos una cadena automática podría girar en falso. Ahí se
          // exige una decisión.
          setConfirmacion({ job, segundos: job.procesados > 0 ? SEGUNDOS_CONFIRMACION : null });
        } else if (cadena && yaNoEstaEnCurso && (job.estado === 'cancelado' || job.estado === 'error')) {
          // 'cancelado' por el botón Detener ya cierra la cadena por su cuenta (ver `detener()`);
          // esto cubre el caso en que nadie tocó nada y el job terminó solo en error — 3 lotes de
          // embeddings fallidos seguidos, por ejemplo.
          aplicarCadena(null);
          if (job.estado === 'error') {
            toast.error(
              `El job de ${CONFIG_CADENA[cadena.tipo].nombre} terminó con error`
              + (job.mensaje ? `: ${job.mensaje}` : '.'),
            );
          }
        }
      } catch {
        // Un fallo de red al sondear no debe tumbar la pantalla; se reintenta en el próximo tick.
      }
    }, INTERVALO_POLL_MS);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [jobActivo, cargar, cadena, aplicarCadena]);

  async function alternarBarrido(activo: boolean) {
    try {
      await activarBarrido(activo);
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
      const r = await barrerAhora();
      toast.success(`Barrido completado: ${r.documentosNuevos} nuevo(s), ${r.documentosBaja} baja(s).`, { id });
      cargar();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo barrer', { id });
    } finally {
      setBarriendo(false);
    }
  }

  async function alternarRetencion(activo: boolean) {
    try {
      await activarRetencion(activo);
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
      const r = await ejecutarRetencionAhora();
      toast.success(
        `Retención ejecutada: ${r.loginIntento} intento(s) de login, ${r.usoToken} uso(s) de token, ${r.retrievalLog} consulta(s) de log purgadas.`,
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
      await activarGC(activo);
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
      const r = await ejecutarGcAhora();
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
   * Lanza un lote de `tipo`. Devuelve `false` cuando ya no quedaba nada que procesar — el backend
   * responde 404 con ese filtro, que es la señal natural de fin de una cadena. Se mira el `status`
   * de `ApiError`, no el texto del mensaje.
   */
  const lanzarLote = useCallback(async (tipo: TipoCadena): Promise<boolean> => {
    const config = CONFIG_CADENA[tipo];
    try {
      const { jobId } = await config.iniciar({ limite: config.limite });
      setJobActivo(await fetchJob(jobId));
      setJobIdFiltro(jobId);
      return true;
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 404) return false;
      toast.error(error instanceof Error ? error.message : config.mensajeError);
      throw error;
    }
  }, []);

  async function convertir() {
    // La cadena se abre ANTES de lanzar: un lote muy corto podría completarse antes de que el
    // estado se hubiera actualizado, y el sondeo se perdería la pregunta.
    aplicarCadena(encadenar ? { tipo: 'conversion', lote: 1, procesados: 0, errores: 0 } : null);
    setConfirmacion(null);
    try {
      if (!(await lanzarLote('conversion'))) {
        aplicarCadena(null);
        toast.success(CONFIG_CADENA.conversion.mensajeSinPendientes);
      }
    } catch {
      aplicarCadena(null); // `lanzarLote` ya avisó del error
    }
  }

  async function embeber() {
    // Simétrico de `convertir()`: misma razón para abrir la cadena antes de lanzar.
    aplicarCadena(encadenarEmbeddings ? { tipo: 'embedding', lote: 1, procesados: 0, errores: 0 } : null);
    setConfirmacion(null);
    try {
      if (!(await lanzarLote('embedding'))) {
        aplicarCadena(null);
        toast.success(CONFIG_CADENA.embedding.mensajeSinPendientes);
      }
    } catch {
      aplicarCadena(null); // `lanzarLote` ya avisó del error
    }
  }

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

  async function reparar() {
    try {
      const { jobId } = await iniciarIngestaReparacion({ limite: 500 });
      setJobActivo(await fetchJob(jobId));
      setJobIdFiltro(jobId);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo iniciar la reparación');
    }
  }

  async function reintentarSinArchivo() {
    const total = panel?.corpus.documentos.noSoportado ?? 0;
    if (!window.confirm(
      `Se volverán a intentar los ${total} documento(s) "sin archivo", incluidos los que ya agotaron `
        + 'sus intentos. Asegúrese de que el repositorio de archivos del SGD esté montado. ¿Continuar?',
    )) return;
    try {
      const { jobId, total: encolados } = await reintentarTodosSinArchivo();
      toast.success(`${encolados} documento(s) "sin archivo" en cola de reintento.`);
      setJobActivo(await fetchJob(jobId));
      setJobIdFiltro(jobId);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudieron reintentar los documentos sin archivo');
    }
  }

  async function largos() {
    try {
      const { jobId } = await iniciarIngestaLargos({ limite: 500 });
      setJobActivo(await fetchJob(jobId));
      setJobIdFiltro(jobId);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo iniciar la conversión de documentos largos');
    }
  }

  async function pausar() {
    if (!jobActivo) return;
    try {
      setJobActivo(await pausarJobIngesta(jobActivo.id));
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo pausar el trabajo');
    }
  }

  async function reanudar() {
    if (!jobActivo) return;
    try {
      setJobActivo(await reanudarJobIngesta(jobActivo.id));
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo reanudar el trabajo');
    }
  }

  async function detener() {
    if (!jobActivo) return;
    try {
      setJobActivo(await cancelarJobIngesta(jobActivo.id));
      // Parar a mano es parar la tanda entera, no solo este lote. Pausar, en cambio, NO la corta:
      // se reanuda el mismo job y la cadena debe seguir viva.
      aplicarCadena(null);
      setConfirmacion(null);
      cargar(); // los ítems no alcanzados quedan "omitido" — refresca las cifras del panel
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo detener el trabajo');
    }
  }

  if (estado.tipo === 'cargando') {
    return (
      <main className="app-main">
        <div className="state-message" role="status">Cargando el estado de la base de conocimientos…</div>
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
  const { documentos } = panel.corpus;

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
                Detecta expedientes nuevos o cambiados. Nunca ingesta por su cuenta: solo actualiza
                el estado. Arranca desactivado a propósito.
              </span>
            </span>
          </label>

          <p className={panel.barrido.horasDesdeUltimo === null || panel.barrido.horasDesdeUltimo > 24 ? 'exp-nota is-error' : 'exp-nota'}>
            {panel.barrido.ultimo
              ? `Último barrido: ${new Date(panel.barrido.ultimo.feInicio).toLocaleString('es-PE')} `
                + `(${panel.barrido.ultimo.disparo}) — ${panel.barrido.ultimo.documentosNuevos} nuevo(s)`
              : 'Todavía no se ha ejecutado ningún barrido: las cifras de abajo pueden no reflejar el SGD actual.'}
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
                    <td>{documentos[clave]}</td>
                  </tr>
                ))}
                <tr><td><strong>Total</strong></td><td><strong>{documentos.total}</strong></td></tr>
              </tbody>
            </table>
          </div>
          <p className="exp-nota">
            {panel.corpus.contenido.unicos} contenido(s) único(s) · {panel.corpus.contenido.chunks} fragmento(s)
            · {panel.corpus.expedientes.completos} de {panel.corpus.expedientes.total} expedientes completos
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
                Descarga, convierte a texto y trocea. No necesita ninguna clave de API: usa{' '}
                {panel.proveedores.conversion.proveedorActivo}, que corre en este servidor
                {panel.proveedores.conversion.proveedorRespaldo
                  && `, y reintenta con ${panel.proveedores.conversion.proveedorRespaldo} los documentos que fallen`}.
              </p>
              <label className="checkbox-linea">
                <input
                  type="checkbox"
                  // Etiqueta explícita: dos casillas idénticas ("Continuar por lotes", una aquí y
                  // otra junto a "Generar embeddings") necesitan nombres accesibles distintos —
                  // tanto para un lector de pantalla como para que las pruebas puedan pulsar una
                  // sin ambigüedad con la otra.
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
                onClick={reparar}
                disabled={
                  (!!jobActivo && jobActivo.estado === 'en_curso')
                  || documentos.noSoportado + documentos.sinTexto + documentos.error === 0
                }
              >
                Reparar recuperables
              </button>
              <p className="exp-nota">
                Reintenta los {documentos.noSoportado + documentos.sinTexto + documentos.error}{' '}
                documento(s) "sin archivo", "sin texto" o "con error" con generación desde el SGD y{' '}
                {panel.proveedores.conversion.proveedorActivo}
                {panel.proveedores.conversion.proveedorRespaldo
                  && ` (con ${panel.proveedores.conversion.proveedorRespaldo} de respaldo)`}.{' '}
                <strong>Nunca llama a ChatGPT: no consume tokens.</strong>
              </p>
            </div>
            <div>
              <button
                className="boton-secundario"
                onClick={reintentarSinArchivo}
                disabled={(!!jobActivo && jobActivo.estado === 'en_curso') || documentos.noSoportado === 0}
              >
                Reintentar todos los sin archivo
              </button>
              <p className="exp-nota">
                Vuelve a buscar el archivo de los {documentos.noSoportado} documento(s) "sin
                archivo", incluidos los que ya agotaron sus intentos (por ejemplo, porque se
                marcaron con el repositorio de archivos desmontado). Se rechaza si el repositorio
                sigue sin montar.
              </p>
            </div>
            <div>
              <button
                className="boton-secundario"
                onClick={largos}
                disabled={(!!jobActivo && jobActivo.estado === 'en_curso') || documentos.largos === 0}
              >
                Convertir documentos largos
              </button>
              <p className="exp-nota">
                Reintenta los {documentos.largos} documento(s) de muchas páginas que quedaron
                atascados por el límite de tiempo del conversor: se trocean en bloques de pocas
                páginas cada uno para que el documento entero deje de tener límite, sin que
                ninguna llamada individual pierda el suyo.
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
                cadena.tipo === 'conversion' ? documentos.pendientes : panel.corpus.embeddings.chunksSinEmbedding
              }
              segundos={confirmacion.segundos}
              onContinuar={continuarCadena}
              onDetener={detenerCadena}
            />
          )}
        </section>

        {/* Documentos individuales — el detalle detrás de la tabla de arriba */}
        <section className="rag-tarjeta rag-tarjeta--ancha">
          <h2>Documentos</h2>
          <p className="exp-nota">
            Revise documento por documento cuáles quedaron vacíos o con error para abrirlos
            manualmente.
          </p>
          <ListaDocumentosRag
            jobId={jobIdFiltro ?? undefined}
            onQuitarFiltroJob={() => setJobIdFiltro(null)}
            jobEnCurso={!!jobActivo && jobActivo.estado === 'en_curso'}
            // Solo bloquea si NINGUNA vía está disponible: con respaldo configurado, que el
            // circuito del activo esté abierto no impide nada — la conversión sale por el otro,
            // igual que decide `conversionBloqueada()` en el backend.
            circuitoAbierto={
              panel.proveedores.conversion.proveedorRespaldo
                ? panel.proveedores.markitdown.circuitoAbierto && panel.proveedores.mineru.circuitoAbierto
                : panel.proveedores.conversion.proveedorActivo === 'mineru'
                  ? panel.proveedores.mineru.circuitoAbierto
                  : panel.proveedores.markitdown.circuitoAbierto
            }
            visionDisponible={panel.proveedores.vision.disponible}
            visionMotivo={panel.proveedores.vision.motivo}
          />
        </section>

        {/* Tokens consumidos */}
        <section className="rag-tarjeta">
          <h2>Tokens consumidos</h2>
          <p>Hoy: <strong>{panel.tokens.hoy.reduce((n, t) => n + t.tokensIn + t.tokensOut, 0).toLocaleString('es-PE')}</strong></p>
          <p>Acumulado: <strong>{(panel.tokens.acumulado.tokensIn + panel.tokens.acumulado.tokensOut).toLocaleString('es-PE')}</strong></p>
          {panel.tokens.acumulado.costeUsd > 0 && <p>Coste estimado: ${panel.tokens.acumulado.costeUsd.toFixed(2)}</p>}
        </section>

        {/* Mantenimiento: retención de logs y recolector de basura (Fase 6) */}
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
                    Purga intentos de login, consumo de tokens y consultas de chat de más de{' '}
                    {panel.mantenimiento.retencion.dias} días. Solo ruido de auditoría/depuración,
                    nunca contenido ingerido — arranca ACTIVADA.
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
                    Arranca DESACTIVADO, igual que el barrido.
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

        {/* Evaluación del retrieval, sobre rag.retrieval_log (Fase 6) */}
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
    </main>
  );
}
