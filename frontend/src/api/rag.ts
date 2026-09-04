import { apiJson } from './cliente';

export interface PanelRag {
  corpus: {
    documentos: {
      total: number; ok: number; convertidos: number; pendientes: number;
      sinTexto: number; error: number; noSoportado: number; largos: number;
    };
    expedientes: { total: number; completos: number };
    contenido: { unicos: number; convertidos: number; chunks: number; caracteres: number };
    embeddings: { vectores: number; chunksSinEmbedding: number };
    cobertura: { conversionPct: number; embeddingPct: number };
  };
  barrido: {
    activo: boolean;
    cadenciaMin: number;
    cadenciaHashMin: number;
    ultimo: {
      id: number; tipo: string; disparo: string; feInicio: string; feFin: string | null;
      expedientesRevisados: number; documentosNuevos: number; documentosCambiados: number;
      documentosBaja: number; error: string | null;
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
    /** `proveedorRespaldo` es el conversor que se intenta si el activo falla — `null` si el
     *  fallback está desactivado (`RAG_CONVERTER_FALLBACK=ninguno`). */
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
    retencion: {
      activa: boolean; dias: number;
      ultimo: { feInicio: string; filasAfectadas: number } | null;
    };
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
  inventarioInicial: boolean;
}

/** Espejo de `FaseConversion` en `backend/src/rag/fasesConversion.ts`. */
export type FaseConversion =
  | 'descargando'
  | 'generando'
  | 'deduplicando'
  | 'esperando_circuito'
  | 'en_cola_conversor'
  | 'convirtiendo'
  | 'troceando'
  | 'guardando'
  | 'listo';

export interface ProcesoActualJob {
  documentoId: number;
  titulo: string | null;
  /** Segundos desde que el trabajo tomó este documento — texto para el humano ("— 42 s"). */
  segundos: number;
  /**
   * Todo lo de abajo es opcional a propósito, aunque el backend siempre lo mande: así un
   * navegador con el bundle en caché contra un backend ya actualizado (o un mock de test parcial)
   * cae en la barra indeterminada de siempre en vez de romper la pantalla con un `undefined`.
   */
  fase?: FaseConversion;
  /** Milisegundos DENTRO de la fase, medidos por el servidor al responder. `PanelJobIngesta` le
   *  suma su propio reloj desde que recibió la respuesta — nunca se compara con un reloj remoto. */
  faseMs?: number;
  /** Tope de la fase en ms, o `null` si no lo tiene (solo las del conversor y la espera lo traen). */
  faseLimiteMs?: number | null;
  proveedor?: 'markitdown' | 'mineru' | null;
  /** 1 = proveedor activo, 2 = respaldo. */
  intento?: number;
  /** 1 sin respaldo configurado, 2 con él. */
  intentos?: number;
  motivoFallback?: string | null;
  /** Troceo de documentos largos (conversionLargaService): `null`/`undefined` fuera de un
   *  documento troceado, igual de opcionales que el resto por la misma razón de compatibilidad. */
  bloque?: number | null;
  bloques?: number | null;
  paginaDesde?: number | null;
  paginaHasta?: number | null;
}

export interface JobIngesta {
  id: number;
  tipo: string;
  estado: string;
  total: number;
  procesados: number;
  errores: number;
  mensaje: string | null;
  feInicio: string;
  feFin: string | null;
  /** Solo presente cuando `getJob` se llama sobre un job de conversión/reparación en curso. */
  procesoActual?: ProcesoActualJob | null;
}

export interface ModeloEmbedding {
  id: number;
  proveedor: string;
  modelo: string;
  dimension: number;
  activo: boolean;
  backfillPct: number;
}

export function fetchPanel(): Promise<PanelRag> {
  return apiJson('/api/rag/panel', 'obtener el estado de la base de conocimientos');
}

export interface DocumentoRag {
  id: number;
  nuAnn: string;
  nuEmi: string;
  nuAne: number;
  titulo: string | null;
  tipoDoc: string | null;
  asunto: string | null;
  nuAnnExp: string | null;
  nuSecExp: string | null;
  numeroExpediente: string | null;
  estado: string;
  motivoError: string | null;
  intentos: number;
  chars: number | null;
  chunksGenerados: number | null;
  metodo: string | null;
  /** Solo cuando se filtra por `jobId`: qué pasó con este documento EN ESE trabajo puntual. */
  estadoItem: string | null;
  motivoErrorItem: string | null;
}

export interface ListaDocumentos {
  total: number;
  pagina: number;
  porPagina: number;
  items: DocumentoRag[];
}

export interface FiltroDocumentos {
  estado?: string;
  q?: string;
  nuAnnExp?: string;
  nuSecExp?: string;
  /** Acota la lista a los documentos que formaron parte de ese trabajo de ingesta puntual. */
  jobId?: number;
  pagina?: number;
}

const POR_PAGINA_DOCUMENTOS = 50;

export function fetchDocumentos(filtro: FiltroDocumentos): Promise<ListaDocumentos> {
  const params = new URLSearchParams({ porPagina: String(POR_PAGINA_DOCUMENTOS) });
  if (filtro.estado) params.set('estado', filtro.estado);
  if (filtro.q?.trim()) params.set('q', filtro.q.trim());
  if (filtro.nuAnnExp) params.set('nuAnnExp', filtro.nuAnnExp);
  if (filtro.nuSecExp) params.set('nuSecExp', filtro.nuSecExp);
  if (filtro.jobId) params.set('jobId', String(filtro.jobId));
  if (filtro.pagina) params.set('pagina', String(filtro.pagina));

  return apiJson(`/api/rag/documentos?${params}`, 'listar los documentos');
}

export interface ResultadoReparacion {
  documento: DocumentoRag;
  /** Fallo transitorio: el documento ya volvió a 'pendiente' y se reintentará solo. */
  mensaje?: string;
  /** Superó el tiempo de espera; la conversión sigue corriendo en segundo plano. */
  enCurso?: boolean;
}

/** Reintenta UN documento ahora mismo — no espera al próximo barrido ni encola un job. */
export function reintentarDocumento(id: number): Promise<ResultadoReparacion> {
  return apiJson(`/api/rag/documentos/${id}/reintentar`, 'reintentar el documento', { method: 'POST' });
}

/**
 * Último recurso manual: extrae el texto con IA de visión (consume tokens de OpenAI). Solo tiene
 * sentido sobre documentos "sin texto" o "con error" — el backend rechaza cualquier otro caso.
 */
export function extraerConVision(id: number): Promise<{ documento: DocumentoRag }> {
  return apiJson(`/api/rag/documentos/${id}/vision`, 'extraer el texto con IA', { method: 'POST' });
}

/**
 * Reparación masiva de documentos "sin archivo", "sin texto" y en "error" — solo generación y los
 * conversores locales (con su respaldo), nunca la extracción con IA de pago.
 */
export function iniciarIngestaReparacion(filtro: FiltroIngesta = {}): Promise<{ jobId: number }> {
  return apiJson('/api/rag/ingesta/reparacion', 'iniciar la reparación', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filtro),
  });
}

/**
 * Reintenta documentos largos atascados en un estado terminal (`error`, `sin_texto`) o que siguen
 * `pendiente` — el troceo por bloques se aplica igual desde cualquier job; este solo selecciona
 * los que la conversión normal ya no vuelve a alcanzar.
 */
export function iniciarIngestaLargos(filtro: FiltroIngesta = {}): Promise<{ jobId: number }> {
  return apiJson('/api/rag/ingesta/largos', 'iniciar la conversión de documentos largos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filtro),
  });
}

export interface MarkdownDocumento {
  markdown: string;
  chars: number;
  metodo: string | null;
  truncado: boolean;
}

export function fetchMarkdownDocumento(id: number): Promise<MarkdownDocumento> {
  return apiJson(`/api/rag/documentos/${id}/markdown`, 'obtener el markdown del documento');
}

export function activarBarrido(activo: boolean): Promise<{ ok: true }> {
  return apiJson('/api/rag/config/rag.barrido.activo', 'cambiar el interruptor del barrido', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ valor: activo }),
  });
}

/** Funciona aunque el interruptor esté apagado: gobierna la automatización, no la capacidad. */
export function barrerAhora(): Promise<{ documentosNuevos: number; documentosBaja: number }> {
  return apiJson('/api/rag/barrer', 'ejecutar el barrido', { method: 'POST' });
}

export function activarRetencion(activo: boolean): Promise<{ ok: true }> {
  return apiJson('/api/rag/config/rag.retencion.activa', 'cambiar el interruptor de retención', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ valor: activo }),
  });
}

export function activarGC(activo: boolean): Promise<{ ok: true }> {
  return apiJson('/api/rag/config/rag.gc.activo', 'cambiar el interruptor del recolector de basura', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ valor: activo }),
  });
}

/** Funciona aunque el interruptor esté apagado — igual que "Barrer ahora". */
export function ejecutarRetencionAhora(): Promise<{ loginIntento: number; usoToken: number; retrievalLog: number }> {
  return apiJson('/api/rag/mantenimiento/retencion', 'ejecutar la retención', { method: 'POST' });
}

export function ejecutarGcAhora(): Promise<{ marcados: number; recolectados: number; chunksBorrados: number }> {
  return apiJson('/api/rag/mantenimiento/gc', 'ejecutar el recolector de basura', { method: 'POST' });
}

export function fetchModelos(): Promise<ModeloEmbedding[]> {
  return apiJson('/api/rag/modelos', 'obtener los modelos de embedding');
}

export function activarModelo(id: number): Promise<{ ok: true }> {
  return apiJson(`/api/rag/modelos/${id}/activar`, 'activar el modelo', { method: 'PUT' });
}

export interface FiltroIngesta {
  limite?: number;
  /** Acota el job a un solo expediente. Ambos o ninguno — nunca uno solo. */
  nuAnnExp?: string;
  nuSecExp?: string;
  /** Acota el job a estos documentos exactos — un documento suelto o una selección del modal. */
  documentoIds?: number[];
}

/** Disponible hoy: markitdown no necesita API key. */
export function iniciarIngestaConversion(filtro: FiltroIngesta = {}): Promise<{ jobId: number }> {
  return apiJson('/api/rag/ingesta/conversion', 'iniciar la ingesta de conversión', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filtro),
  });
}

/** Bloqueado hasta configurar un proveedor de embeddings y activar un modelo. */
export function iniciarIngestaEmbeddings(filtro: FiltroIngesta = {}): Promise<{ jobId: number }> {
  return apiJson('/api/rag/ingesta/embeddings', 'iniciar la ingesta de embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filtro),
  });
}

export function fetchJob(jobId: number): Promise<JobIngesta> {
  return apiJson(`/api/rag/ingesta/${jobId}`, 'consultar el trabajo de ingesta');
}

export function fetchJobs(): Promise<JobIngesta[]> {
  return apiJson('/api/rag/ingesta', 'obtener los trabajos recientes');
}

/** Pausa un job de conversión/reparación en curso — resumable con `reanudarJobIngesta`. */
export function pausarJobIngesta(jobId: number): Promise<JobIngesta> {
  return apiJson(`/api/rag/ingesta/${jobId}/pausar`, 'pausar el trabajo', { method: 'POST' });
}

export function reanudarJobIngesta(jobId: number): Promise<JobIngesta> {
  return apiJson(`/api/rag/ingesta/${jobId}/reanudar`, 'reanudar el trabajo', { method: 'POST' });
}

/** Detiene definitivamente un job — a diferencia de pausar, no se puede reanudar después. */
export function cancelarJobIngesta(jobId: number): Promise<JobIngesta> {
  return apiJson(`/api/rag/ingesta/${jobId}/cancelar`, 'detener el trabajo', { method: 'POST' });
}
