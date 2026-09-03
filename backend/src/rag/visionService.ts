import crypto from 'crypto';
import { QueryTypes } from 'sequelize';
import { appSequelize } from '../config/appDatabase';
import { crearVisionProvider, visionDisponible } from '../ai/providerFactory';
import { ErrorIA, type VisionProvider } from '../ai/types';
import { esGenerable } from '../services/documentoGeneradoService';
import { getDatosDocumentoGenerado } from '../services/documentoService';
import { ArchivoError, mimePorNombre } from '../services/storageService';
import { documentoPorId, type DocumentoRag } from './estadoService';
import {
  enlazarSiYaExiste,
  filaDeDocumento,
  guardarMarkdown,
  IngestaError,
  obtenerBytesDocumento,
} from './ingestaService';

/**
 * Extracción de texto con IA de visión — el último recurso manual para documentos que markitdown
 * ya dejó `sin_texto` o `error`. Deliberadamente NO se importa desde `ingestaService.ts`: ni el
 * job de conversión ni el de reparación masiva pueden alcanzar este módulo, así que ninguno de
 * los dos puede gastar un token sin que alguien pulse el botón a propósito.
 */

const MIMES_PERMITIDOS = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Antes de codificar en base64 (que infla 4/3). El límite real de la API es 50 MB combinados. */
const TAMANO_MAXIMO_BYTES = Number(process.env.RAG_VISION_MAX_BYTES ?? 20 * 1024 * 1024);

/** Techo de gasto diario: la diferencia entre que un error de uso cueste un dólar o cien. */
const TOKENS_MAXIMOS_DIA = Number(process.env.RAG_VISION_TOKENS_DIA ?? 500_000);

export const PROMPT_TRANSCRIPCION =
  'Eres un transcriptor de documentos oficiales. Tu única tarea es transcribir el TEXTO de este '
  + 'documento en markdown, de forma literal y completa, en el orden de lectura normal.\n\n'
  + 'Reglas estrictas:\n'
  + '- Transcribe TODO el texto visible, sin omitir nada.\n'
  + '- NUNCA resumas, interpretes, traduzcas ni corrijas la ortografía o redacción original.\n'
  + '- Conserva EXACTOS los números, fechas, números de documento y de expediente, nombres de '
  + 'personas y dependencias, y el contenido de firmas y sellos, tal como aparecen.\n'
  + '- Las tablas van como tablas markdown; los títulos y encabezados, como encabezados markdown '
  + '(#, ##, ###).\n'
  + '- Un fragmento ilegible se marca como [ilegible]: nunca se adivina ni se omite en silencio.\n'
  + '- Si una página no tiene texto (está en blanco o es solo una imagen sin texto), no escribas '
  + 'nada sobre ella — NUNCA la describas ("esta página muestra...", "parece un sello...").\n'
  + '- NUNCA describas el documento ni expliques de qué trata: solo transcribe su texto.\n'
  + '- No agregues ningún preámbulo, comentario ni conclusión: la salida es únicamente el markdown '
  + 'transcrito.';

async function tokensVisionHoy(): Promise<number> {
  const [{ total }] = await appSequelize.query<{ total: string }>(
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
  await appSequelize.query(
    `INSERT INTO rag.uso_token (proveedor, modelo, operacion, tokens_in, tokens_out, estimado, exito)
     VALUES ($1, $2, 'vision', $3, $4, $5, $6)`,
    {
      bind: [provider.nombre, provider.modelo, uso.tokensIn, uso.tokensOut, uso.estimado, exito],
      type: QueryTypes.INSERT,
    },
  );
}

/**
 * Transcribe UN documento con IA de visión. Las barreras van de más barata a más cara: nunca se
 * construye el proveedor ni se leen bytes si algo anterior ya lo descarta.
 */
export async function transcribirDocumento(documentoId: number): Promise<DocumentoRag> {
  const doc = await filaDeDocumento(documentoId);
  if (!doc) throw new IngestaError('El documento ya no existe en rag.documento', 404);

  const disponibilidad = visionDisponible();
  if (!disponibilidad.disponible) {
    throw new IngestaError(disponibilidad.motivo ?? 'La extracción con IA no está disponible', 409);
  }

  const tokensHoy = await tokensVisionHoy();
  if (tokensHoy >= TOKENS_MAXIMOS_DIA) {
    throw new IngestaError(
      `Se alcanzó el límite diario de tokens de extracción con IA (${TOKENS_MAXIMOS_DIA.toLocaleString('es-PE')}). Inténtelo mañana.`,
      409,
    );
  }

  if (doc.estado !== 'sin_texto' && doc.estado !== 'error') {
    throw new IngestaError(
      'La extracción con IA es un último recurso: solo se ofrece sobre documentos "sin texto" o "con error".',
      409,
    );
  }

  // Si el tipo VIVO del SGD es generable, `datosAMarkdown` da mejor resultado (estructurado,
  // gratis) que un viaje por visión — que además aplanaría la tabla de destinos. Es la barrera
  // que evita el gasto accidental más probable.
  const datosGenerado = await getDatosDocumentoGenerado(doc.nu_ann, doc.nu_emi);
  if (esGenerable(datosGenerado?.coTipDoc)) {
    throw new IngestaError(
      'Este documento se reconstruye desde los datos del SGD; use "Reintentar" — es gratis e instantáneo.',
      409,
    );
  }

  let archivo: Awaited<ReturnType<typeof obtenerBytesDocumento>>;
  try {
    archivo = await obtenerBytesDocumento(doc);
  } catch (error) {
    if (error instanceof ArchivoError) {
      throw new IngestaError('Este documento no tiene archivo digital; no hay nada que extraer con IA.', 409);
    }
    throw error;
  }

  const mime = mimePorNombre(archivo.filename);
  if (!MIMES_PERMITIDOS.has(mime)) {
    throw new IngestaError(
      `Tipo de archivo no admitido para extracción con IA (${mime}). Solo PDF e imágenes.`,
      409,
    );
  }

  if (archivo.buffer.length > TAMANO_MAXIMO_BYTES) {
    const mb = (archivo.buffer.length / (1024 * 1024)).toFixed(1);
    const limiteMb = (TAMANO_MAXIMO_BYTES / (1024 * 1024)).toFixed(0);
    throw new IngestaError(`El archivo pesa ${mb} MB; el límite para extracción con IA es ${limiteMb} MB.`, 409);
  }

  const provider = crearVisionProvider();

  // Espacio de nombres propio: NUNCA se hashea el archivo tal cual. La fila `sin_texto`/`error` ya
  // tiene una entrada en `rag.contenido` bajo el sha256 del archivo, con el texto inútil de
  // markitdown — reutilizar esa clave o bien no cambiaría nada visible (`enlazarSiYaExiste` la
  // encontraría y remarcaría `sin_texto`) o, peor, el `ON CONFLICT DO NOTHING` de `guardarMarkdown`
  // tiraría la transcripción buena a la basura mientras el documento pasa a `convertido`, dejando
  // el markdown viejo intacto sin que nada se vea roto. Cambiar `OPENAI_VISION_MODEL` produce una
  // clave nueva a propósito: permite retranscribir con un modelo mejor más adelante.
  const shaArchivo = crypto.createHash('sha256').update(archivo.buffer).digest('hex');
  const sha256 = crypto.createHash('sha256').update(`vision:${provider.modelo}:${shaArchivo}`).digest('hex');

  if (doc.contenido_sha256 && doc.contenido_sha256 !== sha256) {
    await appSequelize.query('UPDATE rag.documento SET sha256_anterior = $2 WHERE id = $1', {
      bind: [doc.id, doc.contenido_sha256],
      type: QueryTypes.UPDATE,
    });
  }

  // Ya se transcribió este documento con este modelo antes: ni un token más.
  if (await enlazarSiYaExiste(doc, sha256)) return leerDocumentoActualizado(doc.id);

  let resultado: Awaited<ReturnType<VisionProvider['transcribir']>>;
  try {
    resultado = await provider.transcribir(
      { nombre: archivo.filename, mime, datos: archivo.buffer },
      PROMPT_TRANSCRIPCION,
    );
  } catch (error) {
    // Los tokens de ENTRADA de una llamada de visión suelen cobrarse aunque la respuesta falle
    // tarde; se registra el intento con coste desconocido en vez de dejarlo invisible.
    await registrarUsoVision(provider, { tokensIn: 0, tokensOut: 0, estimado: true }, false);
    if (error instanceof ErrorIA) throw new IngestaError(error.message, 409);
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

async function leerDocumentoActualizado(documentoId: number): Promise<DocumentoRag> {
  const actualizado = await documentoPorId(documentoId);
  if (!actualizado) {
    throw new IngestaError('El documento se procesó pero ya no se pudo volver a leer', 500);
  }
  return actualizado;
}
