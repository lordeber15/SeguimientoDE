import { QueryTypes } from 'sequelize';
import { stdRagSequelize } from '../config/stdRagDatabase';
import {
  embeddingsDisponibles,
  proveedorChatConfigurado,
  proveedorEmbeddingConfigurado,
  revisarConfiguracionIA,
  visionDisponible,
} from '../../../compartido/ai/providerFactory';
import {
  proveedorConversionActivo,
  proveedorRespaldo,
  type ProveedorConversion,
} from '../../../compartido/rag/conversionProviderService';
import { estadoCircuito, markitdownDisponible } from '../../../compartido/rag/mdConvertService';
import { estadoCircuitoMinerU, mineruDisponible } from '../../../compartido/rag/mineruConvertService';
import { leerBooleano, leerNumero } from '../../../compartido/rag/configService';

/**
 * Todo lo que necesita el panel admin del STD (`std.gestionar`), en el mismo espíritu que
 * `modulos/sgd/rag/estadoService.ts`, reescrito contra `std_rag`. Los proveedores de conversión
 * (markitdown/MinerU) son infraestructura de proceso COMPARTIDA con el SGD (`compartido/rag/*`:
 * el circuito y la caché de disponibilidad viven en memoria del propio proceso Node, no por base
 * de datos), así que se consultan tal cual, sin duplicar estado.
 */

export interface EstadoCorpusStd {
  documentos: {
    total: number;
    ok: number;
    convertidos: number;
    pendientes: number;
    sinTexto: number;
    error: number;
    noSoportado: number;
  };
  documentosStd: { total: number; completos: number };
  contenido: { unicos: number; convertidos: number; chunks: number; caracteres: number };
  embeddings: { vectores: number; chunksSinEmbedding: number };
  cobertura: { conversionPct: number; embeddingPct: number };
}

export async function estadoCorpusStd(): Promise<EstadoCorpusStd> {
  const [docs] = await stdRagSequelize.query<{
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

  const [docStd] = await stdRagSequelize.query<{ total: string; completos: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE docs_pendientes = 0 AND docs_ingestados > 0)::text AS completos
       FROM rag.documento_std`,
    { type: QueryTypes.SELECT },
  );

  const [cont] = await stdRagSequelize.query<{
    unicos: string; convertidos: string; chunks: string; caracteres: string;
  }>(
    `SELECT count(*)::text AS unicos,
            count(*) FILTER (WHERE markdown IS NOT NULL)::text AS convertidos,
            COALESCE(sum(chunks_generados),0)::text AS chunks,
            COALESCE(sum(chars),0)::text AS caracteres
       FROM rag.contenido`,
    { type: QueryTypes.SELECT },
  );

  // Solo los vectores del modelo ACTIVO: los de modelos anteriores siguen guardados y, sumados,
  // daban más del 100%.
  const [emb] = await stdRagSequelize.query<{ vectores: string; sin_embedding: string }>(
    `SELECT (
       (SELECT count(*) FROM rag.embedding_1024 WHERE modelo_id = m.id)
       + (SELECT count(*) FROM rag.embedding_1536 WHERE modelo_id = m.id)
       + (SELECT count(*) FROM rag.embedding_h3072 WHERE modelo_id = m.id)
     )::text AS vectores,
     (SELECT count(*) FROM rag.chunk)::text AS sin_embedding
       FROM (SELECT (SELECT id FROM rag.embedding_model WHERE activo LIMIT 1) AS id) m`,
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
    documentosStd: { total: Number(docStd.total), completos: Number(docStd.completos) },
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

export interface FiltroDocumentosStd {
  estado?: string;
  q?: string;
  idDocumento?: number;
  jobId?: number;
  pagina?: number;
  porPagina?: number;
}

export interface ListaDocumentosStd {
  total: number;
  pagina: number;
  porPagina: number;
  items: DocumentoRagStd[];
}

const ESTADOS_VALIDOS = new Set([
  'pendiente', 'en_proceso', 'convertido', 'ok', 'sin_texto', 'error', 'omitido', 'no_soportado',
]);

interface FilaDocumentoRagStd {
  id: string; id_adjunto: string; id_documento: string; nro_std: string | null;
  origen: 'principal' | 'anexo' | 'derivacion'; documento: string | null; tipo_doc: string | null;
  asunto: string | null; estado: string; motivo_error: string | null; intentos: number;
  chars: number | null; chunks_generados: number | null; metodo: string | null;
  estado_item: string | null; motivo_error_item: string | null;
}

function filaADocumentoRagStd(f: FilaDocumentoRagStd): DocumentoRagStd {
  return {
    id: Number(f.id),
    idAdjunto: Number(f.id_adjunto),
    idDocumento: Number(f.id_documento),
    nroStd: f.nro_std,
    origen: f.origen,
    documento: f.documento,
    tipoDoc: f.tipo_doc,
    asunto: f.asunto,
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

export async function listarDocumentosStd(filtro: FiltroDocumentosStd): Promise<ListaDocumentosStd> {
  const condiciones = ['d.vigente'];
  const binds: unknown[] = [];
  const joins = ['LEFT JOIN rag.contenido c ON c.sha256 = d.contenido_sha256'];
  let selectItem = 'NULL::text AS estado_item, NULL::text AS motivo_error_item';
  let orden = 'd.id DESC';

  if (filtro.jobId) {
    binds.push(filtro.jobId);
    joins.push(`JOIN rag.ingest_item i ON i.documento_id = d.id AND i.job_id = $${binds.length}`);
    selectItem = 'i.estado AS estado_item, i.motivo_error AS motivo_error_item';
    orden = 'i.id ASC';
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
    condiciones.push(`(d.documento ILIKE $${binds.length} ESCAPE '\\' OR d.asunto ILIKE $${binds.length} ESCAPE '\\')`);
  }

  if (filtro.idDocumento) {
    binds.push(filtro.idDocumento);
    condiciones.push(`d.id_documento = $${binds.length}`);
  }

  const pagina = Math.max(1, filtro.pagina ?? 1);
  const porPagina = Math.min(200, Math.max(1, filtro.porPagina ?? 50));
  const where = condiciones.join(' AND ');
  const joinSql = joins.join('\n       ');

  const [{ total }] = await stdRagSequelize.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM rag.documento d ${joinSql} WHERE ${where}`,
    { bind: binds, type: QueryTypes.SELECT },
  );

  binds.push(porPagina, (pagina - 1) * porPagina);
  const items = await stdRagSequelize.query<FilaDocumentoRagStd>(
    `SELECT d.id, d.id_adjunto, d.id_documento, d.nro_std, d.origen, d.documento, d.tipo_doc, d.asunto,
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
    items: items.map(filaADocumentoRagStd),
  };
}

/** Una fila suelta de `rag.documento` — para refrescar una fila de la lista tras una acción manual. */
export async function documentoPorIdStd(id: number): Promise<DocumentoRagStd | null> {
  const [fila] = await stdRagSequelize.query<FilaDocumentoRagStd>(
    `SELECT d.id, d.id_adjunto, d.id_documento, d.nro_std, d.origen, d.documento, d.tipo_doc, d.asunto,
            d.estado, d.motivo_error, d.intentos,
            c.chars, c.chunks_generados, c.metodo,
            NULL::text AS estado_item, NULL::text AS motivo_error_item
       FROM rag.documento d
       LEFT JOIN rag.contenido c ON c.sha256 = d.contenido_sha256
      WHERE d.id = $1 AND d.vigente`,
    { bind: [id], type: QueryTypes.SELECT },
  );
  return fila ? filaADocumentoRagStd(fila) : null;
}

export async function markdownDocumentoStd(
  documentoId: number,
): Promise<{ markdown: string; chars: number; metodo: string | null; truncado: boolean } | null> {
  const [fila] = await stdRagSequelize.query<{ markdown: string | null; chars: number; metodo: string | null }>(
    `SELECT c.markdown, c.chars, c.metodo
       FROM rag.documento d
       JOIN rag.contenido c ON c.sha256 = d.contenido_sha256
      WHERE d.id = $1`,
    { bind: [documentoId], type: QueryTypes.SELECT },
  );
  if (!fila || fila.markdown === null) return null;

  const LIMITE = 20_000;
  const truncado = fila.markdown.length > LIMITE;
  return {
    markdown: truncado ? fila.markdown.slice(0, LIMITE) : fila.markdown,
    chars: fila.chars,
    metodo: fila.metodo,
    truncado,
  };
}

export interface EstadoBarridoStd {
  activo: boolean;
  cadenciaMin: number;
  ultimo: {
    id: number;
    tipo: string;
    disparo: string;
    feInicio: string;
    feFin: string | null;
    documentosRevisados: number;
    documentosNuevos: number;
    documentosCambiados: number;
    error: string | null;
  } | null;
  horasDesdeUltimo: number | null;
}

export async function estadoBarridoStd(): Promise<EstadoBarridoStd> {
  const [ultimo] = await stdRagSequelize.query<{
    id: number; tipo: string; disparo: string; fe_inicio: string; fe_fin: string | null;
    expedientes_revisados: number; documentos_nuevos: number; documentos_cambiados: number;
    error: string | null; horas: number | null;
  }>(
    `SELECT id, tipo, disparo, fe_inicio::text, fe_fin::text,
            expedientes_revisados, documentos_nuevos, documentos_cambiados, error,
            EXTRACT(EPOCH FROM (now() - fe_inicio))/3600 AS horas
       FROM rag.barrido ORDER BY fe_inicio DESC LIMIT 1`,
    { type: QueryTypes.SELECT },
  );

  return {
    activo: await leerBooleano('rag.barrido.activo', false, stdRagSequelize),
    cadenciaMin: await leerNumero('rag.barrido.cadencia_min', 1440, stdRagSequelize),
    ultimo: ultimo
      ? {
          id: ultimo.id,
          tipo: ultimo.tipo,
          disparo: ultimo.disparo,
          feInicio: ultimo.fe_inicio,
          feFin: ultimo.fe_fin,
          // La columna se llama igual que en el SGD (`expedientes_revisados`): aquí cuenta
          // "documentos del STD revisados" — ver el comentario de la migración `001_std_rag.sql`.
          documentosRevisados: ultimo.expedientes_revisados,
          documentosNuevos: ultimo.documentos_nuevos,
          documentosCambiados: ultimo.documentos_cambiados,
          error: ultimo.error,
        }
      : null,
    horasDesdeUltimo: ultimo?.horas != null ? Math.round(ultimo.horas * 10) / 10 : null,
  };
}

export interface EstadoProveedoresStd {
  embedding: { proveedor: string; disponible: boolean; motivo: string | null };
  chat: { proveedor: string };
  vision: { proveedor: string; disponible: boolean; motivo: string | null };
  problemas: { variable: string; mensaje: string }[];
  markitdown: { disponible: boolean; circuitoAbierto: boolean };
  mineru: { disponible: boolean; circuitoAbierto: boolean };
  conversion: { proveedorActivo: ProveedorConversion; proveedorRespaldo: ProveedorConversion | null };
}

export async function estadoProveedoresStd(): Promise<EstadoProveedoresStd> {
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

export async function consumoTokensStd(): Promise<{
  hoy: { proveedor: string; modelo: string; operacion: string; tokensIn: number; tokensOut: number; costeUsd: number }[];
  acumulado: { tokensIn: number; tokensOut: number; costeUsd: number };
}> {
  const hoy = await stdRagSequelize.query<{
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

  const [total] = await stdRagSequelize.query<{ tokens_in: string; tokens_out: string; coste: string }>(
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

export interface EstadoMantenimientoStd {
  retencion: {
    activa: boolean;
    dias: number;
    ultimo: { feInicio: string; filasAfectadas: number } | null;
  };
  gc: {
    activo: boolean;
    graciaDias: number;
    ultimo: { feInicio: string; filasAfectadas: number } | null;
    huerfanosPendientes: number;
  };
}

export async function estadoMantenimientoStd(): Promise<EstadoMantenimientoStd> {
  const [ultimoRetencion] = await stdRagSequelize.query<{ fe_inicio: string; filas_afectadas: number }>(
    `SELECT fe_inicio::text, filas_afectadas FROM rag.mantenimiento
      WHERE tipo = 'retencion' AND error IS NULL ORDER BY fe_inicio DESC LIMIT 1`,
    { type: QueryTypes.SELECT },
  );
  const [ultimoGc] = await stdRagSequelize.query<{ fe_inicio: string; filas_afectadas: number }>(
    `SELECT fe_inicio::text, filas_afectadas FROM rag.mantenimiento
      WHERE tipo = 'gc' AND error IS NULL ORDER BY fe_inicio DESC LIMIT 1`,
    { type: QueryTypes.SELECT },
  );
  const [{ huerfanos }] = await stdRagSequelize.query<{ huerfanos: string }>(
    `SELECT count(*)::text AS huerfanos FROM rag.contenido WHERE fe_huerfano IS NOT NULL`,
    { type: QueryTypes.SELECT },
  );

  return {
    retencion: {
      activa: await leerBooleano('rag.retencion.activa', true, stdRagSequelize),
      dias: await leerNumero('rag.retencion.dias', 180, stdRagSequelize),
      ultimo: ultimoRetencion
        ? { feInicio: ultimoRetencion.fe_inicio, filasAfectadas: ultimoRetencion.filas_afectadas }
        : null,
    },
    gc: {
      activo: await leerBooleano('rag.gc.activo', false, stdRagSequelize),
      graciaDias: await leerNumero('rag.gc.gracia_dias', 30, stdRagSequelize),
      ultimo: ultimoGc
        ? { feInicio: ultimoGc.fe_inicio, filasAfectadas: ultimoGc.filas_afectadas }
        : null,
      huerfanosPendientes: Number(huerfanos),
    },
  };
}

export interface EvaluacionRetrievalStd {
  ventanaDias: number;
  totalConsultas: number;
  sinResultados: number;
  conAlucinaciones: number;
  escaneoExactoPct: number;
  msPromedio: number;
}

export async function evaluacionRetrievalStd(dias = 7): Promise<EvaluacionRetrievalStd> {
  const [fila] = await stdRagSequelize.query<{
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

/** Documentos del STD con su porcentaje de carga, para el listado del panel. */
export async function coberturaPorDocumentoStd(limite = 50) {
  return stdRagSequelize.query(
    `SELECT id_documento AS "idDocumento", documento,
            adjuntos_pdf_std AS "adjuntosPdf", docs_ingestados AS "ingestados",
            docs_pendientes AS "pendientes", docs_sin_texto AS "sinTexto",
            fe_ultimo_barrido::text AS "feUltimoBarrido",
            fe_ultimo_embedding::text AS "feUltimoEmbedding",
            CASE WHEN adjuntos_pdf_std > 0
                 THEN round(100.0 * docs_ingestados / adjuntos_pdf_std, 1)
                 ELSE 0 END AS "porcentaje"
       FROM rag.documento_std
      ORDER BY docs_pendientes DESC, adjuntos_pdf_std DESC
      LIMIT $1`,
    { bind: [Math.min(limite, 500)], type: QueryTypes.SELECT },
  );
}
