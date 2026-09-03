import { postJson, estimarTokens } from '../http';
import {
  ErrorIA,
  type ChatProvider,
  type EmbeddingProvider,
  type MensajeChat,
  type NombreProveedor,
  type ResultadoChat,
  type ResultadoEmbedding,
} from '../types';

/**
 * OpenAI y Azure OpenAI comparten el formato de petición y respuesta; solo cambian la URL y la
 * cabecera de autenticación. Se implementan juntos para que no diverjan con el tiempo.
 */

const DIMENSIONES: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

type RecursoOpenai = 'embeddings' | 'chat' | 'responses';

interface Endpoint {
  url: (recurso: RecursoOpenai) => string;
  cabeceras: () => Record<string, string>;
  proveedor: NombreProveedor;
}

const RUTAS_RECURSO: Record<RecursoOpenai, string> = {
  embeddings: 'embeddings',
  chat: 'chat/completions',
  // La transcripción con visión usa la Responses API, no chat/completions: es la que acepta
  // `input_file` con PDFs directamente (ver `openaiVision.ts`).
  responses: 'responses',
};

export function endpointOpenai(): Endpoint {
  const base = (process.env.OPENAI_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  return {
    url: (recurso) => `${base}/${RUTAS_RECURSO[recurso]}`,
    cabeceras: () => ({ Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}` }),
    proveedor: 'openai',
  };
}

/**
 * Azure enruta por *deployment*, no por nombre de modelo, y autentica con `api-key` en vez de
 * `Authorization`. Es la diferencia que más veces se pasa por alto al portar código de OpenAI.
 */
function endpointAzure(despliegue: string): Endpoint {
  const base = (process.env.AZURE_OPENAI_ENDPOINT ?? '').replace(/\/$/, '');
  const version = process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21';
  return {
    url: (recurso) =>
      `${base}/openai/deployments/${despliegue}/${recurso === 'embeddings' ? 'embeddings' : 'chat/completions'}`
      + `?api-version=${version}`,
    cabeceras: () => ({ 'api-key': process.env.AZURE_OPENAI_API_KEY ?? '' }),
    proveedor: 'azure',
  };
}

interface RespuestaEmbeddings {
  data: { embedding: number[]; index: number }[];
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

export class OpenAiEmbedding implements EmbeddingProvider {
  readonly nombre: NombreProveedor;
  readonly modelo: string;
  readonly dimension: number;
  private readonly endpoint: Endpoint;

  constructor(esAzure = false) {
    this.modelo = esAzure
      ? process.env.AZURE_EMBED_DEPLOYMENT ?? ''
      : process.env.OPENAI_EMBED_MODEL ?? 'text-embedding-3-small';
    this.endpoint = esAzure ? endpointAzure(this.modelo) : endpointOpenai();
    this.nombre = this.endpoint.proveedor;
    this.dimension = Number(
      process.env.OPENAI_EMBED_DIM ?? DIMENSIONES[this.modelo] ?? 1536,
    );
  }

  async embeber(textos: string[]): Promise<ResultadoEmbedding> {
    const respuesta = await postJson<RespuestaEmbeddings>({
      url: this.endpoint.url('embeddings'),
      cuerpo: { model: this.modelo, input: textos },
      cabeceras: this.endpoint.cabeceras(),
      proveedor: this.nombre,
    });

    // La API no garantiza el orden de `data`: cada elemento trae su `index` y hay que respetarlo.
    // Ignorarlo asocia vectores a chunks equivocados sin que falle nada — el peor tipo de error.
    const vectores: number[][] = new Array(textos.length);
    for (const item of respuesta.data ?? []) vectores[item.index] = item.embedding;

    if (vectores.some((v) => !v)) {
      throw new ErrorIA(`${this.nombre}: faltan vectores en la respuesta`, 'desconocido', this.nombre);
    }

    return {
      vectores,
      uso: {
        tokensIn: respuesta.usage?.prompt_tokens ?? respuesta.usage?.total_tokens ?? estimarTokens(textos),
        tokensOut: 0,
        estimado: respuesta.usage == null,
      },
    };
  }

  async comprobar(): Promise<void> {
    const { vectores } = await this.embeber(['comprobación']);
    const real = vectores[0]?.length ?? 0;
    if (real !== this.dimension) {
      throw new ErrorIA(
        `${this.nombre}: el modelo ${this.modelo} devuelve ${real} dimensiones, no ${this.dimension}.`,
        'desconocido',
        this.nombre,
      );
    }
  }
}

interface RespuestaChat {
  choices: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiChat implements ChatProvider {
  readonly nombre: NombreProveedor;
  readonly modelo: string;
  private readonly endpoint: Endpoint;

  constructor(esAzure = false) {
    this.modelo = esAzure
      ? process.env.AZURE_CHAT_DEPLOYMENT ?? ''
      : process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini';
    this.endpoint = esAzure ? endpointAzure(this.modelo) : endpointOpenai();
    this.nombre = this.endpoint.proveedor;
  }

  async responder(mensajes: MensajeChat[], opciones?: { maxTokens?: number }): Promise<ResultadoChat> {
    const respuesta = await postJson<RespuestaChat>({
      url: this.endpoint.url('chat'),
      cuerpo: {
        model: this.modelo,
        messages: mensajes.map((m) => ({ role: m.rol, content: m.contenido })),
        max_tokens: opciones?.maxTokens ?? 1024,
      },
      cabeceras: this.endpoint.cabeceras(),
      proveedor: this.nombre,
    });

    return {
      texto: respuesta.choices?.[0]?.message?.content ?? '',
      uso: {
        tokensIn: respuesta.usage?.prompt_tokens ?? 0,
        tokensOut: respuesta.usage?.completion_tokens ?? 0,
        estimado: respuesta.usage == null,
      },
    };
  }

  async comprobar(): Promise<void> {
    await this.responder([{ rol: 'user', contenido: 'ok' }], { maxTokens: 1 });
  }
}
