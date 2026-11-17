import { postJson } from '../http';
import { ErrorIA, type EntradaDocumento, type NombreProveedor, type ResultadoChat, type VisionProvider } from '../types';
import { contarPaginas } from '../../services/pdfPaginasService';
import { rasterizarPdf } from '../../services/pdfRasterService';

/**
 * Transcripción con un modelo de visión LOCAL en Ollama (qwen2.5vl, llama3.2-vision, gemma3…):
 * nada sale del servidor y no cuesta tokens. Ollama solo acepta imágenes, así que un PDF se
 * rasteriza y se transcribe PÁGINA A PÁGINA — una llamada por página, que además evita desbordar
 * el contexto del modelo con un escaneo largo. Más lento que OpenAI: es un reproceso manual.
 */

const BASE = () => (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '');

/** Tope de páginas por documento: a ~20-60 s por página en CPU, 50 páginas ya son decenas de minutos. */
const MAX_PAGINAS = Number(process.env.RAG_VISION_OLLAMA_MAX_PAGINAS ?? 50);

interface RespuestaChatOllama {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaVision implements VisionProvider {
  readonly nombre: NombreProveedor = 'ollama';
  readonly modelo: string;

  constructor(modelo = process.env.OLLAMA_VISION_MODEL ?? 'qwen2.5vl') {
    this.modelo = modelo;
  }

  async transcribir(
    archivo: EntradaDocumento,
    instruccion: string,
    opciones?: { maxTokens?: number; onPagina?: (actual: number, total: number) => void },
  ): Promise<ResultadoChat> {
    if (archivo.mime !== 'application/pdf') {
      return this.transcribirImagen(archivo.datos, instruccion, opciones?.maxTokens);
    }

    const total = await contarPaginas(archivo.datos);
    if (total === null) {
      throw new ErrorIA('ollama: el PDF no se pudo abrir para rasterizarlo', 'desconocido', this.nombre);
    }
    if (total > MAX_PAGINAS) {
      throw new ErrorIA(
        `ollama: el documento tiene ${total} páginas; el límite para visión local es ${MAX_PAGINAS} (RAG_VISION_OLLAMA_MAX_PAGINAS).`,
        'context_length',
        this.nombre,
      );
    }

    const partes: string[] = [];
    let tokensIn = 0;
    let tokensOut = 0;
    let estimado = false;

    for await (const pagina of rasterizarPdf(archivo.datos, { maxPaginas: MAX_PAGINAS })) {
      opciones?.onPagina?.(pagina.numero, total);
      const r = await this.transcribirImagen(pagina.png, instruccion, opciones?.maxTokens);
      // Las páginas en blanco (separadores, reversos) devuelven vacío: no son un fallo del documento.
      if (r.texto.trim()) partes.push(r.texto.trim());
      tokensIn += r.uso.tokensIn;
      tokensOut += r.uso.tokensOut;
      estimado ||= r.uso.estimado;
    }

    const texto = partes.join('\n\n');
    if (!texto) {
      throw new ErrorIA(`${this.nombre}: el modelo no devolvió texto en ninguna página`, 'desconocido', this.nombre);
    }
    return { texto, uso: { tokensIn, tokensOut, estimado } };
  }

  private async transcribirImagen(imagen: Buffer, instruccion: string, maxTokens?: number): Promise<ResultadoChat> {
    const respuesta = await postJson<RespuestaChatOllama>({
      url: `${BASE()}/api/chat`,
      cuerpo: {
        model: this.modelo,
        messages: [{ role: 'user', content: instruccion, images: [imagen.toString('base64')] }],
        stream: false,
        // Igual que `OllamaChat`: un modelo con razonamiento gastaría el `num_predict` pensando.
        think: false,
        options: { num_predict: maxTokens ?? 4096, temperature: 0 },
      },
      cabeceras: {},
      proveedor: this.nombre,
      timeoutMs: Number(process.env.RAG_VISION_TIMEOUT_MS ?? 300_000),
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
}

/** `qwen2.5vl` y `qwen2.5vl:latest` son el mismo modelo para Ollama; `qwen2.5vl:3b` es otro. */
export function mismoModeloOllama(a: string, b: string): boolean {
  const normalizar = (m: string) => (m.includes(':') ? m : `${m}:latest`);
  return normalizar(a) === normalizar(b);
}

/**
 * Modelos instalados CON VISIÓN (`capabilities` de `/api/show` incluye "vision"): un modelo de
 * texto o de embeddings (bge-m3) respondería sin ver la imagen. Un Ollama anterior a
 * `capabilities` no permite distinguirlos: entonces se devuelven todos. `[]` si Ollama no responde.
 */
export async function modelosOllamaVision(): Promise<string[]> {
  const instalados = await modelosOllamaInstalados();
  const conVision = await Promise.all(
    instalados.map(async (modelo) => {
      try {
        const res = await fetch(`${BASE()}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelo }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return null;
        const { capabilities } = (await res.json()) as { capabilities?: string[] };
        return !capabilities || capabilities.includes('vision') ? modelo : null;
      } catch {
        return null;
      }
    }),
  );
  return conVision.filter((m): m is string => m !== null);
}

/** Modelos instalados en Ollama, para el selector del reproceso. `[]` si Ollama no responde. */
export async function modelosOllamaInstalados(): Promise<string[]> {
  try {
    const res = await fetch(`${BASE()}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return [];
    const cuerpo = (await res.json()) as { models?: { name: string }[] };
    return (cuerpo.models ?? []).map((m) => m.name).sort();
  } catch {
    return [];
  }
}
