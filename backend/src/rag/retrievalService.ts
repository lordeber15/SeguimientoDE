import { QueryTypes } from 'sequelize';
import { appSequelize } from '../config/appDatabase';
import { crearEmbeddingProvider } from '../ai/providerFactory';
import { estimarTokens } from './chunkService';
import { modeloActivo, tablaVectores } from './embeddingModelService';
import { getDocumentosExpediente } from '../services/documentoService';

/**
 * Retrieval híbrido (vectorial + full-text español) para el chat sobre el corpus RAG.
 *
 * Ver docs/PLAN-RAG.md §9: fusión por RRF (los embeddings son malos con identificadores
 * literales — oficios, DNIs, expedientes — y el FTS es malo con paráfrasis), tope de chunks por
 * documento, y el filtro de permisos SOBRE `documento`, nunca sobre `chunk` (con el ~13% de
 * contenido compartido por sha256, filtrar el chunk equivocado puede dejar pasar o tapar el
 * documento equivocado).
 */

const K_RRF = 60;
const LIMITE_RAMA = 50;
const LIMITE_RESULTADO = 20;
const TOPE_POR_DOCUMENTO = 3;
/**
 * Bajo este número de candidatos ya filtrados, se fuerza escaneo exacto en vez de HNSW: con un
 * filtro muy selectivo (un solo expediente, pocas dependencias), el grafo HNSW puede devolver
 * mucho menos de `k` SIN error — la respuesta sale incompleta pero plausible. Ver PLAN-RAG.md §9.
 */
const UMBRAL_ESCANEO_EXACTO = 2000;

export interface FiltroAcceso {
  /** `null` = sin restricción (admin/jefe ven todo). Si no, `co_dep_emi` exigido en `rag.documento`. */
  coDependencia: string | null;
}

export interface ChunkRecuperado {
  chunkId: number;
  texto: string;
  rutaTitulos: string | null;
  ord: number;
  sha256: string;
  score: number;
}

export interface ResultadoBusqueda {
  chunks: ChunkRecuperado[];
  candidatosVec: number;
  candidatosFts: number;
  escaneoExacto: boolean;
}

interface FilaVec { chunk_id: number }
interface FilaFts { chunk_id: number }
interface FilaFusionada {
  chunk_id: number;
  score: number;
  texto: string;
  ruta_titulos: string | null;
  ord: number;
  sha256: string;
}

/**
 * Recupera los chunks más relevantes para `consultaTexto`, ya filtrados por permisos.
 *
 * Si no hay modelo de embedding activo (o su dimensión ya no coincide con el proveedor
 * configurado — arrastre de `.env`), la rama vectorial se omite sin error: el resultado es FTS
 * puro. Es intencional (D8 aplicado aquí): el chat debe funcionar hoy mismo, sin ninguna clave,
 * aunque peor que con retrieval híbrido completo.
 */
export async function buscarHibrido(
  consultaTexto: string,
  filtro: FiltroAcceso,
): Promise<ResultadoBusqueda> {
  const modelo = await modeloActivo();
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
      // Dimensión distinta = el `.env` cambió sin desactivar el modelo. No es este el lugar para
      // resolverlo (el guardarraíl de arranque ya avisa); aquí basta con no mezclar espacios.
    } catch {
      // Proveedor caído: igual que "sin modelo activo", se degrada a FTS puro en vez de romper el chat.
      vecLiteral = null;
    }
  }

  return appSequelize.transaction(async (tx) => {
    const permisoSql = 'AND ($1::text IS NULL OR d.co_dep_emi = $1)';

    let filasVec: FilaVec[] = [];
    if (vecLiteral && tabla) {
      filasVec = await appSequelize.query<FilaVec>(
        `SELECT c.id AS chunk_id
           FROM rag.${tabla} e
           JOIN rag.chunk c ON c.id = e.chunk_id
          WHERE e.modelo_id = $2
            AND EXISTS (
              SELECT 1 FROM rag.documento d
               WHERE d.contenido_sha256 = c.sha256 AND d.vigente ${permisoSql}
            )
          ORDER BY e.vec <=> $3::vector
          LIMIT ${LIMITE_RAMA}`,
        { bind: [filtro.coDependencia, modeloId, vecLiteral], type: QueryTypes.SELECT, transaction: tx },
      );
    }

    const filasFts = await appSequelize.query<FilaFts>(
      `SELECT c.id AS chunk_id
         FROM rag.chunk c, plainto_tsquery('es_unaccent', $2) AS consulta
        WHERE c.tsv @@ consulta
          AND EXISTS (
            SELECT 1 FROM rag.documento d
             WHERE d.contenido_sha256 = c.sha256 AND d.vigente ${permisoSql}
          )
        ORDER BY ts_rank_cd(c.tsv, consulta) DESC
        LIMIT ${LIMITE_RAMA}`,
      { bind: [filtro.coDependencia, consultaTexto], type: QueryTypes.SELECT, transaction: tx },
    );

    const escaneoExacto = filasVec.length + filasFts.length < UMBRAL_ESCANEO_EXACTO;
    // Sin índice HNSW todavía (0 embeddings reales hoy), la rama vectorial ya es exacta por
    // definición. El guardarraíl queda listo para cuando exista uno: bajo el umbral, se
    // desactiva el uso de índices para forzar el escaneo exacto en esta transacción.
    if (escaneoExacto) {
      await appSequelize.query('SET LOCAL enable_indexscan = off', { transaction: tx });
    } else {
      await appSequelize.query("SET LOCAL hnsw.iterative_scan = 'relaxed_order'", { transaction: tx });
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

    const filasChunk = await appSequelize.query<FilaFusionada>(
      `SELECT id AS chunk_id, texto, ruta_titulos, ord, sha256
         FROM rag.chunk WHERE id = ANY($1::bigint[])`,
      { bind: [puntuados.map((p) => p.chunkId)], type: QueryTypes.SELECT, transaction: tx },
    );
    const porId = new Map(filasChunk.map((f) => [f.chunk_id, f]));

    // Tope de 3 chunks por documento de origen (sha256): un expediente de 80 páginas no debe
    // llenar el contexto entero con fragmentos del mismo documento.
    const porSha = new Map<string, number>();
    const chunks: ChunkRecuperado[] = [];
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

export interface DocumentoCitado {
  id: number;
  nuAnn: string;
  nuEmi: string;
  /** 0 = documento principal (centinela de la migración 004), >0 = anexo con ese nu_ane literal. */
  nuAne: number;
}

/**
 * Documento accesible por el que se cita un chunk (nunca solo el chunk_id: ver comentario de
 * cabecera). Trae también `nu_ann/nu_emi/nu_ane`: sin ellos el frontend no puede abrir el
 * documento real desde la cita — reutiliza el mismo `rutaDocumento`/`rutaAnexo` que ya usa el
 * visor de Seguimiento, no una URL nueva. Si varios documentos accesibles comparten el mismo
 * contenido, se prefiere uno del expediente en curso (modo expediente) y, si no, el de emisión
 * más reciente — arbitrario pero determinista.
 */
export async function elegirDocumentoParaCita(
  sha256: string,
  filtro: FiltroAcceso,
  expedienteEnCurso?: { nuAnnExp: string; nuSecExp: string },
): Promise<DocumentoCitado | null> {
  const filas = await appSequelize.query<{ id: number; nu_ann: string; nu_emi: string; nu_ane: number }>(
    `SELECT d.id, d.nu_ann, d.nu_emi, d.nu_ane
       FROM rag.documento d
      WHERE d.contenido_sha256 = $1
        AND d.vigente
        AND ($2::text IS NULL OR d.co_dep_emi = $2)
      ORDER BY (d.nu_ann_exp = $3 AND d.nu_sec_exp = $4) DESC, d.fe_emi DESC NULLS LAST
      LIMIT 1`,
    {
      bind: [
        sha256,
        filtro.coDependencia,
        expedienteEnCurso?.nuAnnExp ?? null,
        expedienteEnCurso?.nuSecExp ?? null,
      ],
      type: QueryTypes.SELECT,
    },
  );
  const fila = filas[0];
  return fila ? { id: fila.id, nuAnn: fila.nu_ann, nuEmi: fila.nu_emi, nuAne: fila.nu_ane } : null;
}

export interface LineaTiempo {
  fecha: string | null;
  tipoDocumento: string | null;
  numeroDocumento: string | null;
  asunto: string | null;
  dependenciaEmisora: string | null;
  dependenciaDestino: string | null;
  estado: string | null;
}

/**
 * "¿En qué estado está el expediente?" es una respuesta ESTRUCTURADA (línea de tiempo por SQL),
 * no un chunk recuperado — mezclar ambos es lo que separa un chat útil de un buscador semántico
 * con adornos (PLAN-RAG.md §9). Reusa `getDocumentosExpediente`, que ya arma exactamente esta
 * cronología para el PDF unificado: no se reimplementa.
 */
export async function estadoExpediente(nuAnnExp: string, nuSecExp: string): Promise<LineaTiempo[]> {
  const documentos = await getDocumentosExpediente(nuAnnExp, nuSecExp);
  return documentos.map((d) => ({
    fecha: d.fechaEmision,
    tipoDocumento: d.tipoDocumento,
    numeroDocumento: d.numeroDocumento,
    asunto: d.asunto,
    dependenciaEmisora: d.dependenciaEmisora,
    dependenciaDestino: d.dependenciaDestino,
    estado: d.estado,
  }));
}

export interface EstadoIngestaExpediente {
  total: number;
  listos: number;
  convertidos: number;
  pendientes: number;
  sinTexto: number;
  error: number;
  noSoportado: number;
  /** `true` solo si hay al menos un documento y todos están `estado='ok'` (convertido + con embedding). */
  completo: boolean;
}

export interface EstadoIngestaConClave extends EstadoIngestaExpediente {
  nuAnnExp: string;
  nuSecExp: string;
}

/**
 * Cobertura de ingesta de un lote de expedientes, en vivo — a propósito no reusa los contadores
 * cacheados de `rag.expediente` (`docs_ingestados`/`docs_pendientes`), porque
 * `refrescarContadores()` (`barridoService.ts`) solo corre dentro del ciclo de barrido: con el
 * barrido apagado (su modo por defecto) esos contadores pueden quedar desactualizados minutos u
 * horas después de generar embeddings a mano desde el panel. Para avisar justo antes de chatear
 * (o de pintar el badge de una tabla), una cifra vieja sería peor que no avisar nada.
 *
 * `estado='ok'` (ver `ingestaService.marcarDocumentosCompletos`) es el único estado que significa
 * "convertido en chunks Y con embedding generado" — la señal correcta de "listo para el chat".
 *
 * Devuelve una entrada por cada par pedido, en el mismo orden y con el mismo `nuAnnExp`/`nuSecExp`
 * tal cual se pasaron (no lo que reporte la BD): un expediente sin ninguna fila en `rag.documento`
 * vuelve con todo en cero — "sin indexar" es un estado legítimo que hay que poder pintar, no una
 * ausencia silenciosa que el llamador tenga que adivinar.
 */
export async function estadoIngestaExpedientes(
  pares: { nuAnnExp: string; nuSecExp: string }[],
): Promise<EstadoIngestaConClave[]> {
  if (pares.length === 0) return [];

  // Dedup antes de bindear: si el llamador repite un par, la consulta no debe hacer el trabajo dos
  // veces (aunque el resultado sería el mismo, GROUP BY ya lo colapsaría).
  const unicos = new Map(pares.map((p) => [`${p.nuAnnExp}|${p.nuSecExp}`, p]));
  const anns = [...unicos.values()].map((p) => p.nuAnnExp);
  const secs = [...unicos.values()].map((p) => p.nuSecExp);

  const filas = await appSequelize.query<{
    ann: string; sec: string; total: string; listos: string; convertidos: string;
    pendientes: string; sin_texto: string; error: string; no_soportado: string;
  }>(
    `SELECT nu_ann_exp AS ann, nu_sec_exp AS sec,
            count(*)::text AS total,
            count(*) FILTER (WHERE estado = 'ok')::text AS listos,
            count(*) FILTER (WHERE estado = 'convertido')::text AS convertidos,
            count(*) FILTER (WHERE estado IN ('pendiente','en_proceso'))::text AS pendientes,
            count(*) FILTER (WHERE estado = 'sin_texto')::text AS sin_texto,
            count(*) FILTER (WHERE estado = 'error')::text AS error,
            count(*) FILTER (WHERE estado = 'no_soportado')::text AS no_soportado
       FROM rag.documento
      WHERE vigente
        AND (nu_ann_exp, nu_sec_exp) IN (SELECT unnest($1::text[]), unnest($2::text[]))
      GROUP BY nu_ann_exp, nu_sec_exp`,
    { bind: [anns, secs], type: QueryTypes.SELECT },
  );

  const porClave = new Map(filas.map((f) => [`${f.ann}|${f.sec}`, f]));

  return [...unicos.values()].map((p) => {
    const fila = porClave.get(`${p.nuAnnExp}|${p.nuSecExp}`);
    const total = Number(fila?.total ?? 0);
    const listos = Number(fila?.listos ?? 0);
    return {
      nuAnnExp: p.nuAnnExp,
      nuSecExp: p.nuSecExp,
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

export async function estadoIngestaExpediente(
  nuAnnExp: string,
  nuSecExp: string,
): Promise<EstadoIngestaExpediente> {
  const [estado] = await estadoIngestaExpedientes([{ nuAnnExp, nuSecExp }]);
  return estado;
}

export interface ExpedienteEncontradoChat {
  nuAnnExp: string;
  nuSecExp: string;
  /** Número visible del SGD (`numero_sgd`). `null` si el barrido nunca lo trajo. */
  numeroExpediente: string | null;
  documentos: number;
  ingestados: number;
}

const LIMITE_BUSQUEDA_EXPEDIENTE = 20;

/**
 * Busca expedientes por su número visible del SGD (`DE000020260000062`, `OGAUL020260000058`,
 * `2026-0000325`) para el chat: el prefijo varía de largo según la dependencia, así que ese número
 * NO se puede partir en (año, secuencia) sin consultar — hay que resolverlo contra la BD.
 *
 * Se busca en `rag.expediente` (BD propia) y no en el SGD: es el conjunto sobre el que el chat
 * puede responder algo, y no obliga a que el usuario tenga `seguimiento.ver`.
 *
 * `par` lo resuelve el controlador cuando el término YA es un par año-secuencia (`2026-325`). Cubre
 * los expedientes que el barrido no recorrió todavía o cuyo `numero_sgd` quedó en NULL, que si no
 * serían inalcanzables desde aquí — es el mismo acceso directo que daban las dos casillas de antes.
 */
export async function buscarExpedientes(
  termino: string,
  par: { nuAnnExp: string; nuSecExp: string } | null,
): Promise<ExpedienteEncontradoChat[]> {
  // Los comodines de LIKE que el usuario haya tecleado se escapan para que se busquen literales, no
  // patrones — el bind ya cubre la inyección, esto es solo semántica de búsqueda. (Mismo escapado
  // que `buscarExpedientePorNumero` en services/seguimientoService.ts, sobre la otra BD.)
  const escapado = termino.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

  const filas = await appSequelize.query<{
    nuAnnExp: string; nuSecExp: string; numeroExpediente: string | null;
    documentos: number; ingestados: number;
  }>(
    `SELECT nu_ann_exp AS "nuAnnExp", nu_sec_exp AS "nuSecExp", numero_sgd AS "numeroExpediente",
            doc_count_sgd AS "documentos", docs_ingestados AS "ingestados"
       FROM rag.expediente
      WHERE numero_sgd ILIKE '%' || $1 || '%' ESCAPE '\\'
         OR (nu_ann_exp = $2 AND nu_sec_exp = $3 AND numero_sgd IS NULL)
      ORDER BY (nu_ann_exp = $2 AND nu_sec_exp = $3) DESC,
               nu_ann_exp DESC, nu_sec_exp DESC
      LIMIT $4`,
    {
      // Con `par = null` esa rama del OR queda en NULL — nunca `true`, así que no aporta filas.
      bind: [escapado, par?.nuAnnExp ?? null, par?.nuSecExp ?? null, LIMITE_BUSQUEDA_EXPEDIENTE],
      type: QueryTypes.SELECT,
    },
  );

  // `nu_sec_exp` es texto con ceros a la izquierda: el orden lexicográfico ya coincide con el
  // numérico, y los contadores vuelven como number desde columnas `integer`.
  return filas.map((f) => ({
    nuAnnExp: f.nuAnnExp,
    nuSecExp: f.nuSecExp,
    numeroExpediente: f.numeroExpediente,
    documentos: Number(f.documentos),
    ingestados: Number(f.ingestados),
  }));
}

/** Recorta chunks al presupuesto de tokens del prompt, en orden de score (ya vienen ordenados). */
export function recortarPorPresupuesto(chunks: ChunkRecuperado[], presupuestoTokens: number): ChunkRecuperado[] {
  const resultado: ChunkRecuperado[] = [];
  let usado = 0;
  for (const c of chunks) {
    const tokens = estimarTokens(c.texto);
    if (usado + tokens > presupuestoTokens && resultado.length > 0) break;
    resultado.push(c);
    usado += tokens;
  }
  return resultado;
}
