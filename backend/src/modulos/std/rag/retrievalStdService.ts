import { QueryTypes } from 'sequelize';
import { stdRagSequelize } from '../config/stdRagDatabase';
import { consultarStd } from '../config/stdDatabase';
import { crearEmbeddingProvider } from '../../../compartido/ai/providerFactory';
import { estimarTokens } from '../../../compartido/rag/chunkService';
import { modeloActivo, tablaVectores } from '../../../compartido/rag/embeddingModelService';

/**
 * Retrieval híbrido (vectorial + full-text español) sobre `std_rag`, equivalente a
 * `modulos/sgd/rag/retrievalService.ts` pero SIN filtro de permisos: el plan aprobado restringe
 * todo el módulo STD (chat y panel) al rol `admin` vía `std.consultar`/`std.gestionar` (migración
 * `016_std_permisos.sql`), así que no hace falta repetir aquí un filtro por dependencia que el STD
 * ni siquiera modela (ver la skill `std-database`, §7: no hay un equivalente real a `co_dep_emi`).
 *
 * Lo que sí tiene equivalente real es el filtro opcional por documento (`id_documento`, el "N°
 * STD"): el modo "chat por documento" no debe mezclar fragmentos de otros documentos del corpus.
 *
 * Misma fusión por RRF, mismo tope de 3 chunks por documento de origen y mismo guardarraíl de
 * escaneo exacto bajo el umbral — ver los comentarios del original en `retrievalService.ts` para
 * el razonamiento completo (PLAN-RAG.md §9); no se repiten aquí.
 */

const K_RRF = 60;
const LIMITE_RAMA = 50;
const LIMITE_RESULTADO = 20;
const TOPE_POR_DOCUMENTO = 3;
const UMBRAL_ESCANEO_EXACTO = 2000;

export interface ChunkRecuperadoStd {
  chunkId: number;
  texto: string;
  rutaTitulos: string | null;
  ord: number;
  sha256: string;
  score: number;
}

export interface ResultadoBusquedaStd {
  chunks: ChunkRecuperadoStd[];
  candidatosVec: number;
  candidatosFts: number;
  escaneoExacto: boolean;
}

interface FilaVec { chunk_id: number }
interface FilaFts { chunk_id: number }
interface FilaFusionada {
  chunk_id: number;
  texto: string;
  ruta_titulos: string | null;
  ord: number;
  sha256: string;
}

export async function buscarHibridoStd(
  consultaTexto: string,
  /** Chat "Por documento": solo chunks de ESTE N° STD. Sin él, se busca en todo el corpus. */
  idDocumento?: number,
  /** Conjunto activo de la conversación (docs/PLAN-CHAT-CONSULTAS.md, Fase 7): solo esos N° STD. */
  conjunto?: number[],
  /** Términos del planificador con sus alternativas ("a|b"): la rama FTS los busca en OR, porque la
   *  consulta reescrita completa es demasiado estricta para plainto_tsquery. */
  terminosFts?: string[],
): Promise<ResultadoBusquedaStd> {
  const modelo = await modeloActivo(stdRagSequelize);
  let vecLiteral: string | null = null;
  let modeloId: number | null = null;
  let tabla: string | null = null;

  if (modelo) {
    try {
      const provider = crearEmbeddingProvider();
      if (provider.dimension === modelo.dimension) {
        const { vectores } = await provider.embeber([consultaTexto]);
        vecLiteral = `[${vectores[0].join(',')}]`;
        modeloId = modelo.id;
        tabla = tablaVectores(modelo.dimension);
      }
    } catch {
      vecLiteral = null;
    }
  }

  return stdRagSequelize.transaction(async (tx) => {
    const filtroDocSql = (i: number) =>
      `AND ($${i}::bigint IS NULL OR d.id_documento = $${i}) AND ($${i + 1}::bigint[] IS NULL OR d.id_documento = ANY($${i + 1}::bigint[]))`;
    const idDoc = idDocumento ?? null;
    const ids = conjunto && conjunto.length > 0 ? conjunto : null;

    let filasVec: FilaVec[] = [];
    if (vecLiteral && tabla) {
      filasVec = await stdRagSequelize.query<FilaVec>(
        `SELECT c.id AS chunk_id
           FROM rag.${tabla} e
           JOIN rag.chunk c ON c.id = e.chunk_id
          WHERE e.modelo_id = $1
            AND EXISTS (
              SELECT 1 FROM rag.documento d
               WHERE d.contenido_sha256 = c.sha256 AND d.vigente ${filtroDocSql(3)}
            )
          ORDER BY e.vec <=> $2::vector
          LIMIT ${LIMITE_RAMA}`,
        { bind: [modeloId, vecLiteral, idDoc, ids], type: QueryTypes.SELECT, transaction: tx },
      );
    }

    const filasFts = await stdRagSequelize.query<FilaFts>(
      `SELECT c.id AS chunk_id
         FROM rag.chunk c,
              COALESCE(
                (SELECT NULLIF(string_agg(NULLIF(rag.tsq_alternativas(t)::text, ''), ' | '), '')::tsquery
                   FROM unnest($4::text[]) AS t),
                plainto_tsquery('es_unaccent', $1)
              ) AS consulta
        WHERE c.tsv @@ consulta
          AND EXISTS (
            SELECT 1 FROM rag.documento d
             WHERE d.contenido_sha256 = c.sha256 AND d.vigente ${filtroDocSql(2)}
          )
        ORDER BY ts_rank_cd(c.tsv, consulta) DESC
        LIMIT ${LIMITE_RAMA}`,
      { bind: [consultaTexto, idDoc, ids, terminosFts && terminosFts.length > 0 ? terminosFts : null], type: QueryTypes.SELECT, transaction: tx },
    );

    const escaneoExacto = filasVec.length + filasFts.length < UMBRAL_ESCANEO_EXACTO;
    if (escaneoExacto) {
      await stdRagSequelize.query('SET LOCAL enable_indexscan = off', { transaction: tx });
    } else {
      await stdRagSequelize.query("SET LOCAL hnsw.iterative_scan = 'relaxed_order'", { transaction: tx });
    }

    const rangoVec = new Map(filasVec.map((f, i) => [f.chunk_id, i + 1]));
    const rangoFts = new Map(filasFts.map((f, i) => [f.chunk_id, i + 1]));
    const idsUnicos = [...new Set([...rangoVec.keys(), ...rangoFts.keys()])];

    if (idsUnicos.length === 0) {
      return { chunks: [], candidatosVec: filasVec.length, candidatosFts: filasFts.length, escaneoExacto };
    }

    const puntuados = idsUnicos
      .map((chunkId) => ({
        chunkId,
        score:
          (rangoVec.has(chunkId) ? 1 / (K_RRF + rangoVec.get(chunkId)!) : 0)
          + (rangoFts.has(chunkId) ? 1 / (K_RRF + rangoFts.get(chunkId)!) : 0),
      }))
      .sort((a, b) => b.score - a.score);

    const filasChunk = await stdRagSequelize.query<FilaFusionada>(
      `SELECT id AS chunk_id, texto, ruta_titulos, ord, sha256
         FROM rag.chunk WHERE id = ANY($1::bigint[])`,
      { bind: [puntuados.map((p) => p.chunkId)], type: QueryTypes.SELECT, transaction: tx },
    );
    const porId = new Map(filasChunk.map((f) => [f.chunk_id, f]));

    const porSha = new Map<string, number>();
    const chunks: ChunkRecuperadoStd[] = [];
    for (const p of puntuados) {
      const fila = porId.get(p.chunkId);
      if (!fila) continue;
      const usados = porSha.get(fila.sha256) ?? 0;
      if (usados >= TOPE_POR_DOCUMENTO) continue;
      porSha.set(fila.sha256, usados + 1);

      chunks.push({
        chunkId: fila.chunk_id,
        texto: fila.texto,
        rutaTitulos: fila.ruta_titulos,
        ord: fila.ord,
        sha256: fila.sha256,
        score: p.score,
      });
      if (chunks.length >= LIMITE_RESULTADO) break;
    }

    return { chunks, candidatosVec: filasVec.length, candidatosFts: filasFts.length, escaneoExacto };
  });
}

export interface DocumentoCitadoStd {
  id: number;
  idAdjunto: number;
  idDocumento: number;
  nroStd: string | null;
  origen: 'principal' | 'anexo' | 'derivacion';
}

/**
 * Documento accesible por el que se cita un chunk — igual razón que `elegirDocumentoParaCita` del
 * SGD (nunca citar solo el `chunk_id`: con deduplicación por sha256, varios adjuntos físicos
 * pueden compartir el mismo contenido). Sin filtro de permisos (ver cabecera del archivo). Si hay
 * un documento en curso (modo "por documento"), se prefiere un adjunto de ESE N° STD.
 */
export async function elegirDocumentoParaCitaStd(
  sha256: string,
  idDocumentoEnCurso?: number,
): Promise<DocumentoCitadoStd | null> {
  const filas = await stdRagSequelize.query<{
    id: number; id_adjunto: number; id_documento: number; nro_std: string | null;
    origen: 'principal' | 'anexo' | 'derivacion';
  }>(
    `SELECT d.id, d.id_adjunto, d.id_documento, d.nro_std, d.origen
       FROM rag.documento d
      WHERE d.contenido_sha256 = $1 AND d.vigente
      ORDER BY (d.id_documento = $2::bigint) DESC, d.fecha DESC NULLS LAST
      LIMIT 1`,
    { bind: [sha256, idDocumentoEnCurso ?? null], type: QueryTypes.SELECT },
  );
  const fila = filas[0];
  return fila
    ? { id: fila.id, idAdjunto: fila.id_adjunto, idDocumento: fila.id_documento, nroStd: fila.nro_std, origen: fila.origen }
    : null;
}

/** Metadatos mínimos de un adjunto ya conocido por el RAG (visor de citas) — ver `archivoControllerStd`. */
export async function documentoPorIdAdjunto(
  idAdjunto: number,
): Promise<{ idAdjunto: number; idDocumento: number; nombreArchivo: string | null; mime: string | null } | null> {
  const filas = await stdRagSequelize.query<{
    id_adjunto: number; id_documento: number; nombre_archivo: string | null; mime: string | null;
  }>(
    `SELECT id_adjunto, id_documento, nombre_archivo, mime FROM rag.documento WHERE id_adjunto = $1 LIMIT 1`,
    { bind: [idAdjunto], type: QueryTypes.SELECT },
  );
  const fila = filas[0];
  return fila
    ? { idAdjunto: fila.id_adjunto, idDocumento: fila.id_documento, nombreArchivo: fila.nombre_archivo, mime: fila.mime }
    : null;
}

export interface MovimientoLineaTiempoStd {
  idDocumentoMov: number;
  creado: string | null;
  areaOrigen: string | null;
  remitente: string | null;
  areaDestino: string | null;
  destinatario: string | null;
  accion: string | null;
  estado: string | null;
  observacion: string | null;
  copia: 'SI' | 'NO';
}

export interface ReferenciaDocumentoStd {
  idDocumentoRef: number;
  tipoDocumento: string | null;
  documento: string | null;
  asunto: string | null;
  remitente: string | null;
}

export interface LineaTiempoDocumentoStd {
  movimientos: MovimientoLineaTiempoStd[];
  referencias: ReferenciaDocumentoStd[];
}

/**
 * Línea de tiempo de un documento del STD — en MariaDB, nunca en `std_rag` (el STD no tiene
 * expediente propio en el RAG: su "estado" vive siempre en el sistema origen). Mismo SQL que
 * `SELECT_DOCUMENTO_MOV` del PHP legado (ver la skill `std-database`, §6), sin las columnas de
 * semáforo/alerta (cálculo de UI, no aporta nada al prompt del chat), más las referencias entre
 * documentos (`tbl_documento_referencia`).
 */
export async function lineaTiempoStd(idDocumento: number): Promise<LineaTiempoDocumentoStd> {
  const [movimientos, referencias] = await Promise.all([
    consultarStd<{
      id_documento_mov: number; creado: string | null; area_origen: string | null; remitente: string | null;
      area_destino: string | null; destinatario: string | null; accion: string | null; estado: string | null;
      observacion: string | null; copia: 'SI' | 'NO';
    }>(
      `SELECT
           a.id_documento_mov, a.creado,
           a1.area AS area_origen, b.nombre AS remitente,
           a2.area AS area_destino, c.nombre AS destinatario,
           d.accion, a.observaciones AS observacion,
           e.estado,
           IF(a.flg_copia=1,'SI','NO') AS copia
         FROM tbl_documento_mov a
           JOIN tbl_persona b ON a.id_origen = b.id_persona
           LEFT JOIN tbl_area a1 ON a1.id_area = a.id_area_origen
           JOIN tbl_persona c ON a.id_destino = c.id_persona
           LEFT JOIN tbl_area a2 ON a2.id_area = a.id_area_destino
           JOIN tbl_accion d ON d.id_accion = a.id_accion
           JOIN tbl_estado e ON e.id_estado = a.id_estado
        WHERE a.id_documento = :idDocumento
        ORDER BY a.id_documento_mov ASC`,
      { idDocumento },
    ),
    consultarStd<{
      id_documento_ref: number; tipo_documento: string | null; documento: string | null;
      asunto: string | null; remitente: string | null;
    }>(
      `SELECT a.id_documento_ref, c.tipo_documento, b.documento, b.asunto, u.nombre AS remitente
         FROM tbl_documento_referencia a
           JOIN tbl_documento b ON a.id_documento_ref = b.id_documento
           JOIN tbl_tipo_documento c ON c.id_tipo_documento = b.id_tipo_documento
           LEFT JOIN tbl_persona u ON u.id_persona = b.id_remitente
        WHERE a.id_documento = :idDocumento`,
      { idDocumento },
    ),
  ]);

  return {
    movimientos: movimientos.map((m) => ({
      idDocumentoMov: m.id_documento_mov,
      creado: m.creado,
      areaOrigen: m.area_origen,
      remitente: m.remitente,
      areaDestino: m.area_destino,
      destinatario: m.destinatario,
      accion: m.accion,
      estado: m.estado,
      observacion: m.observacion,
      copia: m.copia,
    })),
    referencias: referencias.map((r) => ({
      idDocumentoRef: r.id_documento_ref,
      tipoDocumento: r.tipo_documento,
      documento: r.documento,
      asunto: r.asunto,
      remitente: r.remitente,
    })),
  };
}

export interface EstadoIngestaDocumentoStd {
  total: number;
  listos: number;
  convertidos: number;
  pendientes: number;
  sinTexto: number;
  error: number;
  noSoportado: number;
  completo: boolean;
}

export interface EstadoIngestaDocumentoConClave extends EstadoIngestaDocumentoStd {
  idDocumento: number;
}

/**
 * Cobertura de ingesta de un N° STD, en vivo — mismo motivo que `estadoIngestaExpedientes` del
 * SGD: los contadores cacheados en `rag.documento_std` solo se refrescan dentro del ciclo de
 * barrido (apagado por defecto), así que una lectura en vivo evita mostrar un badge desactualizado
 * justo después de generar embeddings a mano desde el panel.
 */
export async function estadoIngestaDocumentosStd(
  idsDocumento: number[],
): Promise<EstadoIngestaDocumentoConClave[]> {
  if (idsDocumento.length === 0) return [];
  const unicos = [...new Set(idsDocumento)];

  const filas = await stdRagSequelize.query<{
    id_documento: string; total: string; listos: string; convertidos: string;
    pendientes: string; sin_texto: string; error: string; no_soportado: string;
  }>(
    `SELECT id_documento,
            count(*)::text AS total,
            count(*) FILTER (WHERE estado = 'ok')::text AS listos,
            count(*) FILTER (WHERE estado = 'convertido')::text AS convertidos,
            count(*) FILTER (WHERE estado IN ('pendiente','en_proceso'))::text AS pendientes,
            count(*) FILTER (WHERE estado = 'sin_texto')::text AS sin_texto,
            count(*) FILTER (WHERE estado = 'error')::text AS error,
            count(*) FILTER (WHERE estado = 'no_soportado')::text AS no_soportado
       FROM rag.documento
      WHERE vigente AND id_documento = ANY($1::bigint[])
      GROUP BY id_documento`,
    { bind: [unicos], type: QueryTypes.SELECT },
  );

  const porId = new Map(filas.map((f) => [Number(f.id_documento), f]));

  return unicos.map((idDocumento) => {
    const fila = porId.get(idDocumento);
    const total = Number(fila?.total ?? 0);
    const listos = Number(fila?.listos ?? 0);
    return {
      idDocumento,
      total,
      listos,
      convertidos: Number(fila?.convertidos ?? 0),
      pendientes: Number(fila?.pendientes ?? 0),
      sinTexto: Number(fila?.sin_texto ?? 0),
      error: Number(fila?.error ?? 0),
      noSoportado: Number(fila?.no_soportado ?? 0),
      completo: total > 0 && listos === total,
    };
  });
}

export async function estadoIngestaDocumentoStd(idDocumento: number): Promise<EstadoIngestaDocumentoStd> {
  const [estado] = await estadoIngestaDocumentosStd([idDocumento]);
  return estado;
}

export interface DocumentoEncontradoChatStd {
  idDocumento: number;
  documento: string | null;
  adjuntosPdfStd: number;
  docsIngestados: number;
  docsPendientes: number;
}

const LIMITE_BUSQUEDA_DOCUMENTO = 20;

/**
 * Busca documentos del STD por su "N° STD" (`id_documento`) o por el número formal
 * (`tbl_documento.documento`, ej. "001-2020-MINEDU/..."), para el chat. Se busca en
 * `rag.documento_std` (la BD propia), no en vivo contra MariaDB: es el conjunto sobre el que el
 * chat puede responder algo — un documento del STD sin ningún PDF nunca llega a esta tabla (ver
 * `barridoStdService.ts`), y mostrarlo aquí sería prometer una conversación que no puede darse.
 */
export async function buscarDocumentosStd(termino: string): Promise<DocumentoEncontradoChatStd[]> {
  const escapado = termino.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  const comoNumero = /^\d+$/.test(termino.trim()) ? Number(termino.trim()) : null;

  const filas = await stdRagSequelize.query<{
    id_documento: string; documento: string | null; adjuntos_pdf_std: number;
    docs_ingestados: number; docs_pendientes: number;
  }>(
    `SELECT id_documento, documento, adjuntos_pdf_std, docs_ingestados, docs_pendientes
       FROM rag.documento_std
      WHERE documento ILIKE '%' || $1 || '%' ESCAPE '\\'
         OR ($2::bigint IS NOT NULL AND id_documento = $2)
      ORDER BY (id_documento = $2::bigint) DESC, id_documento DESC
      LIMIT $3`,
    { bind: [escapado, comoNumero, LIMITE_BUSQUEDA_DOCUMENTO], type: QueryTypes.SELECT },
  );

  return filas.map((f) => ({
    idDocumento: Number(f.id_documento),
    documento: f.documento,
    adjuntosPdfStd: Number(f.adjuntos_pdf_std),
    docsIngestados: Number(f.docs_ingestados),
    docsPendientes: Number(f.docs_pendientes),
  }));
}

export function recortarPorPresupuestoStd(
  chunks: ChunkRecuperadoStd[],
  presupuestoTokens: number,
): ChunkRecuperadoStd[] {
  const resultado: ChunkRecuperadoStd[] = [];
  let usado = 0;
  for (const c of chunks) {
    const tokens = estimarTokens(c.texto);
    if (usado + tokens > presupuestoTokens && resultado.length > 0) break;
    resultado.push(c);
    usado += tokens;
  }
  return resultado;
}
