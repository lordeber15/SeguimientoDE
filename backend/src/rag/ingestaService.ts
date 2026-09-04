import crypto from 'crypto';
import { QueryTypes } from 'sequelize';
import { appSequelize } from '../config/appDatabase';
import { crearEmbeddingProvider, embeddingsDisponibles } from '../ai/providerFactory';
import type { EmbeddingProvider } from '../ai/types';
import { ErrorIA } from '../ai/types';
import { datosAMarkdown, esGenerable } from '../services/documentoGeneradoService';
import {
  getArchivoAnexo,
  getArchivoDoc,
  getDatosDocumentoGenerado,
} from '../services/documentoService';
import {
  mimePorNombre,
  resolverAnexo,
  resolverDocumento,
  type ArchivoResuelto,
} from '../services/storageService';
import { construirCabecera, trocear, type Chunk } from './chunkService';
import {
  activarModelo as _activarModelo,
  crearIndiceHnsw,
  modeloActivo,
  registrarSiNoExiste,
  tablaVectores,
} from './embeddingModelService';
import { documentoPorId, type DocumentoRag } from './estadoService';
import type { AvanceFase, FaseConversion, ProveedorConversion, ReportarFase } from './fasesConversion';
import {
  conversionBloqueada,
  convertirAMarkdownActivo,
} from './conversionProviderService';
import { limpiarMarkdown } from './limpiezaService';
import { ConversionError } from './mdConvertService';

/**
 * Orquesta la ingesta: conversión+chunking (funciona hoy, sin API key) y embeddings (implementado
 * y probado con proveedores simulados; solo falta que haya credenciales o Ollama corriendo).
 *
 * División deliberada en dos jobs separados (D1 de PLAN-RAG.md): el markdown y los chunks se
 * guardan para siempre; los vectores son derivados y desechables. Cambiar de proveedor de
 * embeddings es re-embeber desde los chunks ya existentes — nunca volver a pasar por markitdown.
 */

export class IngestaError extends Error {
  readonly status: number;
  constructor(mensaje: string, status = 400) {
    super(mensaje);
    this.name = 'IngestaError';
    this.status = status;
  }
}

export interface FiltroIngesta {
  nuAnnExp?: string;
  nuSecExp?: string;
  /**
   * Acota el job a estos documentos exactos — es lo que permite reprocesar un documento suelto o
   * una selección desde el modal de indexación del chat, en vez del expediente entero. Se combina
   * con el filtro de expediente con AND: quien lo manda envía siempre los dos, de modo que un
   * error de cálculo en la lista no puede convertirse en un job sobre todo el corpus.
   */
  documentoIds?: number[];
  limite?: number;
}

/**
 * Progreso en vivo del ítem que un job de conversión está procesando AHORA MISMO — a propósito
 * NO persiste en BD: es información transitoria (para la barra "Procesando: X" del panel), se
 * pierde en un reinicio y se reconstruye sola en cuanto el loop reclama el siguiente ítem. Si se
 * necesitara sobrevivir a un reinicio habría que persistirla, pero para una barra de progreso no
 * vale la pena la complejidad de una columna nueva.
 *
 * Lo mismo vale para las fases: si el backend se reinicia a mitad de un documento, ese documento
 * se reconvierte entero desde cero (ver `reanudarJobsInterrumpidos`), así que reiniciar su barra
 * en 0 no es perder información — es la verdad.
 */
export interface ProgresoJob {
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
}

const progresoEnVivo = new Map<number, ProgresoJob>();

/**
 * `rag.ingest_job.id` es `bigint`: el driver `pg` lo devuelve como STRING en cualquier consulta
 * cruda (sin `setTypeParser` para el OID 20, que este proyecto no registra — a propósito, para no
 * arriesgar precisión en un id que sí puede superar `Number.MAX_SAFE_INTEGER`). `jobId` llega aquí
 * unas veces como ese string ("50", desde un `RETURNING id` recién insertado) y otras como number
 * (`Number(req.params.jobId)` en el controlador). Sin normalizar, `Map.get(50) !== Map.get("50")`
 * y `procesoActual` sale `null` SIEMPRE, por más que el loop esté escribiendo de verdad — así
 * estuvo desde el `progresoEnVivo` original, antes de que existieran las fases.
 */
function clave(jobId: number): number {
  return Number(jobId);
}

export function progresoJob(jobId: number): ProgresoJob | null {
  return progresoEnVivo.get(clave(jobId)) ?? null;
}

/**
 * Anota sobre el progreso vivo la fase que reporta el pipeline. Es un `set`, no una cola de
 * eventos: el frontend sondea cada 1500 ms, así que solo importa el ÚLTIMO estado — guardar la
 * secuencia completa sería memoria que nadie lee.
 *
 * El filtro por `documentoId` no es paranoia: una conversión abandonada por el límite duro de
 * `mdConvertService` (incidente de 2026-08-23) sigue viva después de que el loop haya pasado al
 * siguiente ítem. Sin este filtro, un aviso tardío suyo reescribiría la fase del documento que
 * está en marcha ahora y la barra retrocedería sin explicación.
 */
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
  });
}

// ── Job de CONVERSIÓN (disponible hoy) ───────────────────────────────────────

/**
 * Tope de intentos para rescatar un `no_soportado`. Sin él, uno cuyo archivo nunca vaya a aparecer
 * volvería a la cola en cada job para siempre: falla, se remarca `no_soportado`, y el siguiente
 * job lo vuelve a coger.
 */
const MAX_INTENTOS_SIN_ARCHIVO = 10;

async function documentosPendientes(filtro: FiltroIngesta): Promise<{ id: number }[]> {
  // Los `no_soportado` vuelven a la cola SIN filtrar por tipo: `co_tip_doc` es una copia que el
  // barrido tomó la primera vez que vio el documento y puede quedar desactualizada (un PROVEÍDO
  // en borrador pasa de '001' a '232' al emitirse) — filtrar por ella dejaba fuera documentos que
  // sí son generables. También es la única forma de alcanzar los documentos cuyo archivo digital
  // apareció después del primer intento: su tipo nunca cambió, así que ningún filtro por tipo los
  // habría encontrado. Es `convertirDocumento`/`convertirDocumentoGenerado` quien decide sobre el
  // valor vivo del SGD, no esta consulta.
  const binds: unknown[] = [];
  const condiciones = [
    `(estado = 'pendiente'
        OR (estado = 'no_soportado' AND intentos < ${MAX_INTENTOS_SIN_ARCHIVO}))`,
    'vigente',
  ];

  if (filtro.nuAnnExp && filtro.nuSecExp) {
    binds.push(filtro.nuAnnExp, filtro.nuSecExp);
    condiciones.push(`nu_ann_exp = $${binds.length - 1} AND nu_sec_exp = $${binds.length}`);
  }
  if (filtro.documentoIds && filtro.documentoIds.length > 0) {
    binds.push(filtro.documentoIds);
    condiciones.push(`id = ANY($${binds.length}::bigint[])`);
  }

  const limite = Math.min(filtro.limite ?? 500, 5000);
  binds.push(limite);

  return appSequelize.query<{ id: number }>(
    `SELECT id FROM rag.documento WHERE ${condiciones.join(' AND ')} ORDER BY id LIMIT $${binds.length}`,
    { bind: binds, type: QueryTypes.SELECT },
  );
}

export async function iniciarJobConversion(filtro: FiltroIngesta, actor: string): Promise<{ jobId: number }> {
  const documentos = await documentosPendientes(filtro);
  if (documentos.length === 0) {
    throw new IngestaError('No hay documentos pendientes con ese filtro', 404);
  }

  const [{ id: jobId }] = await appSequelize.query<{ id: number }>(
    `INSERT INTO rag.ingest_job (tipo, estado, filtro, total, creado_por)
     VALUES ('conversion', 'en_curso', $1::jsonb, $2, $3) RETURNING id`,
    { bind: [JSON.stringify(filtro), documentos.length, actor], type: QueryTypes.SELECT },
  );

  await appSequelize.query(
    `INSERT INTO rag.ingest_item (job_id, documento_id)
     SELECT $1, unnest($2::bigint[])`,
    { bind: [jobId, documentos.map((d) => d.id)], type: QueryTypes.INSERT },
  );

  // No se espera aquí: el job corre en segundo plano y se consulta por polling, igual que
  // unirPdfService. Un job de 500 documentos tardaría minutos u horas (markitdown serializado).
  void ejecutarJobConversion(jobId).catch((error) => {
    console.error(`ingesta: job de conversión ${jobId} falló:`, error);
  });

  return { jobId };
}

/**
 * Documentos "sin archivo", "sin texto" o en `error` que todavía valen la pena reintentar: solo
 * generación y los conversores locales, nunca IA de pago (ver `iniciarJobReparacion`).
 */
async function documentosReparables(filtro: FiltroIngesta): Promise<{ id: number }[]> {
  const binds: unknown[] = [];
  const condiciones = [
    `estado IN ('no_soportado', 'sin_texto', 'error')`,
    `intentos < ${MAX_INTENTOS_SIN_ARCHIVO}`,
    'vigente',
  ];

  if (filtro.nuAnnExp && filtro.nuSecExp) {
    binds.push(filtro.nuAnnExp, filtro.nuSecExp);
    condiciones.push(`nu_ann_exp = $${binds.length - 1} AND nu_sec_exp = $${binds.length}`);
  }
  if (filtro.documentoIds && filtro.documentoIds.length > 0) {
    binds.push(filtro.documentoIds);
    condiciones.push(`id = ANY($${binds.length}::bigint[])`);
  }

  const limite = Math.min(filtro.limite ?? 500, 5000);
  binds.push(limite);

  return appSequelize.query<{ id: number }>(
    `SELECT id FROM rag.documento WHERE ${condiciones.join(' AND ')} ORDER BY id LIMIT $${binds.length}`,
    { bind: binds, type: QueryTypes.SELECT },
  );
}

/**
 * Reparación masiva: reintenta los documentos "sin archivo", "sin texto" y en `error` con
 * generación y los conversores locales — las rutas gratuitas.
 *
 * `estado='error'` estuvo excluido a propósito mientras hubo un solo conversor: ese estado lo pone
 * un fallo NO reintentable, o sea que el archivo ya se juzgó malo, y repetir EL MISMO pipeline
 * habría fallado igual quemando intentos. Con un proveedor de respaldo
 * (`conversionProviderService`) ese razonamiento deja de valer: un archivo que markitdown rechaza
 * puede ser justo el que mineru sí procesa, así que reintentar ya no es repetir.
 *
 * El caso que lo motivó (2026-09): 359 documentos en `error` con "markitdown HTTP 404", archivos
 * intactos que fallaron mientras otra imagen ocupaba el puerto del conversor. Sin esto, la única
 * salida para ellos era el botón de extracción con IA, uno a uno y de pago.
 *
 * Reutiliza `ejecutarJobConversion` sin cambiarlo: un ítem de reparación es exactamente
 * `convertirDocumento(id)`, igual que uno de conversión — lo único distinto es la selección. Este
 * job NUNCA puede llamar a `visionService`: ese módulo ni siquiera se importa en este archivo.
 */
export async function iniciarJobReparacion(filtro: FiltroIngesta, actor: string): Promise<{ jobId: number }> {
  const documentos = await documentosReparables(filtro);
  if (documentos.length === 0) {
    throw new IngestaError('No hay documentos recuperables con ese filtro', 404);
  }

  const [{ id: jobId }] = await appSequelize.query<{ id: number }>(
    `INSERT INTO rag.ingest_job (tipo, estado, filtro, total, creado_por)
     VALUES ('reparacion', 'en_curso', $1::jsonb, $2, $3) RETURNING id`,
    { bind: [JSON.stringify(filtro), documentos.length, actor], type: QueryTypes.SELECT },
  );

  await appSequelize.query(
    `INSERT INTO rag.ingest_item (job_id, documento_id)
     SELECT $1, unnest($2::bigint[])`,
    { bind: [jobId, documentos.map((d) => d.id)], type: QueryTypes.INSERT },
  );

  void ejecutarJobConversion(jobId).catch((error) => {
    console.error(`ingesta: job de reparación ${jobId} falló:`, error);
  });

  return { jobId };
}

async function ejecutarJobConversion(jobId: number): Promise<void> {
  for (;;) {
    // Se comprueba ANTES de reclamar el siguiente ítem: pausar/detener nunca interrumpe el ítem en
    // curso (no hay forma de abortar a mitad una llamada HTTP a markitdown), solo evita que se
    // reclame uno nuevo. Así el loop siempre sale entre ítems, nunca deja uno a medio marcar.
    const [filaJob] = await appSequelize.query<{ estado: string }>(
      `SELECT estado FROM rag.ingest_job WHERE id = $1`,
      { bind: [jobId], type: QueryTypes.SELECT },
    );
    if (filaJob?.estado !== 'en_curso') {
      progresoEnVivo.delete(clave(jobId));
      return;
    }

    // FOR UPDATE SKIP LOCKED: dos workers (o un reinicio a mitad de proceso) no procesan el
    // mismo ítem dos veces, y no hace falta ninguna librería de colas externa.
    const item = await appSequelize.transaction(async (tx) => {
      const filas = await appSequelize.query<{ id: number; documento_id: number }>(
        `SELECT id, documento_id FROM rag.ingest_item
          WHERE job_id = $1 AND estado = 'pendiente'
          ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        { bind: [jobId], type: QueryTypes.SELECT, transaction: tx },
      );
      if (filas.length === 0) return null;

      await appSequelize.query(
        `UPDATE rag.ingest_item SET estado = 'en_proceso', lease_hasta = now() + interval '10 minutes'
          WHERE id = $1`,
        { bind: [filas[0].id], type: QueryTypes.UPDATE, transaction: tx },
      );
      return filas[0];
    });

    if (!item) break;

    const docActual = await documentoPorId(item.documento_id);
    progresoEnVivo.set(clave(jobId), {
      documentoId: item.documento_id,
      titulo: docActual?.titulo ?? null,
      desde: Date.now(),
      fase: 'descargando',
      faseDesde: Date.now(),
      limiteMs: null,
      proveedor: null,
      intento: 1,
      intentos: 1,
      motivoFallback: null,
    });

    try {
      await convertirDocumento(item.documento_id, (avance) => anotarFase(jobId, item.documento_id, avance));
      await appSequelize.query(
        `UPDATE rag.ingest_item SET estado = 'ok', fe_fin = now() WHERE id = $1`,
        { bind: [item.id], type: QueryTypes.UPDATE },
      );
      await incrementarJob(jobId, 'procesados');
    } catch (error) {
      const motivo = error instanceof Error ? error.message : 'error desconocido';
      await appSequelize.query(
        `UPDATE rag.ingest_item SET estado = 'error', motivo_error = $2, fe_fin = now() WHERE id = $1`,
        { bind: [item.id, motivo], type: QueryTypes.UPDATE },
      );
      await incrementarJob(jobId, 'errores');
    }

    await new Promise((r) => setImmediate(r));
  }

  progresoEnVivo.delete(clave(jobId));
  await appSequelize.query(
    `UPDATE rag.ingest_job SET estado = 'completado', fe_fin = now() WHERE id = $1 AND estado = 'en_curso'`,
    { bind: [jobId], type: QueryTypes.UPDATE },
  );
}

/**
 * Pausa un job en curso (resumable con `reanudarJob`) o lo detiene definitivamente. En ambos
 * casos el ítem que el loop tiene en curso ahora mismo termina normal — ver el comentario al
 * principio de `ejecutarJobConversion`. Detener, a diferencia de pausar, marca `omitido` los
 * ítems que todavía no se habían reclamado, para que la lista de documentos del job no los
 * muestre como "pendiente" para siempre (`'omitido'` ya es un valor válido de
 * `rag.ingest_item.estado` y ya tiene etiqueta en `ListaDocumentosRag.tsx`).
 */
export async function pausarJob(jobId: number): Promise<void> {
  const [fila] = await appSequelize.query<{ id: number }>(
    `UPDATE rag.ingest_job SET estado = 'pausado'
      WHERE id = $1 AND estado = 'en_curso' AND tipo IN ('conversion', 'reparacion')
      RETURNING id`,
    { bind: [jobId], type: QueryTypes.SELECT },
  );
  if (!fila) throw new IngestaError('El trabajo no está en curso', 409);
}

export async function reanudarJob(jobId: number): Promise<void> {
  const [fila] = await appSequelize.query<{ id: number }>(
    `UPDATE rag.ingest_job SET estado = 'en_curso'
      WHERE id = $1 AND estado = 'pausado' AND tipo IN ('conversion', 'reparacion')
      RETURNING id`,
    { bind: [jobId], type: QueryTypes.SELECT },
  );
  if (!fila) throw new IngestaError('El trabajo no está pausado', 409);

  void ejecutarJobConversion(jobId).catch((error) => {
    console.error(`ingesta: job de conversión ${jobId} (reanudado tras pausa) falló:`, error);
  });
}

export async function cancelarJob(jobId: number): Promise<void> {
  const [fila] = await appSequelize.query<{ id: number }>(
    `UPDATE rag.ingest_job SET estado = 'cancelado', fe_fin = now()
      WHERE id = $1 AND estado IN ('en_curso', 'pausado') AND tipo IN ('conversion', 'reparacion')
      RETURNING id`,
    { bind: [jobId], type: QueryTypes.SELECT },
  );
  if (!fila) throw new IngestaError('El trabajo ya terminó', 409);

  await appSequelize.query(
    `UPDATE rag.ingest_item SET estado = 'omitido' WHERE job_id = $1 AND estado = 'pendiente'`,
    { bind: [jobId], type: QueryTypes.UPDATE },
  );
}

async function incrementarJob(jobId: number, campo: 'procesados' | 'errores'): Promise<void> {
  await appSequelize.query(`UPDATE rag.ingest_job SET ${campo} = ${campo} + 1 WHERE id = $1`, {
    bind: [jobId],
    type: QueryTypes.UPDATE,
  });
}

// ── Reintento manual de UN documento ─────────────────────────────────────────

/**
 * Namespace independiente del `LOCK_ID` de `barridoService.ts`: los advisory locks con clave
 * `bigint` y los de dos claves `int` viven en espacios distintos que nunca colisionan, así que no
 * hace falta coordinar el número con el otro archivo.
 */
const LOCK_NAMESPACE_DOCUMENTO = 'rag.documento';
const REPARACION_TIMEOUT_MS = Number(process.env.RAG_REPARACION_TIMEOUT_MS ?? 90_000);

export interface ResultadoReparacion {
  documento: DocumentoRag;
  /** Fallo transitorio: el documento ya volvió a 'pendiente' y se reintentará solo. */
  mensaje?: string;
  /** Superó el tiempo de espera; la conversión sigue corriendo en segundo plano. */
  enCurso?: boolean;
}

/**
 * Reintento síncrono de UN documento, para que un administrador vea el veredicto al instante y
 * decida si hace falta escalar a la extracción con IA. A diferencia del job en segundo plano, aquí
 * SÍ hay alguien esperando en vivo, así que un circuito abierto se rechaza en vez de esperarlo (ver
 * `convertirAMarkdown`), y una espera de más de `REPARACION_TIMEOUT_MS` responde en curso en vez de
 * dejar la petición colgada — la conversión sigue y siempre llega a un estado final por su cuenta.
 */
export async function repararDocumento(documentoId: number): Promise<ResultadoReparacion> {
  const actual = await documentoPorId(documentoId);
  if (!actual) throw new IngestaError('El documento ya no existe', 404);

  const [bloqueo] = await appSequelize.query<{ ok: boolean }>(
    'SELECT pg_try_advisory_lock(hashtext($1), $2::int) AS ok',
    { bind: [LOCK_NAMESPACE_DOCUMENTO, documentoId], type: QueryTypes.SELECT },
  );
  if (!bloqueo?.ok) {
    throw new IngestaError('Este documento se está procesando ahora mismo', 409);
  }

  try {
    const [enCola] = await appSequelize.query<{ job_id: number }>(
      `SELECT i.job_id FROM rag.ingest_item i
         JOIN rag.ingest_job j ON j.id = i.job_id
        WHERE i.documento_id = $1 AND i.estado IN ('pendiente', 'en_proceso') AND j.estado = 'en_curso'
        LIMIT 1`,
      { bind: [documentoId], type: QueryTypes.SELECT },
    );
    if (enCola) {
      throw new IngestaError(
        `Este documento está en la cola del trabajo #${enCola.job_id}; espere a que termine`,
        409,
      );
    }

    // Solo se rechaza si NINGUNA vía está disponible: con respaldo configurado, que el circuito
    // del proveedor activo esté abierto no impide nada — la conversión sale por el otro.
    const circuito = conversionBloqueada();
    if (circuito.bloqueada) {
      throw new IngestaError(
        `El servicio de conversión no responde ahora mismo; reinténtelo en ${circuito.segundosRestantes} s`,
        409,
      );
    }

    // El `.catch` inmediato evita un "unhandled rejection" si la conversión pierde la carrera
    // contra el timeout: sigue corriendo y su resultado se descarta, pero no debe tumbar el
    // proceso.
    const conversion = convertirDocumento(documentoId);
    conversion.catch(() => {});

    // El temporizador se cancela en cuanto CUALQUIERA de las dos ramas gana: sin `clearTimeout`,
    // el `setTimeout` perdedor queda vivo hasta sus 90 s completos (referenciando el event loop)
    // aunque ya nadie vaya a usar su resultado — un descuido que se nota justo en pruebas
    // automatizadas, que no cierran hasta que el proceso queda realmente libre de temporizadores.
    let temporizador: ReturnType<typeof setTimeout>;
    const resultado = await Promise.race<
      { tipo: 'ok' } | { tipo: 'error'; error: unknown } | { tipo: 'timeout' }
    >([
      conversion.then(() => ({ tipo: 'ok' as const })).catch((error) => ({ tipo: 'error' as const, error })),
      new Promise((resolve) => {
        temporizador = setTimeout(() => resolve({ tipo: 'timeout' as const }), REPARACION_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(temporizador!);

    if (resultado.tipo === 'timeout') {
      const documento = await documentoPorId(documentoId);
      return { documento: documento ?? actual, enCurso: true };
    }

    if (resultado.tipo === 'error') {
      // El único throw de `convertirDocumento` (aparte del 404 de arriba) es un `ConversionError`
      // reintentable: ya dejó el documento en 'pendiente' antes de relanzar. No es un fallo que
      // deba verse como un 500 — es exactamente lo que se espera de un circuito inestable.
      if (resultado.error instanceof ConversionError && resultado.error.reintentable) {
        const documento = await documentoPorId(documentoId);
        return {
          documento: documento ?? actual,
          mensaje: 'Fallo transitorio de conversión; el documento volvió a la cola y se reintentará solo.',
        };
      }
      throw resultado.error;
    }

    const documento = await documentoPorId(documentoId);
    return { documento: documento ?? actual };
  } finally {
    await appSequelize.query('SELECT pg_advisory_unlock(hashtext($1), $2::int)', {
      bind: [LOCK_NAMESPACE_DOCUMENTO, documentoId],
      type: QueryTypes.SELECT,
    });
  }
}

export interface FilaDocumento {
  id: number;
  nu_ann: string;
  nu_emi: string;
  nu_ane: number;
  titulo: string | null;
  numero_sgd: string | null;
  de_dep_emi: string | null;
  fe_emi: string | null;
  asunto: string | null;
  co_tip_doc: string | null;
  estado: string;
  contenido_sha256: string | null;
}

/** Fila cruda de `rag.documento`, con los campos que hacen falta para convertir o transcribir. */
export async function filaDeDocumento(documentoId: number): Promise<FilaDocumento | undefined> {
  const [doc] = await appSequelize.query<FilaDocumento>(
    `SELECT d.id, d.nu_ann, d.nu_emi, d.nu_ane, d.titulo, d.co_tip_doc,
            e.numero_sgd, d.de_dep_emi, d.fe_emi, d.asunto, d.estado, d.contenido_sha256
       FROM rag.documento d
       LEFT JOIN rag.expediente e ON e.nu_ann_exp = d.nu_ann_exp AND e.nu_sec_exp = d.nu_sec_exp
      WHERE d.id = $1`,
    { bind: [documentoId], type: QueryTypes.SELECT },
  );
  return doc;
}

/**
 * La cascada BD→disco de la Fase 1, aislada para que tanto `convertirDocumento` como la
 * extracción con IA (`visionService.ts`) obtengan los mismos bytes de la misma forma.
 */
export async function obtenerBytesDocumento(
  doc: Pick<FilaDocumento, 'nu_ann' | 'nu_emi' | 'nu_ane'>,
): Promise<ArchivoResuelto> {
  if (doc.nu_ane === 0) {
    const fila = await getArchivoDoc(doc.nu_ann, doc.nu_emi);
    return resolverDocumento(doc.nu_ann, doc.nu_emi, fila);
  }
  const fila = await getArchivoAnexo(doc.nu_ann, doc.nu_emi, doc.nu_ane);
  return resolverAnexo(doc.nu_ann, doc.nu_emi, doc.nu_ane, fila);
}

/**
 * Convierte UN documento: obtiene bytes (reutiliza la cascada BD→disco de la Fase 1), calcula el
 * sha256, y si ya existe ese contenido (D3: dedup por archivo) solo enlaza — nunca vuelve a pasar
 * por markitdown. Si es nuevo: convierte, limpia y trocea.
 */
export async function convertirDocumento(documentoId: number, onFase?: ReportarFase): Promise<void> {
  const doc = await filaDeDocumento(documentoId);
  if (!doc) throw new IngestaError('El documento ya no existe en rag.documento', 404);

  onFase?.({ fase: 'descargando' });
  await marcarEstado(doc.id, 'en_proceso');

  let buffer: Buffer;
  let nombreArchivo: string;
  try {
    const resuelto = await obtenerBytesDocumento(doc);
    buffer = resuelto.buffer;
    nombreArchivo = resuelto.filename;
  } catch (error) {
    // Que no haya archivo no siempre significa que no haya documento: los PROVEÍDOS y HOJAS DE
    // ENVÍO el SGD los renderiza al vuelo, y sus datos sí están en la BD.
    if (await convertirDocumentoGenerado(doc, onFase)) return;

    // Sin archivo digital (los ~76 % que hoy no están en BLOB ni en este disco) es un estado
    // legítimo, no un error: se marca aparte para no mezclarlo con fallos reales de conversión.
    await marcarEstado(doc.id, 'no_soportado', motivoDe(error));
    // Todas las salidas de esta función pasan por 'listo', incluidas las que NO convierten nada.
    // Sin esto, un documento sin archivo digital dejaría la barra clavada en 'descargando' justo
    // antes de que el panel saltara al siguiente: parecería que algo se quedó a medias cuando en
    // realidad terminó (con ese resultado) en milisegundos.
    onFase?.({ fase: 'listo' });
    return;
  }

  onFase?.({ fase: 'deduplicando' });
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (await enlazarSiYaExiste(doc, sha256)) {
    onFase?.({ fase: 'listo' });
    return;
  }

  let markdown: string;
  let ms: number;
  let metodo: string;
  try {
    // markitdown detecta el tipo de archivo por la EXTENSIÓN del nombre (mineru, por el contenido
    // real): en ambos casos hay que pasarle el nombre real resuelto (con su .pdf/.docx/...), nunca
    // el título humano ("INFORME N° 29...", sin extensión), que ambos rechazan con 400.
    ({ markdown, ms, metodo } = await convertirAMarkdownActivo(buffer, nombreArchivo, onFase));
  } catch (error) {
    if (error instanceof ConversionError && !error.reintentable) {
      await marcarEstado(doc.id, 'error', error.motivo);
      onFase?.({ fase: 'listo' });
      return;
    }
    // Reintentable (circuito abierto, timeout, red): el ÍTEM de este job se marca 'error' en
    // ejecutarJobConversion, pero el DOCUMENTO debe volver a 'pendiente' — si no, se queda
    // huérfano en 'en_proceso' para siempre, invisible para cualquier job futuro, que solo mira
    // `estado = 'pendiente'`. Encontrado en producción: el circuito se abrió durante una prueba
    // manual y dejó 224 documentos así, sin ningún error visible en `rag.documento`.
    await marcarEstadoPendiente(doc.id);
    onFase?.({ fase: 'listo' });
    throw error;
  }

  await guardarMarkdown(doc, sha256, markdown, {
    // El proveedor que realmente lo consiguió, que tras un fallback NO es el activo.
    metodo,
    bytes: buffer.length,
    mime: mimePorNombre(nombreArchivo),
    ms,
  }, onFase);
}

/**
 * Documentos que el SGD no almacena porque los renderiza on-demand (PROVEÍDO 232, HOJA DE ENVÍO
 * 304): son el 82 % de los que hoy quedan en `no_soportado`. Se arma el markdown DIRECTAMENTE
 * desde los datos estructurados de la BD, sin dibujar el PDF para volver a extraerlo: el
 * ida y vuelta solo perdería la estructura que ya tenemos y gastaría una conversión en markitdown,
 * que está serializado y es el cuello de botella del pipeline.
 *
 * El tipo se decide sobre el valor VIVO del SGD, nunca sobre `rag.documento.co_tip_doc`: esa copia
 * se escribió la primera vez que el barrido vio el documento y el SGD la cambia después (un
 * PROVEÍDO en borrador con código '001' pasa a '232' al emitirse). Filtrar por la copia dejaba 16
 * documentos generables marcados "sin archivo" para siempre. Es el mismo orden que usa
 * `documentoController.generarSiCorresponde`, que siempre lo hizo bien.
 */
async function convertirDocumentoGenerado(doc: FilaDocumento, onFase?: ReportarFase): Promise<boolean> {
  const datos = await getDatosDocumentoGenerado(doc.nu_ann, doc.nu_emi);
  // `getDatosDocumentoGenerado` no filtra por tipo: devuelve fila para CUALQUIER remito. Sin este
  // control, un INFORME sin archivo generaría un markdown degenerado (título y poco más) que
  // entraría al corpus como si fuera el documento.
  if (!datos || !esGenerable(datos.coTipDoc)) return false;

  onFase?.({ fase: 'generando' });

  if (datos.coTipDoc && datos.coTipDoc !== doc.co_tip_doc) {
    await appSequelize.query('UPDATE rag.documento SET co_tip_doc = $2 WHERE id = $1', {
      bind: [doc.id, datos.coTipDoc],
      type: QueryTypes.UPDATE,
    });
  }

  const markdown = datosAMarkdown(datos);
  // No hay bytes de archivo de origen que hashear: la clave de contenido sale del propio markdown,
  // de modo que reejecutar la ingesta sobre el mismo documento sea idempotente.
  const sha256 = crypto.createHash('sha256').update(markdown).digest('hex');
  if (await enlazarSiYaExiste(doc, sha256)) {
    onFase?.({ fase: 'listo' });
    return true;
  }

  await guardarMarkdown(doc, sha256, markdown, {
    metodo: 'generado',
    bytes: Buffer.byteLength(markdown),
    mime: 'text/markdown',
    ms: 0,
  }, onFase);
  return true;
}

/**
 * Si ese contenido ya se convirtió antes, enlaza el documento y devuelve `true` — el llamador no
 * tiene que volver a convertir nada. Es el ahorro medido del 12,9 % de deduplicación.
 */
export async function enlazarSiYaExiste(doc: FilaDocumento, sha256: string): Promise<boolean> {
  const existente = await appSequelize.query<{ chunks_generados: number; markdown: string | null }>(
    'SELECT chunks_generados, markdown FROM rag.contenido WHERE sha256 = $1',
    { bind: [sha256], type: QueryTypes.SELECT },
  );
  if (existente.length === 0) return false;

  const fila = existente[0];

  if (fila.chunks_generados > 0) {
    await appSequelize.query(
      `UPDATE rag.documento SET contenido_sha256 = $2, estado = 'convertido' WHERE id = $1`,
      { bind: [doc.id, sha256], type: QueryTypes.UPDATE },
    );
    return true;
  }

  // chunks_generados=0: o este sha256 nunca produjo texto aprovechable (candidato a REINTENTAR
  // de verdad), o el recolector de basura (Fase 6, mantenimientoService.ejecutarGC) borró los
  // chunks de un markdown que en su momento SÍ era bueno. Se distinguen por longitud: solo el
  // segundo caso se reconstruye desde caché (D1: cuesta segundos, no hace falta volver a pasar
  // por markitdown); el primero se deja pasar (`return false`) para que el llamador reintente la
  // conversión real — devolver `true` aquí, como se hacía antes, dejaba cualquier reintento
  // (manual o "Reparar recuperables") atascado repitiendo para siempre el mismo resultado vacío
  // sin volver a llamar a markitdown.
  if (fila.markdown && !limpiarMarkdown(fila.markdown).sinTexto) {
    const chunksReconstruidos = trocear(fila.markdown);
    if (chunksReconstruidos.length > 0) {
      await guardarChunksYMarcarConvertido(doc.id, sha256, cabeceraDe(doc), chunksReconstruidos);
      return true;
    }
  }
  return false;
}

/** Guarda el contenido convertido, lo trocea y deja el documento en su estado final. */
export async function guardarMarkdown(
  doc: FilaDocumento,
  sha256: string,
  markdown: string,
  origen: { metodo: string; bytes: number; mime: string; ms: number },
  onFase?: ReportarFase,
): Promise<void> {
  onFase?.({ fase: 'troceando' });
  const limpio = limpiarMarkdown(markdown);

  // `DO UPDATE ... WHERE chunks_generados = 0`: si ya existe una fila para este sha256 pero
  // nunca produjo chunks (el caso que `enlazarSiYaExiste` ahora deja reintentar), un reintento
  // que sí consigue texto (markitdown de nuevo, o el rescate de OCR) debe reemplazar el
  // markdown/método vacíos guardados antes — si no, el chunking de abajo usaría el texto nuevo
  // (correcto) pero "Ver markdown" y la columna "Método" seguirían mostrando para siempre el
  // resultado vacío del primer intento. Nunca pisa una fila que ya tiene chunks reales.
  await appSequelize.query(
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
    await appSequelize.query(
      'UPDATE rag.documento SET contenido_sha256 = $2, estado = $3 WHERE id = $1',
      { bind: [doc.id, sha256, 'sin_texto'], type: QueryTypes.UPDATE },
    );
    onFase?.({ fase: 'listo' });
    return;
  }

  onFase?.({ fase: 'guardando' });
  await guardarChunksYMarcarConvertido(doc.id, sha256, cabeceraDe(doc), trocear(limpio.markdown));
  onFase?.({ fase: 'listo' });
}

function cabeceraDe(doc: FilaDocumento): string {
  return construirCabecera({
    titulo: doc.titulo,
    numeroExpediente: doc.numero_sgd,
    dependencia: doc.de_dep_emi,
    fecha: doc.fe_emi,
    asunto: doc.asunto,
  });
}

/**
 * Inserta los chunks ya troceados y marca contenido+documento como convertidos. Compartido por el
 * camino de conversión nueva y el de reconstrucción desde markdown ya guardado (Fase 6: el
 * recolector de basura pudo haber borrado los chunks de este `sha256` por quedar huérfanos).
 */
async function guardarChunksYMarcarConvertido(
  documentoId: number,
  sha256: string,
  cabecera: string,
  chunks: Chunk[],
): Promise<void> {
  await appSequelize.transaction(async (tx) => {
    for (const chunk of chunks) {
      await appSequelize.query(
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

    await appSequelize.query(
      `UPDATE rag.contenido SET chunks_generados = $2, fe_chunking = now() WHERE sha256 = $1`,
      { bind: [sha256, chunks.length], type: QueryTypes.UPDATE, transaction: tx },
    );

    await appSequelize.query(
      `UPDATE rag.documento SET contenido_sha256 = $2, estado = 'convertido' WHERE id = $1`,
      { bind: [documentoId, sha256], type: QueryTypes.UPDATE, transaction: tx },
    );
  });
}

async function marcarEstado(documentoId: number, estado: string, motivo?: string): Promise<void> {
  await appSequelize.query(
    `UPDATE rag.documento SET estado = $2, motivo_error = $3, intentos = intentos + 1 WHERE id = $1`,
    { bind: [documentoId, estado, motivo ?? null], type: QueryTypes.UPDATE },
  );
}

/**
 * Devuelve el documento a `pendiente` tras un fallo reintentable, SIN volver a incrementar
 * `intentos`: el intento ya se contó al marcar `en_proceso` al principio de `convertirDocumento`;
 * contarlo de nuevo aquí duplicaría el número por cada fallo transitorio.
 */
async function marcarEstadoPendiente(documentoId: number): Promise<void> {
  await appSequelize.query(
    `UPDATE rag.documento SET estado = 'pendiente' WHERE id = $1`,
    { bind: [documentoId], type: QueryTypes.UPDATE },
  );
}

function motivoDe(error: unknown): string {
  return error instanceof Error ? error.message : 'error desconocido';
}

// ── Job de EMBEDDINGS (implementado y probado; bloqueado hoy por falta de proveedor) ────────────

const TAMANO_LOTE = 16;

export async function iniciarJobEmbedding(
  filtro: FiltroIngesta,
  actor: string,
  providerOverride?: EmbeddingProvider,
): Promise<{ jobId: number }> {
  const disponibilidad = embeddingsDisponibles();
  if (!disponibilidad.disponible) {
    throw new IngestaError(
      `No se puede iniciar la ingesta de embeddings: ${disponibilidad.motivo}`,
      409,
    );
  }

  const provider = providerOverride ?? crearEmbeddingProvider();
  await registrarSiNoExiste(provider);

  const activo = await modeloActivo();
  if (!activo) {
    throw new IngestaError(
      'No hay ningún modelo de embeddings activo. Actívelo desde /api/rag/modelos antes de '
        + 'iniciar la ingesta — es una decisión administrativa, no automática.',
      409,
    );
  }
  if (activo.proveedor !== provider.nombre || activo.modelo !== provider.modelo) {
    throw new IngestaError(
      `El modelo activo (${activo.proveedor}/${activo.modelo}) no coincide con el proveedor `
        + `configurado (${provider.nombre}/${provider.modelo}). Mezclar espacios vectoriales `
        + 'rompe la búsqueda en silencio: se rechaza en vez de intentarlo.',
      409,
    );
  }

  // Comprobación real, no solo de configuración: si Ollama no está levantado, esto lo dice ahora
  // y no a mitad de un lote 40.
  await provider.comprobar();

  const tabla = tablaVectores(activo.dimension);
  const chunkIds = await idsChunksPendientes(activo.id, tabla, filtro);
  if (chunkIds.length === 0) {
    throw new IngestaError('No hay chunks pendientes de embeber con ese filtro', 404);
  }

  const [{ id: jobId }] = await appSequelize.query<{ id: number }>(
    `INSERT INTO rag.ingest_job (tipo, estado, filtro, total, creado_por)
     VALUES ('embedding', 'en_curso', $1::jsonb, $2, $3) RETURNING id`,
    { bind: [JSON.stringify(filtro), chunkIds.length, actor], type: QueryTypes.SELECT },
  );

  // La lista de IDs se calcula UNA vez aquí y se pasa entera al worker: si el worker volviera a
  // consultar "pendientes" por su cuenta con un filtro distinto (como ocurría antes de este
  // arreglo), un job acotado a un expediente terminaría procesando todo el sistema, y el "total"
  // reportado no coincidiría con el trabajo real.
  void ejecutarJobEmbedding(jobId, provider, activo.id, tabla, chunkIds).catch((error) => {
    console.error(`ingesta: job de embeddings ${jobId} falló:`, error);
  });

  return { jobId };
}

/** IDs de chunks que aún no tienen vector del modelo dado, respetando el filtro del job. */
async function idsChunksPendientes(
  modeloId: number,
  tabla: string,
  filtro: FiltroIngesta,
): Promise<number[]> {
  const condiciones = [
    `NOT EXISTS (SELECT 1 FROM rag.${tabla} v WHERE v.chunk_id = c.id AND v.modelo_id = $1)`,
    'd.vigente',
  ];
  const binds: unknown[] = [modeloId];

  if (filtro.nuAnnExp && filtro.nuSecExp) {
    binds.push(filtro.nuAnnExp, filtro.nuSecExp);
    condiciones.push(`d.nu_ann_exp = $${binds.length - 1} AND d.nu_sec_exp = $${binds.length}`);
  }
  if (filtro.documentoIds && filtro.documentoIds.length > 0) {
    binds.push(filtro.documentoIds);
    condiciones.push(`d.id = ANY($${binds.length}::bigint[])`);
  }

  const limite = Math.min(filtro.limite ?? 2000, 20_000);
  binds.push(limite);

  const filas = await appSequelize.query<{ id: number }>(
    `SELECT DISTINCT c.id
       FROM rag.chunk c
       JOIN rag.documento d ON d.contenido_sha256 = c.sha256
      WHERE ${condiciones.join(' AND ')}
      ORDER BY c.id LIMIT $${binds.length}`,
    { bind: binds, type: QueryTypes.SELECT },
  );
  return filas.map((f) => f.id);
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

  // Se recorre la lista de IDs ya fijada al iniciar el job (no se vuelve a preguntar "qué falta"
  // en cada vuelta): así el índice siempre avanza, sin importar si un lote falla, y no hay riesgo
  // de reprocesar el mismo lote para siempre.
  for (let i = 0; i < chunkIds.length; i += TAMANO_LOTE) {
    const idsLote = chunkIds.slice(i, i + TAMANO_LOTE);
    const lote = await appSequelize.query<{ id: number; texto: string; cabecera_ctx: string | null }>(
      'SELECT id, texto, cabecera_ctx FROM rag.chunk WHERE id = ANY($1::bigint[]) ORDER BY id',
      { bind: [idsLote], type: QueryTypes.SELECT },
    );
    if (lote.length === 0) continue; // el chunk pudo borrarse entre el listado y el proceso

    // Lo que se embebe es cabecera + texto; lo que se cita después es solo el texto.
    const textos = lote.map((c) => [c.cabecera_ctx, c.texto].filter(Boolean).join('\n'));

    try {
      const { vectores, uso } = await provider.embeber(textos);

      await registrarUso(jobId, provider, 'embedding', uso, true);

      await appSequelize.transaction(async (tx) => {
        for (let j = 0; j < lote.length; j++) {
          await appSequelize.query(
            `INSERT INTO rag.${tabla} (chunk_id, modelo_id, vec) VALUES ($1, $2, $3)
             ON CONFLICT (modelo_id, chunk_id) DO NOTHING`,
            { bind: [lote[j].id, modeloId, JSON.stringify(vectores[j])], type: QueryTypes.INSERT, transaction: tx },
          );
        }
      });

      await appSequelize.query('UPDATE rag.ingest_job SET procesados = procesados + $2 WHERE id = $1', {
        bind: [jobId, lote.length],
        type: QueryTypes.UPDATE,
      });

      // Un documento pasa a 'ok' cuando TODOS sus chunks tienen vector del modelo activo.
      await marcarDocumentosCompletos(modeloId, tabla);
      lotesFallidosSeguidos = 0;
    } catch (error) {
      // Todo intento, exitoso o no, se cobra: los tokens fallidos también salieron de la cuota.
      if (error instanceof ErrorIA) {
        await registrarUso(jobId, provider, 'embedding', { tokensIn: 0, tokensOut: 0, estimado: true }, false);
        if (!error.permiteFailover) {
          // 'auth' o 'context_length': no tiene sentido reintentar el resto del job igual.
          await appSequelize.query(
            `UPDATE rag.ingest_job SET estado='error', mensaje=$2, fe_fin=now() WHERE id=$1`,
            { bind: [jobId, error.message], type: QueryTypes.UPDATE },
          );
          return;
        }
      }

      await appSequelize.query('UPDATE rag.ingest_job SET errores = errores + $2 WHERE id = $1', {
        bind: [jobId, lote.length],
        type: QueryTypes.UPDATE,
      });

      // Un lote que falla no aborta el job (podría ser un error transitorio), pero varios
      // seguidos sí son una señal de que algo estructural está mal (ej. la BD sin partición para
      // este modelo) y seguir solo acumularía cientos de "errores" idénticos sin avanzar nada.
      lotesFallidosSeguidos++;
      if (lotesFallidosSeguidos >= 3) {
        huboErrorFatal = true;
        await appSequelize.query(
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
    await appSequelize.query(
      `UPDATE rag.ingest_job SET estado = 'completado', fe_fin = now() WHERE id = $1 AND estado != 'error'`,
      { bind: [jobId], type: QueryTypes.UPDATE },
    );

    // Construye el índice HNSW AHORA que hay datos (ver el comentario largo en
    // embeddingModelService.ts): idempotente, así que un job de re-embedding posterior no repite
    // el trabajo. Un job que no logró embeber nada (chunkIds vacío, ya descartado antes de
    // llegar aquí) no llegaría a este punto de todos modos.
    try {
      await crearIndiceHnsw(modeloId, provider.dimension);
    } catch (error) {
      console.error(`ingesta: no se pudo crear/confirmar el índice HNSW del job ${jobId}:`, error);
    }
  }
}

async function marcarDocumentosCompletos(modeloId: number, tabla: string): Promise<void> {
  await appSequelize.query(
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
  await appSequelize.query(
    `INSERT INTO rag.uso_token (job_id, proveedor, modelo, operacion, tokens_in, tokens_out, estimado, exito)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    {
      bind: [jobId, provider.nombre, provider.modelo, operacion, uso.tokensIn, uso.tokensOut, uso.estimado, exito],
      type: QueryTypes.INSERT,
    },
  );
}

// ── Consulta de estado ───────────────────────────────────────────────────────

export async function estadoJob(jobId: number) {
  const [job] = await appSequelize.query<{ id: number }>(
    `SELECT id, tipo, estado, filtro, total, procesados, errores, mensaje,
            fe_inicio::text AS "feInicio", fe_fin::text AS "feFin"
       FROM rag.ingest_job WHERE id = $1`,
    { bind: [jobId], type: QueryTypes.SELECT },
  );
  if (!job) throw new IngestaError('El trabajo no existe', 404);

  const proceso = progresoJob(jobId);
  const ahora = Date.now();
  return {
    ...job,
    procesoActual: proceso && {
      documentoId: proceso.documentoId,
      titulo: proceso.titulo,
      // Se conserva en SEGUNDOS: es texto para el humano ("— 42 s") y ya lo consumen el panel y
      // los tests existentes.
      segundos: Math.round((ahora - proceso.desde) / 1000),
      fase: proceso.fase,
      // Duración, nunca un instante. Mandar `faseDesde` obligaría al navegador a restarlo de SU
      // propio reloj, y dos máquinas desalineadas (un cliente 40 s adelantado es habitual en una
      // red de oficina) darían una barra que arranca ya al final de su tramo, o que no arranca
      // nunca. Con una duración, el navegador solo suma lo que él mismo ha contado desde que
      // recibió la respuesta: el único error posible es la latencia de esa respuesta.
      faseMs: ahora - proceso.faseDesde,
      faseLimiteMs: proceso.limiteMs,
      proveedor: proceso.proveedor,
      intento: proceso.intento,
      intentos: proceso.intentos,
      motivoFallback: proceso.motivoFallback,
    },
  };
}

export async function listarJobs(limite = 20) {
  return appSequelize.query(
    `SELECT id, tipo, estado, total, procesados, errores, creado_por AS "creadoPor",
            fe_inicio::text AS "feInicio", fe_fin::text AS "feFin"
       FROM rag.ingest_job ORDER BY fe_inicio DESC LIMIT $1`,
    { bind: [Math.min(limite, 100)], type: QueryTypes.SELECT },
  );
}

// ── Recuperación tras reinicio ────────────────────────────────────────────

/**
 * Reclama leases vencidos y reanuda jobs de conversión interrumpidos.
 *
 * Cubre exactamente lo que el diseño (`docs/PLAN-RAG.md` §4) prometía y el código no hacía
 * todavía: "FOR UPDATE SKIP LOCKED + lease_hasta da visibility timeout y recuperación tras
 * reinicio sin ninguna librería". El `lease_hasta` se fijaba al tomar un ítem, pero nada lo
 * comprobaba — un ítem que se quedara `en_proceso` (proceso caído, o el propio backend
 * reiniciado) quedaba huérfano para siempre, con su `rag.documento` también atascado en
 * `en_proceso`. Se descubrió en producción: un documento de 9,2 MB dejó un job de 500 congelado
 * 45 minutos sin ningún error registrado (ver nota en `mdConvertService.ts`).
 *
 * Se ejecuta al arrancar el servidor. Los jobs de **embeddings** interrumpidos no se reanudan
 * solos: necesitan un `EmbeddingProvider` real, y reconstruirlo automáticamente sin saber si
 * sigue disponible sería más arriesgado que dejar que un administrador lo reinicie a mano.
 */
export async function reanudarJobsInterrumpidos(): Promise<void> {
  const itemsReclamados = await appSequelize.query<{ id: number; job_id: number; documento_id: number }>(
    `UPDATE rag.ingest_item
        SET estado = 'pendiente', lease_hasta = NULL
      WHERE estado = 'en_proceso' AND lease_hasta < now()
      RETURNING id, job_id, documento_id`,
    { type: QueryTypes.SELECT },
  );

  if (itemsReclamados.length === 0) return;

  console.log(`Ingesta: ${itemsReclamados.length} ítem(s) con lease vencido reclamado(s) tras el reinicio.`);

  const documentoIds = itemsReclamados.map((i) => i.documento_id);
  await appSequelize.query(
    `UPDATE rag.documento SET estado = 'pendiente'
      WHERE id = ANY($1::bigint[]) AND estado = 'en_proceso'`,
    { bind: [documentoIds], type: QueryTypes.UPDATE },
  );

  const jobIds = [...new Set(itemsReclamados.map((i) => i.job_id))];
  const jobs = await appSequelize.query<{ id: number; tipo: string }>(
    `SELECT id, tipo FROM rag.ingest_job WHERE id = ANY($1::bigint[]) AND estado = 'en_curso'`,
    { bind: [jobIds], type: QueryTypes.SELECT },
  );

  for (const job of jobs) {
    // 'reparacion' corre exactamente el mismo ejecutor que 'conversion' — solo cambió qué
    // documentos se seleccionaron al crear el job, no cómo se procesan sus ítems.
    if (job.tipo === 'conversion' || job.tipo === 'reparacion') {
      console.log(`Ingesta: reanudando job de ${job.tipo} #${job.id} tras el reinicio.`);
      void ejecutarJobConversion(job.id).catch((error) => {
        console.error(`ingesta: job de ${job.tipo} ${job.id} (reanudado) falló:`, error);
      });
    } else {
      // Los de embedding necesitan un EmbeddingProvider real; no se reconstruyen solos.
      await appSequelize.query(
        `UPDATE rag.ingest_job SET estado = 'error',
                mensaje = 'Interrumpido por un reinicio del servidor. Vuelva a iniciarlo.',
                fe_fin = now()
          WHERE id = $1`,
        { bind: [job.id], type: QueryTypes.UPDATE },
      );
    }
  }
}
