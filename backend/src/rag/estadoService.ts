import { QueryTypes } from 'sequelize';
import { appSequelize } from '../config/appDatabase';
import { embeddingsDisponibles, proveedorChatConfigurado, proveedorEmbeddingConfigurado, revisarConfiguracionIA, visionDisponible } from '../ai/providerFactory';
import {
  proveedorConversionActivo,
  proveedorRespaldo,
  type ProveedorConversion,
} from './conversionProviderService';
import { estadoCircuito, markitdownDisponible } from './mdConvertService';
import { estadoCircuitoMinerU, mineruDisponible } from './mineruConvertService';
import { leerBooleano, leerNumero } from './configService';

/** Todo lo que necesita el panel de ingesta, en una sola consulta por bloque. */

export interface EstadoCorpus {
  documentos: {
    total: number;
    ok: number;
    convertidos: number;
    pendientes: number;
    sinTexto: number;
    error: number;
    noSoportado: number;
  };
  expedientes: { total: number; completos: number };
  contenido: { unicos: number; convertidos: number; chunks: number; caracteres: number };
  embeddings: { vectores: number; chunksSinEmbedding: number };
  cobertura: { conversionPct: number; embeddingPct: number };
}

export async function estadoCorpus(): Promise<EstadoCorpus> {
  const [docs] = await appSequelize.query<{
    total: string; ok: string; convertidos: string; pendientes: string;
    sin_texto: string; error: string; no_soportado: string;
  }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE estado='ok')::text AS ok,
            count(*) FILTER (WHERE estado='convertido')::text AS convertidos,
            count(*) FILTER (WHERE estado IN ('pendiente','en_proceso'))::text AS pendientes,
            count(*) FILTER (WHERE estado='sin_texto')::text AS sin_texto,
            count(*) FILTER (WHERE estado='error')::text AS error,
            count(*) FILTER (WHERE estado='no_soportado')::text AS no_soportado
       FROM rag.documento WHERE vigente`,
    { type: QueryTypes.SELECT },
  );

  const [exp] = await appSequelize.query<{ total: string; completos: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE docs_pendientes = 0 AND docs_ingestados > 0)::text AS completos
       FROM rag.expediente`,
    { type: QueryTypes.SELECT },
  );

  const [cont] = await appSequelize.query<{
    unicos: string; convertidos: string; chunks: string; caracteres: string;
  }>(
    `SELECT count(*)::text AS unicos,
            count(*) FILTER (WHERE markdown IS NOT NULL)::text AS convertidos,
            COALESCE(sum(chunks_generados),0)::text AS chunks,
            COALESCE(sum(chars),0)::text AS caracteres
       FROM rag.contenido`,
    { type: QueryTypes.SELECT },
  );

  // Los vectores viven en tres tablas según la dimensión del modelo.
  const [emb] = await appSequelize.query<{ vectores: string; sin_embedding: string }>(
    `SELECT (
       (SELECT count(*) FROM rag.embedding_1024)
       + (SELECT count(*) FROM rag.embedding_1536)
       + (SELECT count(*) FROM rag.embedding_h3072)
     )::text AS vectores,
     (SELECT count(*) FROM rag.chunk)::text AS sin_embedding`,
    { type: QueryTypes.SELECT },
  );

  const totalDocs = Number(docs.total);
  const procesados = Number(docs.ok) + Number(docs.convertidos) + Number(docs.sin_texto);
  const chunks = Number(cont.chunks);
  const vectores = Number(emb.vectores);

  return {
    documentos: {
      total: totalDocs,
      ok: Number(docs.ok),
      convertidos: Number(docs.convertidos),
      pendientes: Number(docs.pendientes),
      sinTexto: Number(docs.sin_texto),
      error: Number(docs.error),
      noSoportado: Number(docs.no_soportado),
    },
    expedientes: { total: Number(exp.total), completos: Number(exp.completos) },
    contenido: {
      unicos: Number(cont.unicos),
      convertidos: Number(cont.convertidos),
      chunks,
      caracteres: Number(cont.caracteres),
    },
    embeddings: {
      vectores,
      chunksSinEmbedding: Math.max(0, Number(emb.sin_embedding) - vectores),
    },
    cobertura: {
      conversionPct: totalDocs > 0 ? Math.round((procesados / totalDocs) * 1000) / 10 : 0,
      embeddingPct: chunks > 0 ? Math.round((vectores / chunks) * 1000) / 10 : 0,
    },
  };
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
  /** Solo cuando se filtra por `jobId`: qué pasó con este documento EN ESE trabajo puntual —
   *  puede diferir del `estado` actual si el documento se reprocesó después en otro trabajo. */
  estadoItem: string | null;
  motivoErrorItem: string | null;
}

export interface FiltroDocumentos {
  estado?: string;
  q?: string;
  nuAnnExp?: string;
  nuSecExp?: string;
  /** Acota la lista a los documentos que formaron parte de este trabajo de ingesta puntual. */
  jobId?: number;
  pagina?: number;
  porPagina?: number;
}

export interface ListaDocumentos {
  total: number;
  pagina: number;
  porPagina: number;
  items: DocumentoRag[];
}

const ESTADOS_VALIDOS = new Set([
  'pendiente', 'en_proceso', 'convertido', 'ok', 'sin_texto', 'error', 'omitido', 'no_soportado',
]);

interface FilaDocumentoRag {
  id: string; nu_ann: string; nu_emi: string; nu_ane: number; titulo: string | null;
  tipo_doc: string | null; asunto: string | null; nu_ann_exp: string | null; nu_sec_exp: string | null;
  numero_sgd: string | null; estado: string; motivo_error: string | null; intentos: number;
  chars: number | null; chunks_generados: number | null; metodo: string | null;
  estado_item: string | null; motivo_error_item: string | null;
}

/** Comparte el mapeo con `documentoPorId` para que la lista y una fila suelta nunca diverjan de forma. */
function filaADocumentoRag(f: FilaDocumentoRag): DocumentoRag {
  return {
    id: Number(f.id),
    nuAnn: f.nu_ann,
    nuEmi: f.nu_emi,
    nuAne: f.nu_ane,
    titulo: f.titulo,
    tipoDoc: f.tipo_doc,
    asunto: f.asunto,
    nuAnnExp: f.nu_ann_exp,
    nuSecExp: f.nu_sec_exp,
    numeroExpediente: f.numero_sgd,
    estado: f.estado,
    motivoError: f.motivo_error,
    intentos: f.intentos,
    chars: f.chars,
    chunksGenerados: f.chunks_generados,
    metodo: f.metodo,
    estadoItem: f.estado_item,
    motivoErrorItem: f.motivo_error_item,
  };
}

/**
 * Lista documentos individuales de `rag.documento` — hasta hoy solo existían contadores
 * agregados (`estadoCorpus`). Sirve para revisar manualmente cuáles quedaron vacíos o con error,
 * no solo saber cuántos.
 */
export async function listarDocumentos(filtro: FiltroDocumentos): Promise<ListaDocumentos> {
  const condiciones = ['d.vigente'];
  const binds: unknown[] = [];
  const joins = [
    'LEFT JOIN rag.contenido c ON c.sha256 = d.contenido_sha256',
    'LEFT JOIN rag.expediente e ON e.nu_ann_exp = d.nu_ann_exp AND e.nu_sec_exp = d.nu_sec_exp',
  ];
  // Sin `jobId`, no hay ítem de ingesta al que referirse — se devuelve NULL con el mismo alias
  // para que la forma de la fila no dependa del filtro.
  let selectItem = 'NULL::text AS estado_item, NULL::text AS motivo_error_item';
  let orden = 'd.id DESC';

  if (filtro.jobId) {
    // INNER JOIN a propósito: acota la lista a solo los documentos que ESE trabajo tocó, que es
    // justo lo que responde "a qué archivos se refiere el contador 373/500 del panel".
    binds.push(filtro.jobId);
    joins.push(`JOIN rag.ingest_item i ON i.documento_id = d.id AND i.job_id = $${binds.length}`);
    selectItem = 'i.estado AS estado_item, i.motivo_error AS motivo_error_item';
    orden = 'i.id ASC'; // orden de cola: coincide con el avance real del trabajo
  }

  if (filtro.estado) {
    if (!ESTADOS_VALIDOS.has(filtro.estado)) {
      throw new RangeError(`Estado inválido: ${filtro.estado}`);
    }
    binds.push(filtro.estado);
    condiciones.push(`d.estado = $${binds.length}`);
  }

  if (filtro.q?.trim()) {
    binds.push(`%${filtro.q.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`);
    condiciones.push(`(d.titulo ILIKE $${binds.length} ESCAPE '\\' OR d.asunto ILIKE $${binds.length} ESCAPE '\\')`);
  }

  if (filtro.nuAnnExp && filtro.nuSecExp) {
    binds.push(filtro.nuAnnExp, filtro.nuSecExp);
    condiciones.push(`d.nu_ann_exp = $${binds.length - 1} AND d.nu_sec_exp = $${binds.length}`);
  }

  const pagina = Math.max(1, filtro.pagina ?? 1);
  const porPagina = Math.min(200, Math.max(1, filtro.porPagina ?? 50));
  const where = condiciones.join(' AND ');
  const joinSql = joins.join('\n       ');

  const [{ total }] = await appSequelize.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM rag.documento d ${joinSql} WHERE ${where}`,
    { bind: binds, type: QueryTypes.SELECT },
  );

  binds.push(porPagina, (pagina - 1) * porPagina);
  const items = await appSequelize.query<FilaDocumentoRag>(
    `SELECT d.id, d.nu_ann, d.nu_emi, d.nu_ane, d.titulo, d.tipo_doc, d.asunto,
            d.nu_ann_exp, d.nu_sec_exp, e.numero_sgd,
            d.estado, d.motivo_error, d.intentos,
            c.chars, c.chunks_generados, c.metodo,
            ${selectItem}
       FROM rag.documento d
       ${joinSql}
      WHERE ${where}
      ORDER BY ${orden}
      LIMIT $${binds.length - 1} OFFSET $${binds.length}`,
    { bind: binds, type: QueryTypes.SELECT },
  );

  return {
    total: Number(total),
    pagina,
    porPagina,
    items: items.map(filaADocumentoRag),
  };
}

/** Una fila suelta de `rag.documento` — para refrescar una fila de la lista tras una acción manual. */
export async function documentoPorId(id: number): Promise<DocumentoRag | null> {
  const [fila] = await appSequelize.query<FilaDocumentoRag>(
    `SELECT d.id, d.nu_ann, d.nu_emi, d.nu_ane, d.titulo, d.tipo_doc, d.asunto,
            d.nu_ann_exp, d.nu_sec_exp, e.numero_sgd,
            d.estado, d.motivo_error, d.intentos,
            c.chars, c.chunks_generados, c.metodo,
            NULL::text AS estado_item, NULL::text AS motivo_error_item
       FROM rag.documento d
       LEFT JOIN rag.contenido c ON c.sha256 = d.contenido_sha256
       LEFT JOIN rag.expediente e ON e.nu_ann_exp = d.nu_ann_exp AND e.nu_sec_exp = d.nu_sec_exp
      WHERE d.id = $1 AND d.vigente`,
    { bind: [id], type: QueryTypes.SELECT },
  );
  return fila ? filaADocumentoRag(fila) : null;
}

/** El markdown convertido de un documento — para ver POR QUÉ quedó vacío o con error. */
export async function markdownDocumento(
  documentoId: number,
): Promise<{ markdown: string; chars: number; metodo: string | null; truncado: boolean } | null> {
  const [fila] = await appSequelize.query<{ markdown: string | null; chars: number; metodo: string | null }>(
    `SELECT c.markdown, c.chars, c.metodo
       FROM rag.documento d
       JOIN rag.contenido c ON c.sha256 = d.contenido_sha256
      WHERE d.id = $1`,
    { bind: [documentoId], type: QueryTypes.SELECT },
  );
  if (!fila || fila.markdown === null) return null;

  // Hay markdown de cientos de KB (documentos unificados grandes) — de vuelta solo un prefijo
  // generoso; el objetivo es diagnosticar por qué quedó vacío o con error, no leer el documento
  // entero desde aquí.
  const LIMITE = 20_000;
  const truncado = fila.markdown.length > LIMITE;
  return {
    markdown: truncado ? fila.markdown.slice(0, LIMITE) : fila.markdown,
    chars: fila.chars,
    metodo: fila.metodo,
    truncado,
  };
}

export interface EstadoBarrido {
  activo: boolean;
  cadenciaMin: number;
  cadenciaHashMin: number;
  ultimo: {
    id: number;
    tipo: string;
    disparo: string;
    feInicio: string;
    feFin: string | null;
    expedientesRevisados: number;
    documentosNuevos: number;
    documentosCambiados: number;
    documentosBaja: number;
    error: string | null;
  } | null;
  /**
   * Horas desde el último barrido. El panel lo necesita para avisar de que las cifras son
   * historia y no estado: con el barrido apagado —que es el modo por defecto— un `% cargado` de
   * hace tres semanas se ve exactamente igual que uno de hace tres minutos.
   */
  horasDesdeUltimo: number | null;
}

export async function estadoBarrido(): Promise<EstadoBarrido> {
  const [ultimo] = await appSequelize.query<{
    id: number; tipo: string; disparo: string; fe_inicio: string; fe_fin: string | null;
    expedientes_revisados: number; documentos_nuevos: number; documentos_cambiados: number;
    documentos_baja: number; error: string | null; horas: number | null;
  }>(
    `SELECT id, tipo, disparo, fe_inicio::text, fe_fin::text,
            expedientes_revisados, documentos_nuevos, documentos_cambiados, documentos_baja, error,
            EXTRACT(EPOCH FROM (now() - fe_inicio))/3600 AS horas
       FROM rag.barrido ORDER BY fe_inicio DESC LIMIT 1`,
    { type: QueryTypes.SELECT },
  );

  return {
    activo: await leerBooleano('rag.barrido.activo'),
    cadenciaMin: await leerNumero('rag.barrido.cadencia_min', 15),
    cadenciaHashMin: await leerNumero('rag.barrido.cadencia_hash_min', 10080),
    ultimo: ultimo
      ? {
          id: ultimo.id,
          tipo: ultimo.tipo,
          disparo: ultimo.disparo,
          feInicio: ultimo.fe_inicio,
          feFin: ultimo.fe_fin,
          expedientesRevisados: ultimo.expedientes_revisados,
          documentosNuevos: ultimo.documentos_nuevos,
          documentosCambiados: ultimo.documentos_cambiados,
          documentosBaja: ultimo.documentos_baja,
          error: ultimo.error,
        }
      : null,
    horasDesdeUltimo: ultimo?.horas != null ? Math.round(ultimo.horas * 10) / 10 : null,
  };
}

export interface EstadoProveedores {
  embedding: { proveedor: string; disponible: boolean; motivo: string | null };
  chat: { proveedor: string };
  vision: { proveedor: string; disponible: boolean; motivo: string | null };
  problemas: { variable: string; mensaje: string }[];
  markitdown: { disponible: boolean; circuitoAbierto: boolean };
  mineru: { disponible: boolean; circuitoAbierto: boolean };
  /** `proveedorRespaldo` es el conversor que se intenta si el activo falla — `null` si el
   *  fallback está desactivado (`RAG_CONVERTER_FALLBACK=ninguno`). */
  conversion: { proveedorActivo: ProveedorConversion; proveedorRespaldo: ProveedorConversion | null };
}

export async function estadoProveedores(): Promise<EstadoProveedores> {
  const embed = embeddingsDisponibles();
  const vision = visionDisponible();
  const circuito = estadoCircuito();
  const circuitoMinerU = estadoCircuitoMinerU();

  return {
    embedding: {
      proveedor: proveedorEmbeddingConfigurado(),
      disponible: embed.disponible,
      motivo: embed.motivo,
    },
    chat: { proveedor: proveedorChatConfigurado() },
    vision: { proveedor: 'openai', disponible: vision.disponible, motivo: vision.motivo },
    problemas: revisarConfiguracionIA(),
    markitdown: {
      disponible: await markitdownDisponible(),
      circuitoAbierto: circuito.abierto,
    },
    mineru: {
      disponible: await mineruDisponible(),
      circuitoAbierto: circuitoMinerU.abierto,
    },
    conversion: {
      proveedorActivo: proveedorConversionActivo(),
      proveedorRespaldo: proveedorRespaldo(),
    },
  };
}

export async function consumoTokens(): Promise<{
  hoy: { proveedor: string; modelo: string; operacion: string; tokensIn: number; tokensOut: number; costeUsd: number }[];
  acumulado: { tokensIn: number; tokensOut: number; costeUsd: number };
}> {
  const hoy = await appSequelize.query<{
    proveedor: string; modelo: string; operacion: string;
    tokens_in: string; tokens_out: string; coste: string;
  }>(
    `SELECT proveedor, modelo, operacion,
            sum(tokens_in)::text AS tokens_in, sum(tokens_out)::text AS tokens_out,
            COALESCE(sum(coste_usd),0)::text AS coste
       FROM rag.uso_token WHERE fe >= date_trunc('day', now())
      GROUP BY 1,2,3 ORDER BY 1,2,3`,
    { type: QueryTypes.SELECT },
  );

  const [total] = await appSequelize.query<{ tokens_in: string; tokens_out: string; coste: string }>(
    `SELECT COALESCE(sum(tokens_in),0)::text AS tokens_in,
            COALESCE(sum(tokens_out),0)::text AS tokens_out,
            COALESCE(sum(coste_usd),0)::text AS coste
       FROM rag.uso_token`,
    { type: QueryTypes.SELECT },
  );

  return {
    hoy: hoy.map((f) => ({
      proveedor: f.proveedor,
      modelo: f.modelo,
      operacion: f.operacion,
      tokensIn: Number(f.tokens_in),
      tokensOut: Number(f.tokens_out),
      costeUsd: Number(f.coste),
    })),
    acumulado: {
      tokensIn: Number(total.tokens_in),
      tokensOut: Number(total.tokens_out),
      costeUsd: Number(total.coste),
    },
  };
}

export interface EstadoMantenimiento {
  retencion: {
    activa: boolean;
    dias: number;
    ultimo: { feInicio: string; filasAfectadas: number } | null;
  };
  gc: {
    activo: boolean;
    graciaDias: number;
    ultimo: { feInicio: string; filasAfectadas: number } | null;
    /** Contenidos ya marcados huérfanos, dentro o fuera del margen de gracia todavía. */
    huerfanosPendientes: number;
  };
}

/** Estado del mantenimiento periódico (Fase 6, PLAN-RAG.md §6.6 y riesgo #12). */
export async function estadoMantenimiento(): Promise<EstadoMantenimiento> {
  const [ultimoRetencion] = await appSequelize.query<{ fe_inicio: string; filas_afectadas: number }>(
    `SELECT fe_inicio::text, filas_afectadas FROM rag.mantenimiento
      WHERE tipo = 'retencion' AND error IS NULL ORDER BY fe_inicio DESC LIMIT 1`,
    { type: QueryTypes.SELECT },
  );
  const [ultimoGc] = await appSequelize.query<{ fe_inicio: string; filas_afectadas: number }>(
    `SELECT fe_inicio::text, filas_afectadas FROM rag.mantenimiento
      WHERE tipo = 'gc' AND error IS NULL ORDER BY fe_inicio DESC LIMIT 1`,
    { type: QueryTypes.SELECT },
  );
  const [{ huerfanos }] = await appSequelize.query<{ huerfanos: string }>(
    `SELECT count(*)::text AS huerfanos FROM rag.contenido WHERE fe_huerfano IS NOT NULL`,
    { type: QueryTypes.SELECT },
  );

  return {
    retencion: {
      activa: await leerBooleano('rag.retencion.activa', true),
      dias: await leerNumero('rag.retencion.dias', 180),
      ultimo: ultimoRetencion
        ? { feInicio: ultimoRetencion.fe_inicio, filasAfectadas: ultimoRetencion.filas_afectadas }
        : null,
    },
    gc: {
      activo: await leerBooleano('rag.gc.activo', false),
      graciaDias: await leerNumero('rag.gc.gracia_dias', 30),
      ultimo: ultimoGc
        ? { feInicio: ultimoGc.fe_inicio, filasAfectadas: ultimoGc.filas_afectadas }
        : null,
      huerfanosPendientes: Number(huerfanos),
    },
  };
}

export interface EvaluacionRetrieval {
  ventanaDias: number;
  totalConsultas: number;
  sinResultados: number;
  conAlucinaciones: number;
  escaneoExactoPct: number;
  msPromedio: number;
}

/**
 * Agregados sobre `rag.retrieval_log` para detectar recall roto en silencio (riesgo #6): consultas
 * que no devolvieron nada, respuestas con marcadores inventados, y cuánto se está forzando el
 * escaneo exacto (guardarraíl de HNSW, Fase 5) sobre el total.
 */
export async function evaluacionRetrieval(dias = 7): Promise<EvaluacionRetrieval> {
  const [fila] = await appSequelize.query<{
    total: string; sin_resultados: string; con_alucinaciones: string;
    escaneo_exacto_pct: string | null; ms_promedio: string | null;
  }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE candidatos_vec = 0 AND candidatos_fts = 0)::text AS sin_resultados,
            count(*) FILTER (WHERE marcadores_alucinados > 0)::text AS con_alucinaciones,
            round(100.0 * count(*) FILTER (WHERE escaneo_exacto) / GREATEST(count(*), 1), 1)::text AS escaneo_exacto_pct,
            round(avg(ms))::text AS ms_promedio
       FROM rag.retrieval_log WHERE fe > now() - ($1 || ' days')::interval`,
    { bind: [dias], type: QueryTypes.SELECT },
  );

  return {
    ventanaDias: dias,
    totalConsultas: Number(fila?.total ?? 0),
    sinResultados: Number(fila?.sin_resultados ?? 0),
    conAlucinaciones: Number(fila?.con_alucinaciones ?? 0),
    escaneoExactoPct: Number(fila?.escaneo_exacto_pct ?? 0),
    msPromedio: Number(fila?.ms_promedio ?? 0),
  };
}

/** Expedientes con su porcentaje de carga, para el listado del panel. */
export async function coberturaPorExpediente(limite = 50) {
  return appSequelize.query(
    `SELECT nu_ann_exp AS "nuAnnExp", nu_sec_exp AS "nuSecExp", numero_sgd AS "numeroSgd",
            doc_count_sgd AS "documentos", docs_ingestados AS "ingestados",
            docs_pendientes AS "pendientes", docs_sin_texto AS "sinTexto",
            fe_ultimo_barrido::text AS "feUltimoBarrido",
            fe_ultimo_embedding::text AS "feUltimoEmbedding",
            CASE WHEN doc_count_sgd > 0
                 THEN round(100.0 * docs_ingestados / doc_count_sgd, 1)
                 ELSE 0 END AS "porcentaje"
       FROM rag.expediente
      ORDER BY docs_pendientes DESC, doc_count_sgd DESC
      LIMIT $1`,
    { bind: [Math.min(limite, 500)], type: QueryTypes.SELECT },
  );
}
