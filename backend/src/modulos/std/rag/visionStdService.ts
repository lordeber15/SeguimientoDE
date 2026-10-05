import crypto from 'crypto';
import { QueryTypes } from 'sequelize';
import { stdRagSequelize } from '../config/stdRagDatabase';
import { crearVisionProvider, visionDisponible } from '../../../compartido/ai/providerFactory';
import { ErrorIA, type VisionProvider } from '../../../compartido/ai/types';
import { PROMPT_TRANSCRIPCION } from '../../../compartido/rag/promptTranscripcion';
import { ArchivoStdError, limpiarMime } from '../services/stdStorageService';
import { documentoPorIdStd, type DocumentoRagStd } from './estadoStdService';
import {
  enlazarSiYaExiste,
  filaDeDocumento,
  guardarMarkdown,
  IngestaStdError,
  obtenerBytesDocumentoStd,
} from './ingestaStdService';

/**
 * Extracción de texto con IA de visión para el STD — mismo diseño que
 * `modulos/sgd/rag/visionService.ts`: último recurso MANUAL, un documento a la vez, y nunca
 * importado desde `ingestaStdService.ts`, así que ningún job puede gastar un token solo.
 *
 * Diferencias con el SGD:
 *   - También se ofrece sobre `no_soportado`: en el STD esa etiqueta la puso a veces un fallo de
 *     lectura que no era "no existe" (ver `convertirDocumento`). Si el archivo de verdad no está,
 *     se rechaza aquí mismo con un 409 claro, antes de construir el proveedor.
 *   - No hay "documento generado" que preferir: en el STD todo es un archivo subido.
 *   - El tipo se decide por los BYTES, no por el nombre — hay PDF guardados como `….pdf.tmp`.
 *
 * El techo diario de tokens se cuenta sobre `std_rag.rag.uso_token`: es independiente del del SGD.
 */

const ESTADOS_PERMITIDOS = new Set(['sin_texto', 'error', 'no_soportado']);

const MIMES_PERMITIDOS = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const TAMANO_MAXIMO_BYTES = Number(process.env.RAG_VISION_MAX_BYTES ?? 20 * 1024 * 1024);

const TOKENS_MAXIMOS_DIA = Number(process.env.RAG_VISION_TOKENS_DIA ?? 500_000);

/** MIME por firma de bytes; si no se reconoce, el que registró el STD. */
function mimeDeContenido(buffer: Buffer, mimeStd: string | null): string {
  const cabecera = buffer.subarray(0, 12);
  if (cabecera.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (cabecera.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (cabecera.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (cabecera.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (cabecera.subarray(0, 4).toString('latin1') === 'RIFF' && cabecera.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return limpiarMime(mimeStd);
}

async function tokensVisionHoy(): Promise<number> {
  const [{ total }] = await stdRagSequelize.query<{ total: string }>(
    `SELECT COALESCE(sum(tokens_in + tokens_out), 0)::text AS total
       FROM rag.uso_token WHERE operacion = 'vision' AND fe >= date_trunc('day', now())`,
    { type: QueryTypes.SELECT },
  );
  return Number(total);
}

async function registrarUsoVision(
  provider: VisionProvider,
  uso: { tokensIn: number; tokensOut: number; estimado: boolean },
  exito: boolean,
): Promise<void> {
  await stdRagSequelize.query(
    `INSERT INTO rag.uso_token (proveedor, modelo, operacion, tokens_in, tokens_out, estimado, exito)
     VALUES ($1, $2, 'vision', $3, $4, $5, $6)`,
    {
      bind: [provider.nombre, provider.modelo, uso.tokensIn, uso.tokensOut, uso.estimado, exito],
      type: QueryTypes.INSERT,
    },
  );
}

/** Barreras de más barata a más cara: nunca se construye el proveedor si algo antes lo descarta. */
export async function transcribirDocumentoStd(documentoId: number): Promise<DocumentoRagStd> {
  const doc = await filaDeDocumento(documentoId);
  if (!doc) throw new IngestaStdError('El documento ya no existe en rag.documento (std_rag)', 404);

  const disponibilidad = visionDisponible();
  if (!disponibilidad.disponible) {
    throw new IngestaStdError(disponibilidad.motivo ?? 'La extracción con IA no está disponible', 409);
  }

  if (!ESTADOS_PERMITIDOS.has(doc.estado)) {
    throw new IngestaStdError(
      'La extracción con IA es un último recurso: solo se ofrece sobre documentos "sin texto", '
        + '"con error" o "sin archivo".',
      409,
    );
  }

  const tokensHoy = await tokensVisionHoy();
  if (tokensHoy >= TOKENS_MAXIMOS_DIA) {
    throw new IngestaStdError(
      `Se alcanzó el límite diario de tokens de extracción con IA del STD (${TOKENS_MAXIMOS_DIA.toLocaleString('es-PE')}). Inténtelo mañana.`,
      409,
    );
  }

  let archivo: Awaited<ReturnType<typeof obtenerBytesDocumentoStd>>;
  try {
    archivo = await obtenerBytesDocumentoStd(doc);
  } catch (error) {
    if (error instanceof ArchivoStdError) {
      throw new IngestaStdError(
        error.status === 404
          ? 'Este documento no tiene archivo en el repositorio del STD; no hay nada que extraer con IA.'
          : `No se puede leer el archivo: ${error.message}`,
        409,
      );
    }
    throw error;
  }

  const mime = mimeDeContenido(archivo.buffer, doc.mime);
  if (!MIMES_PERMITIDOS.has(mime)) {
    throw new IngestaStdError(
      `Tipo de archivo no admitido para extracción con IA (${mime}). Solo PDF e imágenes.`,
      409,
    );
  }

  if (archivo.buffer.length > TAMANO_MAXIMO_BYTES) {
    const mb = (archivo.buffer.length / (1024 * 1024)).toFixed(1);
    const limiteMb = (TAMANO_MAXIMO_BYTES / (1024 * 1024)).toFixed(0);
    throw new IngestaStdError(`El archivo pesa ${mb} MB; el límite para extracción con IA es ${limiteMb} MB.`, 409);
  }

  const provider = crearVisionProvider();

  // Espacio de nombres propio, por la misma razón que en el SGD: el sha256 del archivo tal cual ya
  // apunta al markdown inútil que dejó markitdown, y reutilizarlo tiraría la transcripción buena.
  const shaArchivo = crypto.createHash('sha256').update(archivo.buffer).digest('hex');
  const sha256 = crypto.createHash('sha256').update(`vision:${provider.modelo}:${shaArchivo}`).digest('hex');

  if (doc.contenido_sha256 && doc.contenido_sha256 !== sha256) {
    await stdRagSequelize.query('UPDATE rag.documento SET sha256_anterior = $2 WHERE id = $1', {
      bind: [doc.id, doc.contenido_sha256],
      type: QueryTypes.UPDATE,
    });
  }

  // Ya se transcribió este archivo con este modelo (quizá enlazado desde otro N° STD): ni un token más.
  if (await enlazarSiYaExiste(doc, sha256)) return leerDocumentoActualizado(doc.id);

  let resultado: Awaited<ReturnType<VisionProvider['transcribir']>>;
  try {
    resultado = await provider.transcribir(
      { nombre: archivo.filename, mime, datos: archivo.buffer },
      PROMPT_TRANSCRIPCION,
    );
  } catch (error) {
    await registrarUsoVision(provider, { tokensIn: 0, tokensOut: 0, estimado: true }, false);
    if (error instanceof ErrorIA) throw new IngestaStdError(error.message, 409);
    throw error;
  }

  await registrarUsoVision(provider, resultado.uso, true);

  await guardarMarkdown(doc, sha256, resultado.texto, {
    metodo: 'vision',
    bytes: Buffer.byteLength(resultado.texto),
    mime: 'text/markdown',
    ms: 0,
  });

  return leerDocumentoActualizado(doc.id);
}

async function leerDocumentoActualizado(documentoId: number): Promise<DocumentoRagStd> {
  const actualizado = await documentoPorIdStd(documentoId);
  if (!actualizado) {
    throw new IngestaStdError('El documento se procesó pero ya no se pudo volver a leer', 500);
  }
  return actualizado;
}
