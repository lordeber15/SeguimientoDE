import crypto from 'crypto';
import { QueryTypes, type Sequelize } from 'sequelize';
import {
  crearVisionProvider,
  esProveedorVision,
  modeloVisionPorDefecto,
  visionDisponible,
  type ProveedorVision,
} from '../ai/providerFactory';
import { mismoModeloOllama, modelosOllamaInstalados, modelosOllamaVision } from '../ai/providers/ollamaVision';
import { ErrorIA, type VisionProvider } from '../ai/types';
import { limpiarMarkdown } from './limpiezaService';
import { PROMPT_TRANSCRIPCION } from './promptTranscripcion';

/**
 * Reproceso MANUAL del markdown de un documento con un proveedor de visión elegido (OpenAI u
 * Ollama), desde el visor PDF | markdown. A diferencia de "Extraer con ChatGPT" (último recurso
 * sobre `sin_texto`/`error`), se ofrece también sobre documentos ya convertidos: es para cuando la
 * extracción existe pero es mala.
 *
 * Corre en SEGUNDO PLANO: Ollama transcribe página a página y un escaneo largo tarda minutos, más
 * que el `requestTimeout` de 300 s de Node. El estado vive en memoria (se pierde al reiniciar, como
 * cualquier trabajo a medias) y el visor lo consulta hasta que termina.
 *
 * Es común a SGD y STD: cada módulo aporta un `AdaptadorReproceso` con su base y sus funciones de
 * ingesta. Igual que `visionService`, ningún job importa este módulo: no gasta un token solo.
 */

export interface DocumentoReprocesable {
  id: number;
  estado: string;
  contenido_sha256: string | null;
}

export interface AdaptadorReproceso<D extends DocumentoReprocesable> {
  modulo: 'sgd' | 'std';
  sequelize: Sequelize;
  leer(documentoId: number): Promise<D | undefined>;
  /** Bytes del archivo. Lanza el error de dominio del módulo si no existe. */
  archivo(doc: D): Promise<{ buffer: Buffer; filename: string; mime: string | null }>;
  guardar(
    doc: D,
    sha256: string,
    markdown: string,
    origen: { metodo: string; bytes: number; mime: string; ms: number },
  ): Promise<void>;
  error(mensaje: string, status: number): Error;
}

export type EstadoReproceso =
  | { estado: 'en_curso'; proveedor: string; modelo: string; inicio: string; pagina?: number; paginas?: number }
  | { estado: 'ok'; proveedor: string; modelo: string; inicio: string; fin: string; chars: number }
  | { estado: 'error'; proveedor: string; modelo: string; inicio: string; fin: string; mensaje: string };

const MIMES_PERMITIDOS = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Solo OpenAI: es el límite de su API. Ollama rasteriza página a página y tiene su propio tope. */
const TAMANO_MAXIMO_BYTES = Number(process.env.RAG_VISION_MAX_BYTES ?? 20 * 1024 * 1024);

const TOKENS_MAXIMOS_DIA = Number(process.env.RAG_VISION_TOKENS_DIA ?? 500_000);

/** Nombres de modelo de Ollama/OpenAI: `qwen2.5vl:7b`, `gpt-4o-mini`, `hf.co/org/modelo:q4`. */
const RE_MODELO = /^[\w.:/-]{1,100}$/;

/** Los resultados terminados se conservan una hora para que el visor alcance a leerlos. */
const RETENCION_MS = 60 * 60 * 1000;

const estados = new Map<string, EstadoReproceso>();

const clave = (modulo: string, documentoId: number) => `${modulo}:${documentoId}`;

function podar(): void {
  const limite = Date.now() - RETENCION_MS;
  for (const [k, e] of estados) {
    if (e.estado !== 'en_curso' && Date.parse(e.fin) < limite) estados.delete(k);
  }
}

export function estadoReproceso(modulo: 'sgd' | 'std', documentoId: number): EstadoReproceso | null {
  return estados.get(clave(modulo, documentoId)) ?? null;
}

export interface OpcionProveedorVision {
  nombre: ProveedorVision;
  etiqueta: string;
  disponible: boolean;
  motivo: string | null;
  modeloPorDefecto: string;
  /** Modelos ofrecidos en el selector; vacío = campo libre. */
  modelos: string[];
}

/** Lo que el visor necesita para armar el selector proveedor/modelo del reproceso. */
export async function opcionesReproceso(): Promise<OpcionProveedorVision[]> {
  const openai = visionDisponible('openai');
  const [instalados, conVision] = await Promise.all([modelosOllamaInstalados(), modelosOllamaVision()]);
  const configurado = modeloVisionPorDefecto('ollama');
  return [
    {
      nombre: 'openai',
      etiqueta: 'OpenAI',
      ...openai,
      modeloPorDefecto: modeloVisionPorDefecto('openai'),
      modelos: [],
    },
    {
      nombre: 'ollama',
      etiqueta: 'Ollama (local)',
      disponible: conVision.length > 0,
      motivo: conVision.length > 0
        ? null
        : instalados.length > 0
          ? 'Ollama no tiene ningún modelo con visión instalado (p.ej. `ollama pull qwen2.5vl:3b`).'
          : 'Ollama no responde o no tiene modelos instalados (OLLAMA_URL).',
      // El configurado solo si de verdad está instalado: `qwen2.5vl` NO es `qwen2.5vl:3b`.
      modeloPorDefecto: conVision.find((m) => mismoModeloOllama(m, configurado)) ?? conVision[0] ?? configurado,
      modelos: conVision,
    },
  ];
}

/** MIME por firma de bytes; si no se reconoce, el que conoce el módulo. */
export function mimeDeContenido(buffer: Buffer, mimeConocido: string | null): string {
  const cabecera = buffer.subarray(0, 12);
  if (buffer.subarray(0, 1024).includes('%PDF-')) return 'application/pdf';
  if (cabecera.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (cabecera.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (cabecera.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (cabecera.subarray(0, 4).toString('latin1') === 'RIFF' && cabecera.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return mimeConocido ?? 'application/octet-stream';
}

/** El techo diario es de gasto: Ollama es local y no cuenta. */
async function tokensPagadosHoy(sequelize: Sequelize): Promise<number> {
  const [{ total }] = await sequelize.query<{ total: string }>(
    `SELECT COALESCE(sum(tokens_in + tokens_out), 0)::text AS total
       FROM rag.uso_token
      WHERE operacion = 'vision' AND proveedor <> 'ollama' AND fe >= date_trunc('day', now())`,
    { type: QueryTypes.SELECT },
  );
  return Number(total);
}

async function registrarUso(
  sequelize: Sequelize,
  provider: VisionProvider,
  uso: { tokensIn: number; tokensOut: number; estimado: boolean },
  exito: boolean,
): Promise<void> {
  await sequelize.query(
    `INSERT INTO rag.uso_token (proveedor, modelo, operacion, tokens_in, tokens_out, estimado, exito)
     VALUES ($1, $2, 'vision', $3, $4, $5, $6)`,
    {
      bind: [provider.nombre, provider.modelo, uso.tokensIn, uso.tokensOut, uso.estimado, exito],
      type: QueryTypes.INSERT,
    },
  );
}

/**
 * Valida todo lo barato (y lee el archivo) antes de responder, para que los rechazos lleguen como
 * error inmediato; la transcripción en sí queda corriendo y se consulta con `estadoReproceso`.
 */
export async function iniciarReproceso<D extends DocumentoReprocesable>(
  adaptador: AdaptadorReproceso<D>,
  documentoId: number,
  pedido: { proveedor: unknown; modelo?: unknown },
): Promise<EstadoReproceso> {
  const { sequelize } = adaptador;

  if (!esProveedorVision(pedido.proveedor)) {
    throw adaptador.error('Proveedor no válido: use "openai" u "ollama".', 400);
  }
  const proveedor: ProveedorVision = pedido.proveedor;

  const modeloPedido = typeof pedido.modelo === 'string' ? pedido.modelo.trim() : '';
  if (modeloPedido && !RE_MODELO.test(modeloPedido)) {
    throw adaptador.error('Nombre de modelo no válido.', 400);
  }
  const modelo = modeloPedido || modeloVisionPorDefecto(proveedor);

  // Ollama responde 404 a mitad del trabajo si el modelo no existe; mejor rechazarlo aquí, con la
  // lista de los que sí sirven.
  if (proveedor === 'ollama') {
    const conVision = await modelosOllamaVision();
    if (conVision.length === 0) {
      throw adaptador.error('Ollama no responde o no tiene ningún modelo con visión instalado.', 409);
    }
    if (!conVision.some((m) => mismoModeloOllama(m, modelo))) {
      throw adaptador.error(
        `El modelo "${modelo}" no está instalado en Ollama o no tiene visión. Disponibles: ${conVision.join(', ')}.`,
        409,
      );
    }
  }

  const doc = await adaptador.leer(documentoId);
  if (!doc) throw adaptador.error('El documento ya no existe en rag.documento', 404);

  podar();
  if (estados.get(clave(adaptador.modulo, documentoId))?.estado === 'en_curso') {
    throw adaptador.error('Este documento ya se está reprocesando; espere a que termine.', 409);
  }
  if (doc.estado === 'en_proceso') {
    throw adaptador.error('Este documento se está convirtiendo ahora mismo; espere a que termine.', 409);
  }
  const [enCola] = await sequelize.query<{ job_id: number }>(
    `SELECT i.job_id FROM rag.ingest_item i
       JOIN rag.ingest_job j ON j.id = i.job_id
      WHERE i.documento_id = $1 AND i.estado IN ('pendiente', 'en_proceso') AND j.estado = 'en_curso'
      LIMIT 1`,
    { bind: [documentoId], type: QueryTypes.SELECT },
  );
  if (enCola) {
    throw adaptador.error(`Este documento está en la cola del trabajo #${enCola.job_id}; espere a que termine.`, 409);
  }

  const disponibilidad = visionDisponible(proveedor);
  if (!disponibilidad.disponible) {
    throw adaptador.error(disponibilidad.motivo ?? 'El proveedor de visión no está disponible.', 409);
  }

  if (proveedor !== 'ollama' && (await tokensPagadosHoy(sequelize)) >= TOKENS_MAXIMOS_DIA) {
    throw adaptador.error(
      `Se alcanzó el límite diario de tokens de extracción con IA (${TOKENS_MAXIMOS_DIA.toLocaleString('es-PE')}). Use Ollama o inténtelo mañana.`,
      409,
    );
  }

  const archivo = await adaptador.archivo(doc);
  const mime = mimeDeContenido(archivo.buffer, archivo.mime);
  if (!MIMES_PERMITIDOS.has(mime)) {
    throw adaptador.error(`Tipo de archivo no admitido para reproceso con IA (${mime}). Solo PDF e imágenes.`, 409);
  }
  if (proveedor === 'openai' && archivo.buffer.length > TAMANO_MAXIMO_BYTES) {
    const mb = (archivo.buffer.length / (1024 * 1024)).toFixed(1);
    const limiteMb = (TAMANO_MAXIMO_BYTES / (1024 * 1024)).toFixed(0);
    throw adaptador.error(`El archivo pesa ${mb} MB; el límite de OpenAI es ${limiteMb} MB. Pruebe con Ollama.`, 409);
  }

  const provider = crearVisionProvider(proveedor, modelo);
  const inicio = new Date().toISOString();
  const k = clave(adaptador.modulo, documentoId);
  const enCurso: EstadoReproceso = { estado: 'en_curso', proveedor, modelo: provider.modelo, inicio };
  estados.set(k, enCurso);

  void ejecutar(adaptador, doc, provider, { ...archivo, mime }, inicio).then(
    (chars) => estados.set(k, { estado: 'ok', proveedor, modelo: provider.modelo, inicio, fin: new Date().toISOString(), chars }),
    (error: unknown) => {
      if (!(error instanceof ErrorIA)) console.error(`Reproceso ${k}:`, error);
      estados.set(k, {
        estado: 'error',
        proveedor,
        modelo: provider.modelo,
        inicio,
        fin: new Date().toISOString(),
        mensaje: error instanceof Error ? error.message : 'Error desconocido',
      });
    },
  );

  return enCurso;
}

async function ejecutar<D extends DocumentoReprocesable>(
  adaptador: AdaptadorReproceso<D>,
  doc: D,
  provider: VisionProvider,
  archivo: { buffer: Buffer; filename: string; mime: string },
  inicio: string,
): Promise<number> {
  const { sequelize } = adaptador;
  const k = clave(adaptador.modulo, doc.id);
  const t0 = Date.now();

  let resultado: Awaited<ReturnType<VisionProvider['transcribir']>>;
  try {
    resultado = await provider.transcribir(
      { nombre: archivo.filename, mime: archivo.mime, datos: archivo.buffer },
      PROMPT_TRANSCRIPCION,
      {
        onPagina: (pagina, paginas) => estados.set(k, {
          estado: 'en_curso', proveedor: provider.nombre, modelo: provider.modelo, inicio, pagina, paginas,
        }),
      },
    );
  } catch (error) {
    await registrarUso(sequelize, provider, { tokensIn: 0, tokensOut: 0, estimado: true }, false);
    throw error;
  }
  await registrarUso(sequelize, provider, resultado.uso, true);

  // Un reproceso que no saca texto NO pisa el markdown que ya había: `guardarMarkdown` marcaría el
  // documento `sin_texto` y se perdería una extracción quizá imperfecta, pero útil.
  const limpio = limpiarMarkdown(resultado.texto);
  if (limpio.sinTexto) {
    throw new ErrorIA(
      `${provider.nombre}/${provider.modelo} no extrajo texto útil; se conserva el markdown anterior.`,
      'desconocido',
      provider.nombre,
    );
  }

  // Contenido nuevo SIEMPRE (la hora entra en el hash): reprocesar dos veces con el mismo modelo
  // debe sustituir el texto, no enlazar con el anterior. El que queda huérfano lo recoge el GC,
  // igual que cualquier contenido sustituido, junto con sus chunks y embeddings.
  const shaArchivo = crypto.createHash('sha256').update(archivo.buffer).digest('hex');
  const sha256 = crypto
    .createHash('sha256')
    .update(`reproceso:${provider.nombre}:${provider.modelo}:${shaArchivo}:${inicio}`)
    .digest('hex');

  if (doc.contenido_sha256) {
    await sequelize.query('UPDATE rag.documento SET sha256_anterior = $2 WHERE id = $1', {
      bind: [doc.id, doc.contenido_sha256],
      type: QueryTypes.UPDATE,
    });
  }

  await adaptador.guardar(doc, sha256, resultado.texto, {
    metodo: `vision:${provider.nombre}/${provider.modelo}`,
    bytes: Buffer.byteLength(resultado.texto),
    mime: 'text/markdown',
    ms: Date.now() - t0,
  });

  return limpio.chars;
}
