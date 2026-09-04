import { useCallback, useEffect, useRef, useState } from 'react';
import toast, { Toaster } from 'react-hot-toast';
import { ListaDocumentosRag } from '../components/ListaDocumentosRag';
import { PanelJobIngesta } from '../components/PanelJobIngesta';
import {
  activarBarrido,
  activarGC,
  activarRetencion,
  barrerAhora,
  cancelarJobIngesta,
  ejecutarGcAhora,
  ejecutarRetencionAhora,
  fetchJob,
  fetchPanel,
  iniciarIngestaConversion,
  iniciarIngestaEmbeddings,
  iniciarIngestaLargos,
  iniciarIngestaReparacion,
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
  pendiente: 'Pendientes',
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

export function RagPanelPage() {
  const [estado, setEstado] = useState<Estado>({ tipo: 'cargando' });
  const [jobActivo, setJobActivo] = useState<JobIngesta | null>(null);
  const [jobIdFiltro, setJobIdFiltro] = useState<number | null>(null);
  const [barriendo, setBarriendo] = useState(false);
  const [purgando, setPurgando] = useState(false);
  const [recolectando, setRecolectando] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cargar = useCallback(() => {
    fetchPanel()
      .then((panel) => setEstado({ tipo: 'listo', panel }))
      .catch((error: unknown) =>
        setEstado({ tipo: 'error', mensaje: error instanceof Error ? error.message : 'Error desconocido' }),
      );
  }, []);

  useEffect(() => cargar(), [cargar]);

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
      } catch {
        // Un fallo de red al sondear no debe tumbar la pantalla; se reintenta en el próximo tick.
      }
    }, INTERVALO_POLL_MS);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [jobActivo, cargar]);

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

  async function convertir() {
    try {
      const { jobId } = await iniciarIngestaConversion({ limite: 500 });
      setJobActivo(await fetchJob(jobId));
      setJobIdFiltro(jobId);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo iniciar la conversión');
    }
  }

  async function reparar() {
    try {
      const { jobId } = await iniciarIngestaReparacion({ limite: 500 });
      setJobActivo(await fetchJob(jobId));
      setJobIdFiltro(jobId);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo iniciar la reparación');
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

  async function embeber() {
    try {
      const { jobId } = await iniciarIngestaEmbeddings({ limite: 2000 });
      setJobActivo(await fetchJob(jobId));
      setJobIdFiltro(jobId);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'No se pudo iniciar la ingesta de embeddings');
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
                {(['ok', 'convertidos', 'pendiente', 'sinTexto', 'error', 'noSoportado'] as const).map((clave) => (
                  <tr key={clave}>
                    <td>{ETIQUETA_ESTADO_DOC[clave]}</td>
                    <td>{documentos[clave as keyof typeof documentos]}</td>
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
