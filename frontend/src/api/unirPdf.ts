import { apiJson, descargarComoBlobUrl } from './cliente';

export interface ErrorUnion {
  nuEmi: string;
  documento: string;
  nuAne?: number;
  anexo?: string;
  motivo: string;
}

export type EstadoUnion = 'procesando' | 'completado' | 'error';
export type FaseUnion = 'consultando' | 'procesando' | 'ensamblando';

export interface EstadoJobUnion {
  jobId: string;
  estado: EstadoUnion;
  fase: FaseUnion;
  total: number;
  procesados: number;
  errores: ErrorUnion[];
  mensajeError: string | null;
  filename: string;
}

/** Arranca la unión. El backend responde 202 y el trabajo sigue en segundo plano. */
export async function iniciarUnion(
  nuAnnExp: string,
  nuSecExp: string,
  incluirAnexos: boolean,
): Promise<string> {
  const query = incluirAnexos ? '' : '?anexos=no';
  const { jobId } = await apiJson<{ jobId: string }>(
    `/api/unir-pdf/expediente/${nuAnnExp}/${nuSecExp}${query}`,
    'iniciar la unión',
    { method: 'POST' },
  );
  return jobId;
}

export function consultarUnion(jobId: string): Promise<EstadoJobUnion> {
  return apiJson(`/api/unir-pdf/${jobId}/estado`, 'consultar el estado de la unión');
}

/**
 * Descarga el PDF ya generado y devuelve una URL de blob.
 *
 * No se puede enlazar directamente a la API: un `<a href>` no lleva la cabecera `Authorization` y
 * la ruta exige sesión. Quien lo use debe liberar la URL al cerrar.
 */
export function descargarUnion(jobId: string): Promise<string> {
  return descargarComoBlobUrl(`/api/unir-pdf/${jobId}/descargar`);
}

export const ETIQUETA_FASE: Record<FaseUnion, string> = {
  consultando: 'Consultando el expediente…',
  procesando: 'Uniendo documentos…',
  ensamblando: 'Armando el índice…',
};
