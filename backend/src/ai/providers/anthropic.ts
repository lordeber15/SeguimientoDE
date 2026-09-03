import { postJson } from '../http';
import type { ChatProvider, MensajeChat, ResultadoChat } from '../types';

/**
 * Anthropic, **solo chat**.
 *
 * No tiene endpoint de embeddings: si alguien configura `EMBEDDING_PROVIDER=anthropic`, el
 * arranque falla con un mensaje explícito (ver `validarConfiguracionIA`) en vez de descubrirlo a
 * mitad de una ingesta. La combinación normal es chat=Anthropic + embeddings=Ollama u OpenAI.
 */

interface RespuestaMensajes {
  content: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicChat implements ChatProvider {
  readonly nombre = 'anthropic' as const;
  readonly modelo: string;

  constructor(modelo = process.env.ANTHROPIC_CHAT_MODEL ?? 'claude-sonnet-4-5') {
    this.modelo = modelo;
  }

  async responder(mensajes: MensajeChat[], opciones?: { maxTokens?: number }): Promise<ResultadoChat> {
    // La API de Anthropic no acepta `system` dentro de `messages`: va en su propio campo.
    const sistema = mensajes.filter((m) => m.rol === 'system').map((m) => m.contenido).join('\n\n');
    const conversacion = mensajes.filter((m) => m.rol !== 'system');

    const respuesta = await postJson<RespuestaMensajes>({
      url: `${(process.env.ANTHROPIC_URL ?? 'https://api.anthropic.com/v1').replace(/\/$/, '')}/messages`,
      cuerpo: {
        model: this.modelo,
        max_tokens: opciones?.maxTokens ?? 1024,
        ...(sistema ? { system: sistema } : {}),
        messages: conversacion.map((m) => ({ role: m.rol, content: m.contenido })),
      },
      cabeceras: {
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': process.env.ANTHROPIC_VERSION ?? '2023-06-01',
      },
      proveedor: 'anthropic',
    });

    return {
      texto: (respuesta.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join(''),
      uso: {
        tokensIn: respuesta.usage?.input_tokens ?? 0,
        tokensOut: respuesta.usage?.output_tokens ?? 0,
        estimado: respuesta.usage == null,
      },
    };
  }

  async comprobar(): Promise<void> {
    await this.responder([{ rol: 'user', contenido: 'ok' }], { maxTokens: 1 });
  }
}
