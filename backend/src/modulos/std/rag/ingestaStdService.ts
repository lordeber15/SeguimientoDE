import crypto from 'crypto';
import { QueryTypes } from 'sequelize';
import { stdRagSequelize } from '../config/stdRagDatabase';
import { leerClaveAdjuntoStd, type OrigenAdjuntoStd } from '../services/stdDocumentoService';
import { ArchivoStdError, leerArchivoStd, limpiarMime } from '../services/stdStorageService';
import { crearEmbeddingProvider, embeddingsDisponibles } from '../../../compartido/ai/providerFactory';
import type { EmbeddingProvider } from '../../../compartido/ai/types';
import { ErrorIA } from '../../../compartido/ai/types';
import { contarPaginas } from '../../../compartido/services/pdfPaginasService';
import { construirCabecera, trocear, type Chunk } from '../../../compartido/rag/chunkService';
import { convertirPorBloques } from '../../../compartido/rag/conversionLargaService';
import {
  activarModelo as _activarModelo,
  crearIndiceHnsw,
  modeloActivo,
  registrarSiNoExiste,
  tablaVectores,
} from '../../../compartido/rag/embeddingModelService';
import type { AvanceFase, FaseConversion, ProveedorConversion, ReportarFase } from '../../../compartido/rag/fasesConversion';
import { conversionBloqueada, convertirAMarkdownActivo } from '../../../compartido/rag/conversionProviderService';
import { limpiarMarkdown } from '../../../compartido/rag/limpiezaService';
import { ConversionError } from '../../../compartido/rag/mdConvertService';

/**
 * Ingesta del STD: conversión + chunking + embeddings, sobre `std_rag`. Mismo "motor" que
 * `modulos/sgd/rag/ingestaService.ts` (mecánica de cola, lease, fases, troceo de documentos
 * largos) reescrito contra el esquema del STD en vez de duplicarlo con parámetros — las dos
 * implementaciones ya comparten todas las piezas sin estado (`compartido/rag/*`); lo que queda
 * aquí es la orquestación propia de CADA fuente de datos.
 *
 * Simplificaciones deliberadas frente al SGD, por ahora:
 *   - No hay "documento generado" (PROVEÍDO/HOJA DE ENVÍO): en el STD todo documento tiene un
 *     archivo subido de verdad; sin archivo es `no_soportado` sin más, no hay nada que reconstruir.
 *   - No hay extracción con IA de visión todavía (ver `modulos/sgd/rag/visionService.ts` — se
 *     añadirá igual si hace falta, es independiente del resto del pipeline).
 *   - No hay jobs de "reparación masiva" / "documentos largos sueltos" / "reintento sin archivo":
 *     son herramientas de recuperación para un corpus que ya pasó por una primera ingesta; se
 *     añadirán cuando haga falta, siguiendo el mismo patrón que sus equivalentes del SGD.
 */

export class IngestaStdError extends Error {
  readonly status: number;
  constructor(mensaje: string, status = 400) {
    super(mensaje);
    this.name = 'IngestaStdError';
    this.status = status;
  }
}

export interface FiltroIngestaStd {
  idDocumento?: number;
  documentoIds?: number[];
  /** Año de `rag.documento.fecha` — para priorizar lo reciente en un corpus de ~300 mil PDF. */
  anio?: number;
  origen?: OrigenAdjuntoStd;
  limite?: number;
}

export interface ProgresoJobStd {
  documentoId: number;
  titulo: string | null;
  desde: number;
  fase: FaseConversion;
  faseDesde: number;
  limiteMs: number | null;
  proveedor: ProveedorConversion | null;
  intento: number;
  intentos: number;
  motivoFallback: string | null;
  bloque: number | null;
  bloques: number | null;
  paginaDesde: number | null;
  paginaHasta: number | null;
}

const progresoEnVivo = new Map<number, ProgresoJobStd>();

function clave(jobId: number): number {
  return Number(jobId);
}

export function progresoJobStd(jobId: number): ProgresoJobStd | null {
  return progresoEnVivo.get(clave(jobId)) ?? null;
}

export function anotarFase(jobId: number, documentoId: number, avance: AvanceFase): void {
  const actual = progresoEnVivo.get(clave(jobId));
  if (!actual || actual.documentoId !== documentoId) return;

  progresoEnVivo.set(clave(jobId), {
    ...actual,
    fase: avance.fase,
    faseDesde: Date.now(),
    limiteMs: avance.limiteMs ?? null,
    proveedor: avance.proveedor ?? null,
    intento: avance.intento ?? actual.intento,
    intentos: avance.intentos ?? actual.intentos,
    motivoFallback: avance.motivoFallback ?? actual.motivoFallback,
    bloque: avance.bloque ?? null,
    bloques: avance.bloques ?? null,
    paginaDesde: avance.paginaDesde ?? null,
    paginaHasta: avance.paginaHasta ?? null,
  });
}

// ── Job de CONVERSIÓN ─────────────────────────────────────────────────────────

const MAX_INTENTOS_SIN_ARCHIVO = 10;
const MAX_INTENTOS_CONVERSION = Number(process.env.RAG_MAX_INTENTOS_CONVERSION ?? 5);
const PAGINAS_UMBRAL_TROCEO = Number(process.env.RAG_PAGINAS_UMBRAL_TROCEO ?? 25);

function condicionesFiltro(filtro: FiltroIngestaStd, binds: unknown[]): string[] {
  const condiciones: string[] = [];
  if (filtro.idDocumento) {
    binds.push(filtro.idDocumento);
    condiciones.push(`id_documento = $${binds.length}`);
  }
  if (filtro.documentoIds && filtro.documentoIds.length > 0) {
    binds.push(filtro.documentoIds);
    condiciones.push(`id = ANY($${binds.length}::bigint[])`);
  }
  if (filtro.anio) {
    binds.push(filtro.anio);
    condiciones.push(`EXTRACT(YEAR FROM fecha) = $${binds.length}`);
  }
  if (filtro.origen) {
    binds.push(filtro.origen);
    condiciones.push(`origen = $${binds.length}`);
  }
  return condiciones;
}

async function documentosPendientes(filtro: FiltroIngestaStd): Promise<{ id: number }[]> {
  const binds: unknown[] = [];
  const condiciones = [
    `(estado = 'pendiente'
        OR (estado = 'no_soportado' AND intentos < ${MAX_INTENTOS_SIN_ARCHIVO}))`,
    'vigente',
    ...condicionesFiltro(filtro, binds),
  ];

  const limite = Math.min(filtro.limite ?? 500, 5000);
  binds.push(limite);

  return stdRagSequelize.query<{ id: number }>(
    `SELECT id FROM rag.documento WHERE ${condiciones.join(' AND ')} ORDER BY id LIMIT $${binds.length}`,
    { bind: binds, type: QueryTypes.SELECT },
  );
}

async function exigirSinJobEnCurso(): Promise<void> {
  const [enCurso] = await stdRagSequelize.query<{ id: number; tipo: string }>(
    `SELECT id, tipo FROM rag.ingest_job
      WHERE estado = 'en_curso' AND tipo = 'conversion'
      ORDER BY fe_inicio DESC LIMIT 1`,
    { type: QueryTypes.SELECT },
  );
  if (enCurso) {
    throw new IngestaStdError(
      `Ya hay un trabajo de ${enCurso.tipo} del STD en curso (#${enCurso.id}); espere a que termine o deténgalo.`,
      409,
    );
  }
}

export async function iniciarJobConversionStd(filtro: FiltroIngestaStd, actor: string): Promise<{ jobId: number }> {
  await exigirSinJobEnCurso();

  const documentos = await documentosPendientes(filtro);
  if (documentos.length === 0) {
    throw new IngestaStdError('No hay documentos del STD pendientes con ese filtro', 404);
  }

  const [{ id: jobId }] = await stdRagSequelize.query<{ id: number }>(
    `INSERT INTO rag.ingest_job (tipo, estado, filtro, total, creado_por)
     VALUES ('conversion', 'en_curso', $1::jsonb, $2, $3) RETURNING id`,
    { bind: [JSON.stringify(filtro), documentos.length, actor], type: QueryTypes.SELECT },
  );

  await stdRagSequelize.query(
    `INSERT INTO rag.ingest_item (job_id, documento_id)
     SELECT $1, unnest($2::bigint[])`,
    { bind: [jobId, documentos.map((d) => d.id)], type: QueryTypes.INSERT },
  );

  void ejecutarJobConversion(jobId).catch((error) => {
    console.error(`ingesta STD: job de conversión ${jobId} falló:`, error);
  });

  return { jobId };
}

const loopsVivos = new Set<number>();

async function ejecutarJobConversion(jobId: number): Promise<void> {
  const id = clave(jobId);
  if (loopsVivos.has(id)) return;

  loopsVivos.add(id);
  try {
    await ejecutarJobConversionLoop(jobId);
  } finally {
    loopsVivos.delete(id);
  }
}

async function ejecutarJobConversionLoop(jobId: number): Promise<void> {
  for (;;) {
    const [filaJob] = await stdRagSequelize.query<{ estado: string }>(
      `SELECT estado FROM rag.ingest_job WHERE id = $1`,
      { bind: [jobId], type: QueryTypes.SELECT },
    );
    if (filaJob?.estado !== 'en_curso') {
      progresoEnVivo.delete(clave(jobId));
      return;
    }

    const item = await stdRagSequelize.transaction(async (tx) => {
      const filas = await stdRagSequelize.query<{ id: number; documento_id: number }>(
        `SELECT id, documento_id FROM rag.ingest_item
          WHERE job_id = $1 AND estado = 'pendiente'
          ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        { bind: [jobId], type: QueryTypes.SELECT, transaction: tx },
      );
      if (filas.length === 0) return null;

      await stdRagSequelize.query(
        `UPDATE rag.ingest_item SET estado = 'en_proceso', lease_hasta = now() + interval '10 minutes'
          WHERE id = $1`,
        { bind: [filas[0].id], type: QueryTypes.UPDATE, transaction: tx },
      );
      return filas[0];
    });

    if (!item) break;

    const docActual = await filaDeDocumento(item.documento_id);
    progresoEnVivo.set(clave(jobId), {
      documentoId: item.documento_id,
      titulo: docActual ? [docActual.tipo_doc, docActual.documento].filter(Boolean).join(' ') || null : null,
      desde: Date.now(),
      fase: 'descargando',
      faseDesde: Date.now(),
      limiteMs: null,
      proveedor: null,
      intento: 1,
      intentos: 1,
      motivoFallback: null,
      bloque: null,
      bloques: null,
      paginaDesde: null,
      paginaHasta: null,
    });

    try {
      await convertirDocumento(
        item.documento_id,
        (avance) => anotarFase(jobId, item.documento_id, avance),
        async () => {
          await stdRagSequelize.query(
            `UPDATE rag.ingest_item SET lease_hasta = now() + interval '10 minutes' WHERE id = $1`,
            { bind: [item.id], type: QueryTypes.UPDATE },
          );
        },
      );
      await stdRagSequelize.query(
        `UPDATE rag.ingest_item SET estado = 'ok', fe_fin = now() WHERE id = $1`,
        { bind: [item.id], type: QueryTypes.UPDATE },
      );
      await incrementarJob(jobId, 'procesados');
    } catch (error) {
      const motivo = error instanceof Error ? error.message : 'error desconocido';
      await stdRagSequelize.query(
        `UPDATE rag.ingest_item SET estado = 'error', motivo_error = $2, fe_fin = now() WHERE id = $1`,
        { bind: [item.id, motivo], type: QueryTypes.UPDATE },
      );
      await incrementarJob(jobId, 'errores');
    }

    await new Promise((r) => setImmediate(r));
  }

  progresoEnVivo.delete(clave(jobId));
  await stdRagSequelize.query(
    `UPDATE rag.ingest_job SET estado = 'completado', fe_fin = now() WHERE id = $1 AND estado = 'en_curso'`,
    { bind: [jobId], type: QueryTypes.UPDATE },
  );
}

export async function pausarJobStd(jobId: number): Promise<void> {
  const [fila] = await stdRagSequelize.query<{ id: number }>(
    `UPDATE rag.ingest_job SET estado = 'pausado'
      WHERE id = $1 AND estado = 'en_curso' AND tipo = 'conversion'
      RETURNING id`,
    { bind: [jobId], type: QueryTypes.SELECT },
  );
  if (!fila) throw new IngestaStdError('El trabajo no está en curso', 409);
}

export async function reanudarJobStd(jobId: number): Promise<void> {
  const [fila] = await stdRagSequelize.query<{ id: number }>(
    `UPDATE rag.ingest_job SET estado = 'en_curso'
      WHERE id = $1 AND estado = 'pausado' AND tipo = 'conversion'
      RETURNING id`,
    { bind: [jobId], type: QueryTypes.SELECT },
  );
  if (!fila) throw new IngestaStdError('El trabajo no está pausado', 409);

  void ejecutarJobConversion(jobId).catch((error) => {
    console.error(`ingesta STD: job de conversión ${jobId} (reanudado) falló:`, error);
  });
}

export async function cancelarJobStd(jobId: number): Promise<void> {
  const [fila] = await stdRagSequelize.query<{ id: number }>(
    `UPDATE rag.ingest_job SET estado = 'cancelado', fe_fin = now()
      WHERE id = $1 AND estado IN ('en_curso', 'pausado') AND tipo IN ('conversion', 'embedding')
      RETURNING id`,
    { bind: [jobId], type: QueryTypes.SELECT },
  );
  if (!fila) throw new IngestaStdError('El trabajo ya terminó', 409);

  await stdRagSequelize.query(
    `UPDATE rag.ingest_item SET estado = 'omitido' WHERE job_id = $1 AND estado = 'pendiente'`,
    { bind: [jobId], type: QueryTypes.UPDATE },
  );
}

async function incrementarJob(jobId: number, campo: 'procesados' | 'errores'): Promise<void> {
  await stdRagSequelize.query(`UPDATE rag.ingest_job SET ${campo} = ${campo} + 1 WHERE id = $1`, {
    bind: [jobId],
    type: QueryTypes.UPDATE,
  });
}

// ── Conversión de UN documento ───────────────────────────────────────────────

export interface FilaDocumentoStd {
  id: number;
  id_adjunto: number;
  id_documento: number;
  origen: OrigenAdjuntoStd;
  nro_std: string | null;
  documento: string | null;
  tipo_doc: string | null;
  origen_doc: string | null;
  asunto: string | null;
  fecha: string | null;
  remitente: string | null;
  area_origen: string | null;
  nombre_archivo: string | null;
  mime: string | null;
  estado: string;
  contenido_sha256: string | null;
  intentos: number;
}

export async function filaDeDocumento(documentoId: number): Promise<FilaDocumentoStd | undefined> {
  const [doc] = await stdRagSequelize.query<FilaDocumentoStd>(
    `SELECT id, id_adjunto, id_documento, origen, nro_std, documento, tipo_doc, origen_doc,
            asunto, fecha, remitente, area_origen, nombre_archivo, mime, estado,
            contenido_sha256, intentos
       FROM rag.documento WHERE id = $1`,
    { bind: [documentoId], type: QueryTypes.SELECT },
  );
  return doc;
}

/**
 * Bytes de un documento del STD: `tbl_adjunto.adjunto` (la clave física de 40 hex) se consulta en
 * vivo porque nunca se guarda en `std_rag` — ver la migración, `rag.documento` solo guarda
 * `id_adjunto`. El nombre SÍ viene de `rag.documento.nombre_archivo`, ya capturado por el barrido:
 * no hace falta una segunda vuelta al STD solo para eso.
 */
export async function obtenerBytesDocumentoStd(
  doc: Pick<FilaDocumentoStd, 'id_adjunto' | 'nombre_archivo'>,
): Promise<{ buffer: Buffer; filename: string }> {
  const clave_ = await leerClaveAdjuntoStd(doc.id_adjunto);
  if (!clave_) {
    throw new ArchivoStdError('El adjunto ya no existe en tbl_adjunto del STD', 404);
  }
  const resultado = leerArchivoStd(clave_.adjunto, clave_.hash);
  return { buffer: resultado.buffer, filename: doc.nombre_archivo ?? `adjunto_${doc.id_adjunto}.pdf` };
}

export async function convertirDocumento(
  documentoId: number,
  onFase?: ReportarFase,
  onLatido?: () => Promise<void>,
): Promise<void> {
  const doc = await filaDeDocumento(documentoId);
  if (!doc) throw new IngestaStdError('El documento ya no existe en rag.documento (std_rag)', 404);

  onFase?.({ fase: 'descargando' });
  await marcarEstado(doc.id, 'en_proceso');

  let buffer: Buffer;
  let nombreArchivo: string;
  try {
    const resuelto = await obtenerBytesDocumentoStd(doc);
    buffer = resuelto.buffer;
    nombreArchivo = resuelto.filename;
  } catch (error) {
    // A diferencia del SGD, aquí no hay nada que "generar": todo documento del STD es un archivo
    // subido de verdad. Sin archivo en disco (o sin fila en tbl_adjunto) es no_soportado, directo.
    await marcarEstado(doc.id, 'no_soportado', motivoDe(error));
    onFase?.({ fase: 'listo' });
    return;
  }

  onFase?.({ fase: 'deduplicando' });
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (await enlazarSiYaExiste(doc, sha256)) {
    onFase?.({ fase: 'listo' });
    return;
  }

  const paginas = await contarPaginas(buffer);
  if (paginas !== null) {
    await stdRagSequelize.query('UPDATE rag.documento SET paginas = $2 WHERE id = $1', {
      bind: [doc.id, paginas],
      type: QueryTypes.UPDATE,
    });
  }

  let markdown: string;
  let ms: number;
  let metodo: string;
  let advertencia: string | undefined;
  try {
    const resultado = paginas !== null && paginas > PAGINAS_UMBRAL_TROCEO
      ? await convertirPorBloques(buffer, nombreArchivo, onFase, onLatido)
      : await convertirAMarkdownActivo(buffer, nombreArchivo, onFase);
    ({ markdown, ms, metodo } = resultado);
    advertencia = resultado.advertencia;
  } catch (error) {
    if (error instanceof ConversionError && !error.reintentable) {
      await marcarEstado(doc.id, 'error', error.motivo);
      onFase?.({ fase: 'listo' });
      return;
    }
    const motivo = motivoDe(error);
    if (doc.intentos + 1 >= MAX_INTENTOS_CONVERSION) {
      await marcarEstado(
        doc.id,
        'error',
        `${motivo} (máximo de ${MAX_INTENTOS_CONVERSION} intentos alcanzado)`,
      );
    } else {
      await marcarEstadoPendiente(doc.id, motivo);
    }
    onFase?.({ fase: 'listo' });
    throw error;
  }

  await guardarMarkdown(doc, sha256, markdown, {
    metodo,
    bytes: buffer.length,
    mime: limpiarMime(doc.mime),
    ms,
    advertencia,
  }, onFase);
}

export async function enlazarSiYaExiste(doc: FilaDocumentoStd, sha256: string): Promise<boolean> {
  const existente = await stdRagSequelize.query<{ chunks_generados: number; markdown: string | null }>(
    'SELECT chunks_generados, markdown FROM rag.contenido WHERE sha256 = $1',
    { bind: [sha256], type: QueryTypes.SELECT },
  );
  if (existente.length === 0) return false;

  const fila = existente[0];

  if (fila.chunks_generados > 0) {
    await stdRagSequelize.query(
      `UPDATE rag.documento SET contenido_sha256 = $2, estado = 'convertido' WHERE id = $1`,
      { bind: [doc.id, sha256], type: QueryTypes.UPDATE },
    );
    return true;
  }

  if (fila.markdown && !limpiarMarkdown(fila.markdown).sinTexto) {
    const chunksReconstruidos = trocear(fila.markdown);
    if (chunksReconstruidos.length > 0) {
      await guardarChunksYMarcarConvertido(doc.id, sha256, cabeceraDe(doc), chunksReconstruidos);
      return true;
    }
  }
  return false;
}

export async function guardarMarkdown(
  doc: FilaDocumentoStd,
  sha256: string,
  markdown: string,
  origen: { metodo: string; bytes: number; mime: string; ms: number; advertencia?: string },
  onFase?: ReportarFase,
): Promise<void> {
  onFase?.({ fase: 'troceando' });
  const limpio = limpiarMarkdown(markdown);

  await stdRagSequelize.query(
    `INSERT INTO rag.contenido (sha256, bytes, mime, markdown, chars, metodo, ms_conversion, fe_conversion)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (sha256) DO UPDATE SET
       bytes = EXCLUDED.bytes, mime = EXCLUDED.mime, markdown = EXCLUDED.markdown,
       chars = EXCLUDED.chars, metodo = EXCLUDED.metodo, ms_conversion = EXCLUDED.ms_conversion,
       fe_conversion = EXCLUDED.fe_conversion
     WHERE rag.contenido.chunks_generados = 0`,
    {
      bind: [sha256, origen.bytes, origen.mime, limpio.markdown, limpio.chars, origen.metodo, origen.ms],
      type: QueryTypes.INSERT,
    },
  );

  if (limpio.sinTexto) {
    await stdRagSequelize.query(
      'UPDATE rag.documento SET contenido_sha256 = $2, estado = $3 WHERE id = $1',
      { bind: [doc.id, sha256, 'sin_texto'], type: QueryTypes.UPDATE },
    );
    onFase?.({ fase: 'listo' });
    return;
  }

  onFase?.({ fase: 'guardando' });
  await guardarChunksYMarcarConvertido(doc.id, sha256, cabeceraDe(doc), trocear(limpio.markdown), origen.advertencia);
  onFase?.({ fase: 'listo' });
}

/**
 * Cabecera de contexto del STD: "STD <n° documento> · <tipo documento> · <origen · remitente -
 * área> · <fecha> · <asunto> · <anexo|derivación>" — la antepone SOLO el embedding (igual que el
 * SGD), nunca lo que se cita.
 */
function cabeceraDe(doc: FilaDocumentoStd): string {
  const identificador = `STD ${doc.nro_std ?? doc.id_documento}`;
  const tipoNumero = [doc.tipo_doc, doc.documento].filter(Boolean).join(' ');
  const procedencia = [doc.origen_doc, doc.remitente, doc.area_origen].filter(Boolean).join(' - ');
  const etiquetaOrigen = doc.origen === 'anexo' ? 'anexo' : doc.origen === 'derivacion' ? 'derivación' : null;

  return construirCabecera({
    titulo: [identificador, tipoNumero || null].filter(Boolean).join(' · '),
    dependencia: procedencia || null,
    fecha: doc.fecha,
    asunto: doc.asunto,
    rutaTitulos: etiquetaOrigen,
  });
}

async function guardarChunksYMarcarConvertido(
  documentoId: number,
  sha256: string,
  cabecera: string,
  chunks: Chunk[],
  advertencia?: string,
): Promise<void> {
  await stdRagSequelize.transaction(async (tx) => {
    for (const chunk of chunks) {
      await stdRagSequelize.query(
        `INSERT INTO rag.chunk (sha256, ord, texto, ruta_titulos, cabecera_ctx, car_inicio, car_fin, tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (sha256, ord) DO NOTHING`,
        {
          bind: [
            sha256, chunk.ord, chunk.texto,
            chunk.rutaTitulos || null,
            [cabecera, chunk.rutaTitulos].filter(Boolean).join(' · '),
            chunk.carInicio, chunk.carFin, chunk.tokens,
          ],
          type: QueryTypes.INSERT,
          transaction: tx,
        },
      );
    }

    await stdRagSequelize.query(
      `UPDATE rag.contenido SET chunks_generados = $2, fe_chunking = now() WHERE sha256 = $1`,
      { bind: [sha256, chunks.length], type: QueryTypes.UPDATE, transaction: tx },
    );

    await stdRagSequelize.query(
      `UPDATE rag.documento SET contenido_sha256 = $2, estado = 'convertido', motivo_error = $3 WHERE id = $1`,
      { bind: [documentoId, sha256, advertencia ?? null], type: QueryTypes.UPDATE, transaction: tx },
    );
  });
}

async function marcarEstado(documentoId: number, estado: string, motivo?: string): Promise<void> {
  await stdRagSequelize.query(
    `UPDATE rag.documento SET estado = $2, motivo_error = $3, intentos = intentos + 1 WHERE id = $1`,
    { bind: [documentoId, estado, motivo ?? null], type: QueryTypes.UPDATE },
  );
}

async function marcarEstadoPendiente(documentoId: number, motivo?: string): Promise<void> {
  await stdRagSequelize.query(
    `UPDATE rag.documento SET estado = 'pendiente', motivo_error = $2 WHERE id = $1`,
    { bind: [documentoId, motivo ?? null], type: QueryTypes.UPDATE },
  );
}

function motivoDe(error: unknown): string {
  return error instanceof Error ? error.message : 'error desconocido';
}

// ── Job de EMBEDDINGS ─────────────────────────────────────────────────────────

const TAMANO_LOTE = 16;

export async function iniciarJobEmbeddingStd(
  filtro: FiltroIngestaStd,
  actor: string,
  providerOverride?: EmbeddingProvider,
): Promise<{ jobId: number }> {
  const disponibilidad = embeddingsDisponibles();
  if (!disponibilidad.disponible) {
    throw new IngestaStdError(`No se puede iniciar la ingesta de embeddings del STD: ${disponibilidad.motivo}`, 409);
  }

  const provider = providerOverride ?? crearEmbeddingProvider();
  await registrarSiNoExiste(provider, stdRagSequelize);

  const activo = await modeloActivo(stdRagSequelize);
  if (!activo) {
    throw new IngestaStdError(
      'No hay ningún modelo de embeddings activo en std_rag. Actívelo desde el panel del STD '
        + 'antes de iniciar la ingesta — es una decisión administrativa, no automática.',
      409,
    );
  }
  if (activo.proveedor !== provider.nombre || activo.modelo !== provider.modelo) {
    throw new IngestaStdError(
      `El modelo activo (${activo.proveedor}/${activo.modelo}) no coincide con el proveedor `
        + `configurado (${provider.nombre}/${provider.modelo}).`,
      409,
    );
  }

  await provider.comprobar();

  const tabla = tablaVectores(activo.dimension);
  const chunkIds = await idsChunksPendientes(activo.id, tabla, filtro);
  if (chunkIds.length === 0) {
    throw new IngestaStdError('No hay chunks del STD pendientes de embeber con ese filtro', 404);
  }

  const [{ id: jobId }] = await stdRagSequelize.query<{ id: number }>(
    `INSERT INTO rag.ingest_job (tipo, estado, filtro, total, creado_por)
     VALUES ('embedding', 'en_curso', $1::jsonb, $2, $3) RETURNING id`,
    { bind: [JSON.stringify(filtro), chunkIds.length, actor], type: QueryTypes.SELECT },
  );

  void ejecutarJobEmbedding(jobId, provider, activo.id, tabla, chunkIds).catch((error) => {
    console.error(`ingesta STD: job de embeddings ${jobId} falló:`, error);
  });

  return { jobId };
}

async function idsChunksPendientes(modeloId: number, tabla: string, filtro: FiltroIngestaStd): Promise<number[]> {
  const binds: unknown[] = [modeloId];
  // Con alias `d.`, no el de `condicionesFiltro` (pensado para un WHERE sin alias sobre
  // rag.documento directamente) — aquí el documento se llama `d` porque `c` ya es el chunk.
  const condiciones = [
    `NOT EXISTS (SELECT 1 FROM rag.${tabla} v WHERE v.chunk_id = c.id AND v.modelo_id = $1)`,
    'd.vigente',
    ...condicionesFiltroDoc(filtro, binds),
  ];

  const limite = Math.min(filtro.limite ?? 2000, 20_000);
  binds.push(limite);

  const filas = await stdRagSequelize.query<{ id: number }>(
    `SELECT DISTINCT c.id
       FROM rag.chunk c
       JOIN rag.documento d ON d.contenido_sha256 = c.sha256
      WHERE ${condiciones.join(' AND ')}
      ORDER BY c.id LIMIT $${binds.length}`,
    { bind: binds, type: QueryTypes.SELECT },
  );
  return filas.map((f) => f.id);
}

/** Igual que `condicionesFiltro`, pero con el alias `d.` del documento — para consultas que
 *  también tienen `c.` (chunk) en el mismo WHERE y ya vienen empujando binds propios. */
function condicionesFiltroDoc(filtro: FiltroIngestaStd, binds: unknown[]): string[] {
  const condiciones: string[] = [];
  if (filtro.idDocumento) {
    binds.push(filtro.idDocumento);
    condiciones.push(`d.id_documento = $${binds.length}`);
  }
  if (filtro.documentoIds && filtro.documentoIds.length > 0) {
    binds.push(filtro.documentoIds);
    condiciones.push(`d.id = ANY($${binds.length}::bigint[])`);
  }
  if (filtro.anio) {
    binds.push(filtro.anio);
    condiciones.push(`EXTRACT(YEAR FROM d.fecha) = $${binds.length}`);
  }
  if (filtro.origen) {
    binds.push(filtro.origen);
    condiciones.push(`d.origen = $${binds.length}`);
  }
  return condiciones;
}

async function ejecutarJobEmbedding(
  jobId: number,
  provider: EmbeddingProvider,
  modeloId: number,
  tabla: string,
  chunkIds: number[],
): Promise<void> {
  let huboErrorFatal = false;
  let lotesFallidosSeguidos = 0;

  for (let i = 0; i < chunkIds.length; i += TAMANO_LOTE) {
    const [filaJob] = await stdRagSequelize.query<{ estado: string }>(
      'SELECT estado FROM rag.ingest_job WHERE id = $1',
      { bind: [jobId], type: QueryTypes.SELECT },
    );
    if (filaJob?.estado !== 'en_curso') return;

    const idsLote = chunkIds.slice(i, i + TAMANO_LOTE);
    const lote = await stdRagSequelize.query<{ id: number; texto: string; cabecera_ctx: string | null }>(
      'SELECT id, texto, cabecera_ctx FROM rag.chunk WHERE id = ANY($1::bigint[]) ORDER BY id',
      { bind: [idsLote], type: QueryTypes.SELECT },
    );
    if (lote.length === 0) continue;

    const textos = lote.map((c) => [c.cabecera_ctx, c.texto].filter(Boolean).join('\n'));

    try {
      const { vectores, uso } = await provider.embeber(textos);

      await registrarUso(jobId, provider, 'embedding', uso, true);

      await stdRagSequelize.transaction(async (tx) => {
        for (let j = 0; j < lote.length; j++) {
          await stdRagSequelize.query(
            `INSERT INTO rag.${tabla} (chunk_id, modelo_id, vec) VALUES ($1, $2, $3)
             ON CONFLICT (modelo_id, chunk_id) DO NOTHING`,
            { bind: [lote[j].id, modeloId, JSON.stringify(vectores[j])], type: QueryTypes.INSERT, transaction: tx },
          );
        }
      });

      await stdRagSequelize.query('UPDATE rag.ingest_job SET procesados = procesados + $2 WHERE id = $1', {
        bind: [jobId, lote.length],
        type: QueryTypes.UPDATE,
      });

      await marcarDocumentosCompletos(modeloId, tabla);
      lotesFallidosSeguidos = 0;
    } catch (error) {
      if (error instanceof ErrorIA) {
        await registrarUso(jobId, provider, 'embedding', { tokensIn: 0, tokensOut: 0, estimado: true }, false);
        if (!error.permiteFailover) {
          await stdRagSequelize.query(
            `UPDATE rag.ingest_job SET estado='error', mensaje=$2, fe_fin=now() WHERE id=$1`,
            { bind: [jobId, error.message], type: QueryTypes.UPDATE },
          );
          return;
        }
      }

      await stdRagSequelize.query('UPDATE rag.ingest_job SET errores = errores + $2 WHERE id = $1', {
        bind: [jobId, lote.length],
        type: QueryTypes.UPDATE,
      });

      lotesFallidosSeguidos++;
      if (lotesFallidosSeguidos >= 3) {
        huboErrorFatal = true;
        await stdRagSequelize.query(
          `UPDATE rag.ingest_job SET estado='error',
                  mensaje = COALESCE(mensaje, $2), fe_fin = now() WHERE id = $1`,
          {
            bind: [jobId, error instanceof Error ? error.message : 'fallos repetidos'],
            type: QueryTypes.UPDATE,
          },
        );
        break;
      }
    }

    await new Promise((r) => setImmediate(r));
  }

  if (!huboErrorFatal) {
    await stdRagSequelize.query(
      `UPDATE rag.ingest_job SET estado = 'completado', fe_fin = now() WHERE id = $1 AND estado = 'en_curso'`,
      { bind: [jobId], type: QueryTypes.UPDATE },
    );

    try {
      await crearIndiceHnsw(modeloId, provider.dimension, stdRagSequelize);
    } catch (error) {
      console.error(`ingesta STD: no se pudo crear/confirmar el índice HNSW del job ${jobId}:`, error);
    }
  }
}

async function marcarDocumentosCompletos(modeloId: number, tabla: string): Promise<void> {
  await stdRagSequelize.query(
    `UPDATE rag.documento d SET estado = 'ok'
      WHERE d.estado = 'convertido'
        AND d.contenido_sha256 IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM rag.chunk c
           WHERE c.sha256 = d.contenido_sha256
             AND NOT EXISTS (SELECT 1 FROM rag.${tabla} v WHERE v.chunk_id = c.id AND v.modelo_id = $1)
        )`,
    { bind: [modeloId], type: QueryTypes.UPDATE },
  );
}

async function registrarUso(
  jobId: number,
  provider: EmbeddingProvider,
  operacion: string,
  uso: { tokensIn: number; tokensOut: number; estimado: boolean },
  exito: boolean,
): Promise<void> {
  await stdRagSequelize.query(
    `INSERT INTO rag.uso_token (job_id, proveedor, modelo, operacion, tokens_in, tokens_out, estimado, exito)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    {
      bind: [jobId, provider.nombre, provider.modelo, operacion, uso.tokensIn, uso.tokensOut, uso.estimado, exito],
      type: QueryTypes.INSERT,
    },
  );
}

// ── Consulta de estado ───────────────────────────────────────────────────────

export async function estadoJobStd(jobId: number) {
  const [job] = await stdRagSequelize.query<{ id: number }>(
    `SELECT id, tipo, estado, filtro, total, procesados, errores, mensaje,
            fe_inicio::text AS "feInicio", fe_fin::text AS "feFin"
       FROM rag.ingest_job WHERE id = $1`,
    { bind: [jobId], type: QueryTypes.SELECT },
  );
  if (!job) throw new IngestaStdError('El trabajo no existe', 404);

  const proceso = progresoJobStd(jobId);
  const ahora = Date.now();
  return {
    ...job,
    procesoActual: proceso && {
      documentoId: proceso.documentoId,
      titulo: proceso.titulo,
      segundos: Math.round((ahora - proceso.desde) / 1000),
      fase: proceso.fase,
      faseMs: ahora - proceso.faseDesde,
      faseLimiteMs: proceso.limiteMs,
      proveedor: proceso.proveedor,
      intento: proceso.intento,
      intentos: proceso.intentos,
      motivoFallback: proceso.motivoFallback,
      bloque: proceso.bloque,
      bloques: proceso.bloques,
      paginaDesde: proceso.paginaDesde,
      paginaHasta: proceso.paginaHasta,
    },
  };
}

export async function listarJobsStd(limite = 20) {
  return stdRagSequelize.query(
    `SELECT id, tipo, estado, filtro, total, procesados, errores, mensaje,
            creado_por AS "creadoPor",
            fe_inicio::text AS "feInicio", fe_fin::text AS "feFin"
       FROM rag.ingest_job ORDER BY fe_inicio DESC LIMIT $1`,
    { bind: [Math.min(limite, 100)], type: QueryTypes.SELECT },
  );
}

// ── Supervisor: recuperación de jobs huérfanos ────────────────────────────

async function reclamarLeasesVencidos(): Promise<number> {
  const itemsReclamados = await stdRagSequelize.query<{ id: number; job_id: number; documento_id: number }>(
    `UPDATE rag.ingest_item
        SET estado = 'pendiente', lease_hasta = NULL
      WHERE estado = 'en_proceso' AND lease_hasta < now()
      RETURNING id, job_id, documento_id`,
    { type: QueryTypes.SELECT },
  );

  if (itemsReclamados.length === 0) return 0;

  console.log(`Ingesta STD: ${itemsReclamados.length} ítem(s) con lease vencido reclamado(s).`);

  await stdRagSequelize.query(
    `UPDATE rag.documento SET estado = 'pendiente'
      WHERE id = ANY($1::bigint[]) AND estado = 'en_proceso'`,
    { bind: [itemsReclamados.map((i) => i.documento_id)], type: QueryTypes.UPDATE },
  );

  return itemsReclamados.length;
}

async function revisarJobsHuerfanos(): Promise<void> {
  const jobs = await stdRagSequelize.query<{ id: number; tipo: string }>(
    `SELECT j.id, j.tipo FROM rag.ingest_job j
      WHERE j.estado = 'en_curso' AND j.tipo = 'conversion'
        AND EXISTS (SELECT 1 FROM rag.ingest_item i WHERE i.job_id = j.id AND i.estado = 'pendiente')
      ORDER BY j.id`,
    { type: QueryTypes.SELECT },
  );

  for (const job of jobs) {
    if (loopsVivos.has(clave(job.id))) continue;

    console.log(`Ingesta STD: reanudando job de ${job.tipo} #${job.id} (sin worker asignado).`);
    void ejecutarJobConversion(job.id).catch((error) => {
      console.error(`ingesta STD: job de ${job.tipo} ${job.id} (reanudado) falló:`, error);
    });
  }
}

export async function reanudarJobsInterrumpidosStd(): Promise<void> {
  await reclamarLeasesVencidos();
  await revisarJobsHuerfanos();
}

let temporizadorSupervisor: ReturnType<typeof setInterval> | null = null;

export function iniciarSupervisorIngestaStd(): void {
  if (temporizadorSupervisor) return;

  temporizadorSupervisor = setInterval(() => {
    void reanudarJobsInterrumpidosStd().catch((error) => {
      console.error('ingesta STD: el supervisor de la cola falló en este tick:', error);
    });
  }, 60_000);
  temporizadorSupervisor.unref();
}
