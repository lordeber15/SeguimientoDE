import { apiJson } from './cliente';

export interface AnexoListado {
  nuAne: number;
  titulo: string | null;
  nombreArchivo: string | null;
  enBd: boolean;
}

export interface InteraccionExpediente {
  nuAnn: string;
  nuEmi: string;
  nuDes: string;
  orden: number;
  documento: { nombre: string | null; tipo: string | null; numero: string | null };
  asunto: string | null;
  estado: { codigo: string | null; descripcion: string | null };
  fechaRecepcion: string | null;
  fechaApertura: string | null;
  fechaEmision: string | null;
  documentoRespuesta: string | null;
  segundosCorridos: number | null;
  tieneArchivo: boolean;
  numAnexos: number;
}

export interface RespuestaInteracciones {
  total: number;
  items: InteraccionExpediente[];
}

export function fetchInteracciones(
  nuAnnExp: string,
  nuSecExp: string,
  coDependencia: string,
  coEmpleado: string,
): Promise<RespuestaInteracciones> {
  const params = new URLSearchParams({ dependencia: coDependencia, usuario: coEmpleado });
  return apiJson(
    `/api/documentos/expediente/${nuAnnExp}/${nuSecExp}/interacciones?${params}`,
    'obtener las interacciones del expediente',
  );
}

export interface InteraccionExpedienteCompleta extends InteraccionExpediente {
  recibidoPor: {
    coEmpleado: string | null;
    nombre: string | null;
    coDependencia: string | null;
    nombreDependencia: string | null;
  };
}

export interface RespuestaInteraccionesCompletas {
  total: number;
  items: InteraccionExpedienteCompleta[];
}

/** Todos los movimientos del expediente, sin acotar a un participante — a diferencia de
 * `fetchInteracciones`, que solo trae lo que le tocó a un usuario puntual. */
export function fetchInteraccionesCompletas(
  nuAnnExp: string,
  nuSecExp: string,
): Promise<RespuestaInteraccionesCompletas> {
  return apiJson(
    `/api/documentos/expediente/${nuAnnExp}/${nuSecExp}/interacciones-completas`,
    'obtener el expediente completo',
  );
}

export function fetchAnexos(nuAnn: string, nuEmi: string): Promise<AnexoListado[]> {
  return apiJson(`/api/documentos/${nuAnn}/${nuEmi}/anexos`, 'obtener los anexos del documento');
}

/**
 * Ruta (no URL absoluta) del documento. La descarga pasa por `descargarComoBlobUrl`, que añade el
 * token: desde que las rutas exigen sesión, un `<a href>` directo devolvería 401.
 */
export function rutaDocumento(nuAnn: string, nuEmi: string): string {
  return `/api/documentos/${nuAnn}/${nuEmi}`;
}

export function rutaAnexo(nuAnn: string, nuEmi: string, nuAne: number): string {
  return `/api/documentos/${nuAnn}/${nuEmi}/anexos/${nuAne}`;
}

/**
 * Los nombres del SGD son larguísimos y con separadores `$`:
 * `R53.6616259$INFORME$ 000004-2026-MINEDU-VMGP!UE118!USEI (SGD)$Lima$2026$05$28$N.pdf`
 * El segundo y tercer campo son el tipo y el número, que es lo único legible para una persona.
 */
export function nombreLegible(nombreArchivo: string | null): string {
  if (!nombreArchivo) return 'Sin nombre';

  const partes = nombreArchivo.split('$');
  if (partes.length >= 3) {
    const tipo = partes[1]?.trim();
    const numero = partes[2]?.trim().split('-MINEDU')[0]?.trim();
    if (tipo && numero) return `${tipo} ${numero}`;
  }

  return nombreArchivo;
}

const EXTENSIONES_VISIBLES = ['pdf', 'png', 'jpg', 'jpeg', 'gif'];

/** Si el navegador puede mostrarlo embebido o hay que descargarlo. */
export function esVisualizable(nombreArchivo: string | null): boolean {
  const ext = nombreArchivo?.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSIONES_VISIBLES.includes(ext);
}
