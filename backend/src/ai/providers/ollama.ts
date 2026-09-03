import { postJson, estimarTokens } from '../http';
import { ErrorIA, type ChatProvider, type EmbeddingProvider, type MensajeChat, type ResultadoChat, type ResultadoEmbedding } from '../types';

/**
 * Ollama local. Es el único proveedor que **no necesita API key**, y el recomendado para
 * embeddings: el corpus entero pasa por embeddings, mientras que el chat solo ve 12 chunks por
 * consulta. Mantener los embeddings en local reduce mucho lo que sale de la entidad.
 */

const BASE = () => (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '');

export class OllamaEmbedding implements EmbeddingProvider {
  readonly nombre = 'ollama' as const;
  readonly modelo: string;
  readonly dimension: number;

  constructor(modelo = process.env.OLLAMA_EMBED_MODEL ?? 'bge-m3', dimension?: number) {
    this.modelo = modelo;
    this.dimension = dimension ?? Number(process.env.OLLAMA_EMBED_DIM ?? 1024);
  }

  async embeber(textos: string[]): Promise<ResultadoEmbedding> {
    const respuesta = await postJson<{ embeddings: number[][]; prompt_eval_count?: number }>({
      url: `${BASE()}/api/embed`,
      cuerpo: { model: this.modelo, input: textos },
      cabeceras: {},
      proveedor: 'ollama',
    });

    if (!Array.isArray(respuesta.embeddings) || respuesta.embeddings.length !== textos.length) {
      throw new ErrorIA('ollama: respuesta de embeddings incompleta', 'desconocido', 'ollama');
    }

    return {
      vectores: respuesta.embeddings,
      uso: {
        tokensIn: respuesta.prompt_eval_count ?? estimarTokens(textos),
        tokensOut: 0,
        estimado: respuesta.prompt_eval_count == null,
      },
    };
  }

  async comprobar(): Promise<void> {
    const { vectores } = await this.embeber(['comprobación']);
    const real = vectores[0]?.length ?? 0;

    // Si la dimensión configurada no coincide con la real, los INSERT fallarían uno a uno a mitad
    // de una ingesta de horas. Mejor descubrirlo aquí.
    if (real !== this.dimension) {
      throw new ErrorIA(
        `ollama: el modelo ${this.modelo} devuelve ${real} dimensiones, no ${this.dimension}. `
          + 'Ajuste OLLAMA_EMBED_DIM.',
        'desconocido',
        'ollama',
      );
    }
  }
}

export class OllamaChat implements ChatProvider {
  readonly nombre = 'ollama' as const;
  readonly modelo: string;

  constructor(modelo = process.env.OLLAMA_CHAT_MODEL ?? 'llama3.1') {
    this.modelo = modelo;
  }

  async responder(mensajes: MensajeChat[], opciones?: { maxTokens?: number }): Promise<ResultadoChat> {
    const respuesta = await postJson<{
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    }>({
      url: `${BASE()}/api/chat`,
      cuerpo: {
        model: this.modelo,
        messages: mensajes.map((m) => ({ role: m.rol, content: m.contenido })),
        stream: false,
        options: opciones?.maxTokens ? { num_predict: opciones.maxTokens } : undefined,
      },
      cabeceras: {},
      proveedor: 'ollama',
    });

    return {
      texto: respuesta.message?.content ?? '',
      uso: {
        tokensIn: respuesta.prompt_eval_count ?? 0,
        tokensOut: respuesta.eval_count ?? 0,
        estimado: respuesta.prompt_eval_count == null,
      },
    };
  }

  async comprobar(): Promise<void> {
    await this.responder([{ rol: 'user', contenido: 'ok' }], { maxTokens: 1 });
  }
}
