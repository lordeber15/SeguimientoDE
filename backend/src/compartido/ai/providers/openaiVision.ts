import { postJson } from '../http';
import { ErrorIA, type EntradaDocumento, type NombreProveedor, type ResultadoChat, type VisionProvider } from '../types';
import { endpointOpenai } from './openai';

/**
 * Transcribe un documento (PDF o imagen) con la Responses API de OpenAI — no `chat/completions`,
 * que no acepta `input_file`. Para PDFs en modelos con visión (gpt-4o en adelante) la API extrae
 * TEXTO e IMÁGENES de cada página, que es justo lo que la hace servir sobre documentos escaneados
 * que markitdown deja vacíos.
 *
 * Solo OpenAI: Azure enruta por *deployment* con una URL distinta que nadie ha verificado contra
 * la Responses API, así que se rechaza explícitamente en vez de construir una URL adivinada.
 */

interface ContenidoRespuesta {
  type: string;
  text?: string;
}

interface ItemRespuesta {
  type: string;
  content?: ContenidoRespuesta[];
}

interface RespuestaResponses {
  output_text?: string;
  output?: ItemRespuesta[];
  // La Responses API usa `input_tokens`/`output_tokens` — NO `prompt_tokens`/`completion_tokens`
  // (esos son de chat/completions). Copiar el nombre equivocado compila igual y registra 0 tokens
  // en cada llamada, una factura invisible.
  usage?: { input_tokens?: number; output_tokens?: number };
}

function textoDe(respuesta: RespuestaResponses): string {
  if (respuesta.output_text) return respuesta.output_text;
  return (respuesta.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((c) => c.type === 'output_text' && c.text)
    .map((c) => c.text)
    .join('');
}

export class OpenAiVision implements VisionProvider {
  readonly nombre: NombreProveedor = 'openai';
  readonly modelo: string;
  private readonly endpoint: ReturnType<typeof endpointOpenai>;

  constructor() {
    this.modelo = process.env.OPENAI_VISION_MODEL ?? 'gpt-4o';
    this.endpoint = endpointOpenai();
  }

  async transcribir(
    archivo: EntradaDocumento,
    instruccion: string,
    opciones?: { maxTokens?: number },
  ): Promise<ResultadoChat> {
    const base64 = archivo.datos.toString('base64');

    const respuesta = await postJson<RespuestaResponses>({
      url: this.endpoint.url('responses'),
      cuerpo: {
        model: this.modelo,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_file', filename: archivo.nombre, file_data: `data:${archivo.mime};base64,${base64}` },
              { type: 'input_text', text: instruccion },
            ],
          },
        ],
        max_output_tokens: opciones?.maxTokens ?? 4096,
      },
      cabeceras: this.endpoint.cabeceras(),
      proveedor: this.nombre,
      // Un escaneo de varias páginas tarda más que una llamada de chat normal — el timeout
      // genérico de `postJson` (120 s) se queda corto.
      timeoutMs: Number(process.env.RAG_VISION_TIMEOUT_MS ?? 300_000),
    });

    const texto = textoDe(respuesta);
    if (!texto.trim()) {
      throw new ErrorIA(`${this.nombre}: la respuesta de visión llegó vacía`, 'desconocido', this.nombre);
    }

    return {
      texto,
      uso: {
        tokensIn: respuesta.usage?.input_tokens ?? 0,
        tokensOut: respuesta.usage?.output_tokens ?? 0,
        estimado: respuesta.usage == null,
      },
    };
  }
}
