import { apiJson } from './cliente';
import type { FaseConversion, JobIngesta, ProcesoActualJob } from './rag';

/**
 * Cliente del panel de administración del STD (`/api/std/rag/*`, permiso `std.gestionar`).
 *
 * Deliberadamente más chico que `api/rag.ts` del SGD: el motor de ingesta del STD todavía no tiene
 * reparación masiva, "documentos largos sueltos", reintento-sin-archivo ni extracción con IA de
 * visión (ver la cabecera de `ingestaStdService.ts` en el backend) — por eso `RagPanelStdPage` es
 * una página propia y más simple, en vez de forzar al panel del SGD (y sus 600+ líneas de
 * `ListaDocumentosRag`) a volverse genérico con condicionales para funciones que aquí no existen.
 *
 * `JobIngesta`/`FaseConversion`/`ProcesoActualJob` se REUTILIZAN tal cual de `api/rag.ts`: la forma
 * de un job (`id/tipo/estado/total/procesados/errores/...`) es idéntica en las dos bases — el motor
 * de cola (`rag.ingest_job`) es el mismo código compartido (`compartido/rag/*`) corriendo contra
 * `std_rag`. Solo `filtro` cambia de forma (`idDocumento` en vez de `nuAnnExp`/`nuSecExp`), y como
 * todos sus campos son opcionales, `FiltroIngestaStd` sigue siendo asignable a `JobIngesta.filtro`
 * sin ningún cast. Esto también permite reutilizar `PanelJobIngesta` (el componente) tal cual.
 */

export type { FaseConversion, JobIngesta, ProcesoActualJob };

export interface PanelRagStd {
  corpus: {
    documentos: {
      total: number; ok: number; convertidos: number; pendientes: number;
      sinTexto: number; error: number; noSoportado: number;
    };
    documentosStd: { total: number; completos: number };
    contenido: { unicos: number; convertidos: number; chunks: number; caracteres: number };
    embeddings: { vectores: number; chunksSinEmbedding: number };
    cobertura: { conversionPct: number; embeddingPct: number };
  };
  barrido: {
    activo: boolean;
    cadenciaMin: number;
    ultimo: {
      id: number; tipo: string; disparo: string; feInicio: string; feFin: string | null;
      documentosRevisados: number; documentosNuevos: number; documentosCambiados: number;
      error: string | null;
    } | null;
    horasDesdeUltimo: number | null;
  };
  proveedores: {
    embedding: { proveedor: string; disponible: boolean; motivo: string | null };
    chat: { proveedor: string };
    vision: { proveedor: string; disponible: boolean; motivo: string | null };
    problemas: { variable: string; mensaje: string }[];
    markitdown: { disponible: boolean; circuitoAbierto: boolean };
    mineru: { disponible: boolean; circuitoAbierto: boolean };
    conversion: {
      proveedorActivo: 'markitdown' | 'mineru';
      proveedorRespaldo: 'markitdown' | 'mineru' | null;
    };
  };
  tokens: {
    hoy: { proveedor: string; modelo: string; operacion: string; tokensIn: number; tokensOut: number; costeUsd: number }[];
    acumulado: { tokensIn: number; tokensOut: number; costeUsd: number };
  };
  mantenimiento: {
    retencion: { activa: boolean; dias: number; ultimo: { feInicio: string; filasAfectadas: number } | null };
    gc: {
      activo: boolean; graciaDias: number;
      ultimo: { feInicio: string; filasAfectadas: number } | null;
      huerfanosPendientes: number;
    };
  };
  evaluacion: {
    ventanaDias: number;
    totalConsultas: number;
    sinResultados: number;
    conAlucinaciones: number;
    escaneoExactoPct: number;
    msPromedio: number;
  };
}

export function fetchPanelStd(): Promise<PanelRagStd> {
  return apiJson('/api/std/rag/panel', 'obtener el estado de la base de conocimientos del STD');
}

export interface DocumentoRagStd {
  id: number;
  idAdjunto: number;
  idDocumento: number;
  nroStd: string | null;
  origen: 'principal' | 'anexo' | 'derivacion';
  documento: string | null;
  tipoDoc: string | null;
  asunto: string | null;
  estado: string;
  motivoError: string | null;
  intentos: number;
  chars: number | null;
  chunksGenerados: number | null;
  metodo: string | null;
  estadoItem: string | null;
  motivoErrorItem: string | null;
}

export interface ListaDocumentosStd {
  total: number;
  pagina: number;
  porPagina: number;
  items: DocumentoRagStd[];
}

export interface FiltroDocumentosStd {
  estado?: string;
  q?: string;
  idDocumento?: number;
  jobId?: number;
  pagina?: number;
}

const POR_PAGINA_DOCUMENTOS = 50;

export function fetchDocumentosStd(filtro: FiltroDocumentosStd): Promise<ListaDocumentosStd> {
  const params = new URLSearchParams({ porPagina: String(POR_PAGINA_DOCUMENTOS) });
  if (filtro.estado) params.set('estado', filtro.estado);
  if (filtro.q?.trim()) params.set('q', filtro.q.trim());
  if (filtro.idDocumento) params.set('idDocumento', String(filtro.idDocumento));
  if (filtro.jobId) params.set('jobId', String(filtro.jobId));
  if (filtro.pagina) params.set('pagina', String(filtro.pagina));

  return apiJson(`/api/std/rag/documentos?${params}`, 'listar los documentos del STD');
}

export interface MarkdownDocumentoStd {
  markdown: string;
  chars: number;
  metodo: string | null;
  truncado: boolean;
}

export function fetchMarkdownDocumentoStd(id: number): Promise<MarkdownDocumentoStd> {
  return apiJson(`/api/std/rag/documentos/${id}/markdown`, 'obtener el markdown del documento');
}

export interface ResultadoReparacionStd {
  documento: DocumentoRagStd;
  mensaje?: string;
  enCurso?: boolean;
}

/** Reintenta UN documento ahora mismo — no espera al próximo barrido ni encola un job. */
export function reintentarDocumentoStd(id: number): Promise<ResultadoReparacionStd> {
  return apiJson(`/api/std/rag/documentos/${id}/reintentar`, 'reintentar el documento', { method: 'POST' });
}

/** Último recurso manual y de pago: transcribe UN documento con IA de visión. */
export function extraerConVisionStd(id: number): Promise<{ documento: DocumentoRagStd }> {
  return apiJson(`/api/std/rag/documentos/${id}/vision`, 'extraer el texto con IA', { method: 'POST' });
}

export function activarBarridoStd(activo: boolean): Promise<{ ok: true }> {
  return apiJson('/api/std/rag/config/rag.barrido.activo', 'cambiar el interruptor del barrido', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ valor: activo }),
  });
}

/** Funciona aunque el interruptor esté apagado: gobierna la automatización, no la capacidad. */
export function barrerAhoraStd(): Promise<{ documentosNuevos: number; documentosCambiados: number }> {
  return apiJson('/api/std/rag/barrer', 'ejecutar el barrido del STD', { method: 'POST' });
}

export function activarRetencionStd(activo: boolean): Promise<{ ok: true }> {
  return apiJson('/api/std/rag/config/rag.retencion.activa', 'cambiar el interruptor de retención', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ valor: activo }),
  });
}

export function activarGcStd(activo: boolean): Promise<{ ok: true }> {
  return apiJson('/api/std/rag/config/rag.gc.activo', 'cambiar el interruptor del recolector de basura', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ valor: activo }),
  });
}

export function ejecutarRetencionAhoraStd(): Promise<{ usoToken: number; retrievalLog: number }> {
  return apiJson('/api/std/rag/mantenimiento/retencion', 'ejecutar la retención', { method: 'POST' });
}

export function ejecutarGcAhoraStd(): Promise<{ marcados: number; recolectados: number; chunksBorrados: number }> {
  return apiJson('/api/std/rag/mantenimiento/gc', 'ejecutar el recolector de basura', { method: 'POST' });
}

export interface FiltroIngestaStd {
  limite?: number;
  idDocumento?: number;
  documentoIds?: number[];
  anio?: number;
  origen?: 'principal' | 'anexo' | 'derivacion';
}

export function iniciarIngestaConversionStd(filtro: FiltroIngestaStd = {}): Promise<{ jobId: number }> {
  return apiJson('/api/std/rag/ingesta/conversion', 'iniciar la ingesta de conversión del STD', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filtro),
  });
}

export function iniciarIngestaEmbeddingsStd(filtro: FiltroIngestaStd = {}): Promise<{ jobId: number }> {
  return apiJson('/api/std/rag/ingesta/embeddings', 'iniciar la ingesta de embeddings del STD', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filtro),
  });
}

/** Reintenta TODOS los "sin archivo" del STD, incluidos los que agotaron sus intentos. 409 si el
 *  repositorio `uploads/` sigue desmontado. */
export function reintentarTodosSinArchivoStd(): Promise<{ jobId: number; total: number }> {
  return apiJson('/api/std/rag/ingesta/sin-archivo', 'reintentar los documentos sin archivo del STD', {
    method: 'POST',
  });
}

export function fetchJobStd(jobId: number): Promise<JobIngesta> {
  return apiJson(`/api/std/rag/ingesta/${jobId}`, 'consultar el trabajo de ingesta del STD');
}

export function fetchJobsStd(): Promise<JobIngesta[]> {
  return apiJson('/api/std/rag/ingesta', 'obtener los trabajos recientes del STD');
}

function estaVivo(job: JobIngesta): boolean {
  return job.estado === 'en_curso' || job.estado === 'pausado';
}

/** El job de ingesta del STD vivo ahora mismo, o `null` — mismo motivo que `buscarJobActivo` del
 *  SGD: el job corre en el backend, desacoplado de esta pantalla. */
export async function buscarJobActivoStd(): Promise<JobIngesta | null> {
  const vivos = (await fetchJobsStd()).filter(estaVivo);
  return vivos[0] ?? null;
}

export function pausarJobIngestaStd(jobId: number): Promise<JobIngesta> {
  return apiJson(`/api/std/rag/ingesta/${jobId}/pausar`, 'pausar el trabajo', { method: 'POST' });
}

export function reanudarJobIngestaStd(jobId: number): Promise<JobIngesta> {
  return apiJson(`/api/std/rag/ingesta/${jobId}/reanudar`, 'reanudar el trabajo', { method: 'POST' });
}

export function cancelarJobIngestaStd(jobId: number): Promise<JobIngesta> {
  return apiJson(`/api/std/rag/ingesta/${jobId}/cancelar`, 'detener el trabajo', { method: 'POST' });
}
