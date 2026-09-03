/** Contratos de la capa de IA. Los adaptadores concretos viven en `ai/providers/`. */

export type NombreProveedor = 'ollama' | 'openai' | 'anthropic' | 'azure';

export interface UsoTokens {
  tokensIn: number;
  tokensOut: number;
  /** true si el proveedor no devolvió `usage` y hubo que estimarlo por caracteres. */
  estimado: boolean;
}

export interface ResultadoEmbedding {
  vectores: number[][];
  uso: UsoTokens;
}

export interface EmbeddingProvider {
  readonly nombre: NombreProveedor;
  readonly modelo: string;
  readonly dimension: number;
  /** Lote de textos → lote de vectores, en el mismo orden. */
  embeber(textos: string[]): Promise<ResultadoEmbedding>;
  /** Comprueba que el proveedor responde y que el modelo existe. No cuesta tokens. */
  comprobar(): Promise<void>;
}

export interface MensajeChat {
  rol: 'system' | 'user' | 'assistant';
  contenido: string;
}

export interface ResultadoChat {
  texto: string;
  uso: UsoTokens;
}

export interface ChatProvider {
  readonly nombre: NombreProveedor;
  readonly modelo: string;
  responder(mensajes: MensajeChat[], opciones?: { maxTokens?: number }): Promise<ResultadoChat>;
  comprobar(): Promise<void>;
}

export interface EntradaDocumento {
  nombre: string;
  mime: string;
  datos: Buffer;
}

/**
 * Capacidad separada de `ChatProvider` a propósito: `MensajeChat.contenido` es siempre texto, y
 * Ollama/Anthropic implementan `ChatProvider` sin soporte de archivos. Ensanchar esa interfaz les
 * impondría una capacidad que no tienen; esta vive aparte y hoy solo la implementa OpenAI.
 */
export interface VisionProvider {
  readonly nombre: NombreProveedor;
  readonly modelo: string;
  /** Transcribe un documento (PDF o imagen) siguiendo la instrucción dada. */
  transcribir(archivo: EntradaDocumento, instruccion: string, opciones?: { maxTokens?: number }): Promise<ResultadoChat>;
}

/**
 * Clasificación normalizada de los fallos. Es la pieza que habilita el failover: cada proveedor
 * expresa lo mismo de forma distinta y sin traducirlo no se puede decidir si conviene reintentar,
 * cambiar de proveedor o parar.
 */
export type TipoErrorIA =
  | 'quota'          // se agotó el crédito → cambiar de proveedor
  | 'rate_limit'     // demasiadas peticiones → reintentar y, si insiste, cambiar
  | 'auth'           // credencial inválida → NO cambiar: es configuración, y cambiar lo enmascara
  | 'context_length' // el texto no cabe → recortar
  | 'unavailable'    // el servicio no responde
  | 'desconocido';

export class ErrorIA extends Error {
  readonly tipo: TipoErrorIA;
  readonly proveedor: NombreProveedor;
  readonly status?: number;

  constructor(mensaje: string, tipo: TipoErrorIA, proveedor: NombreProveedor, status?: number) {
    super(mensaje);
    this.name = 'ErrorIA';
    this.tipo = tipo;
    this.proveedor = proveedor;
    this.status = status;
  }

  /** Si tiene sentido probar con otro proveedor. `auth` no: es un error de configuración. */
  get permiteFailover(): boolean {
    return this.tipo === 'quota' || this.tipo === 'rate_limit' || this.tipo === 'unavailable';
  }
}
