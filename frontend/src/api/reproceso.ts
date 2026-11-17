import { apiJson } from './cliente';

/**
 * Reproceso del markdown de un documento con un proveedor de visión elegido (OpenAI u Ollama).
 * El mismo contrato en SGD (`/api/rag`) y STD (`/api/std/rag`) — ver
 * backend/src/compartido/rag/reprocesoService.ts.
 */

export type ProveedorVision = 'openai' | 'ollama';

export interface OpcionProveedorVision {
  nombre: ProveedorVision;
  etiqueta: string;
  disponible: boolean;
  motivo: string | null;
  modeloPorDefecto: string;
  /** Modelos instalados (Ollama); vacío = campo libre. */
  modelos: string[];
}

export type EstadoReproceso =
  | { estado: 'en_curso'; proveedor: string; modelo: string; inicio: string; pagina?: number; paginas?: number }
  | { estado: 'ok'; proveedor: string; modelo: string; inicio: string; fin: string; chars: number }
  | { estado: 'error'; proveedor: string; modelo: string; inicio: string; fin: string; mensaje: string };

export interface ClienteReproceso {
  opciones(): Promise<OpcionProveedorVision[]>;
  iniciar(proveedor: ProveedorVision, modelo: string): Promise<EstadoReproceso>;
  consultar(): Promise<EstadoReproceso | null>;
  /** Lanza el job de embeddings del documento: el reproceso lo deja `convertido`, fuera del chat. */
  embeber(): Promise<{ jobId: number }>;
}

export function clienteReproceso(
  base: '/api/rag' | '/api/std/rag',
  documentoId: number,
  embeber: () => Promise<{ jobId: number }>,
): ClienteReproceso {
  return {
    opciones: () =>
      apiJson<{ proveedores: OpcionProveedorVision[] }>(`${base}/reproceso/opciones`, 'listar los proveedores de reproceso')
        .then((r) => r.proveedores),
    iniciar: (proveedor, modelo) =>
      apiJson<{ reproceso: EstadoReproceso }>(`${base}/documentos/${documentoId}/reproceso`, 'reprocesar el documento', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proveedor, modelo }),
      }).then((r) => r.reproceso),
    consultar: () =>
      apiJson<{ reproceso: EstadoReproceso | null }>(
        `${base}/documentos/${documentoId}/reproceso`,
        'consultar el reproceso del documento',
      ).then((r) => r.reproceso),
    embeber,
  };
}
