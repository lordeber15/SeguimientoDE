import type { AdaptadorChat } from './chatComun';
import { apiJson } from './cliente';

/**
 * Cliente del módulo STD — mismas formas que `api/chat.ts` (SGD), con la identidad propia del STD:
 * `idAdjunto`/`idDocumento`/`nroStd`/`origen` en vez de `nuAnn`/`nuEmi`/`nuAne`. Ver la skill
 * `std-database` para el significado de "N° STD" y `origen` (principal/anexo/derivación).
 */

export interface CitaChatStd {
  numero: number;
  chunkId: number;
  documentoId: number;
  idAdjunto: number;
  idDocumento: number;
  nroStd: string | null;
  origen: 'principal' | 'anexo' | 'derivacion';
  extracto: string;
  chars: number;
  rutaTitulos: string | null;
  usada: boolean;
}

export interface RespuestaChatStd {
  sesionId: number;
  mensajeId: number;
  texto: string;
  citas: CitaChatStd[];
  candidatosVec: number;
  candidatosFts: number;
  marcadoresAlucinados: number;
}

export interface SesionChatStd {
  id: number;
  modo: 'general' | 'documento';
  idDocumento: number | null;
  feUltimoMsg: string;
}

export interface MensajeHistorialStd {
  id: number;
  rol: 'user' | 'assistant';
  texto: string;
  feAlta: string;
  citas: CitaChatStd[];
}

export interface EstadoIngestaDocumentoStd {
  total: number;
  listos: number;
  convertidos: number;
  pendientes: number;
  sinTexto: number;
  error: number;
  noSoportado: number;
  completo: boolean;
}

export interface DocumentoChatStd {
  idDocumento: number;
  documento: string | null;
  adjuntosPdfStd: number;
  docsIngestados: number;
  docsPendientes: number;
}

export function enviarMensajeGeneralStd(mensaje: string, sesionId?: number): Promise<RespuestaChatStd> {
  return apiJson('/api/std/chat/general', 'enviar el mensaje', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mensaje, sesionId }),
  });
}

export function enviarMensajeDocumentoStd(
  idDocumento: number,
  mensaje: string,
  sesionId?: number,
): Promise<RespuestaChatStd> {
  return apiJson(`/api/std/chat/documento/${idDocumento}`, 'enviar el mensaje', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mensaje, sesionId }),
  });
}

/** Texto completo del fragmento citado. Se pide al desplegar la cita, nunca antes. */
export function fetchTextoChunkStd(chunkId: number): Promise<{ texto: string }> {
  return apiJson(`/api/std/chat/chunks/${chunkId}`, 'obtener el fragmento citado');
}

export function fetchSesionesStd(): Promise<SesionChatStd[]> {
  return apiJson('/api/std/chat/sesiones', 'obtener las conversaciones anteriores');
}

export function fetchHistorialSesionStd(sesionId: number): Promise<MensajeHistorialStd[]> {
  return apiJson(`/api/std/chat/sesiones/${sesionId}`, 'obtener el historial de la conversación');
}

/** `null` si el usuario nunca conversó antes sobre este documento — no es un error. */
export function fetchSesionDocumentoStd(idDocumento: number): Promise<SesionChatStd | null> {
  return apiJson(
    `/api/std/chat/sesiones/documento/${idDocumento}`,
    'buscar la conversación anterior de este documento',
  );
}

export function fetchEstadoIngestaDocumentoStd(idDocumento: number): Promise<EstadoIngestaDocumentoStd> {
  return apiJson(
    `/api/std/chat/documento/${idDocumento}/estado`,
    'obtener el estado de indexación de este documento',
  );
}

/** Busca por N° STD o por el número formal del documento ("001-2020-MINEDU/..."). */
export function buscarDocumentosStd(termino: string): Promise<DocumentoChatStd[]> {
  const params = new URLSearchParams({ q: termino });
  return apiJson(`/api/std/documentos/buscar?${params}`, 'buscar el documento');
}

export function etiquetaDocumentoStd(d: Pick<DocumentoChatStd, 'idDocumento' | 'documento'>): string {
  return d.documento ? `STD ${d.idDocumento} · ${d.documento}` : `STD ${d.idDocumento}`;
}

/** Ruta (no URL absoluta) del archivo citado — el token lo añade `apiFetch`, igual que `rutaDocumento` del SGD. */
export function rutaAdjuntoStd(idAdjunto: number): string {
  return `/api/std/adjuntos/${idAdjunto}/archivo`;
}

/**
 * Descriptor del chat del STD para `ChatPage.tsx` genérico — ver `api/chatComun.ts` y el
 * equivalente `adaptadorChatSgd` en `api/chat.ts`.
 */
export const adaptadorChatStd: AdaptadorChat<DocumentoChatStd, CitaChatStd> = {
  sistema: 'std',
  etiquetaPestanaGeneral: 'General STD',
  etiquetaPestanaContexto: 'Por documento',
  notaGeneral: 'Pregunta sobre todos los documentos del STD indexados (solo administradores).',
  labelBusqueda: 'N° STD o número de documento',
  placeholderBusqueda: 'Ej. 48683 o 001-2020-MINEDU/VMGP/UE118-OCP',
  notaVacioGeneral: 'Escriba una pregunta sobre los documentos del STD ya indexados.',
  notaVacioSinSeleccion: 'Busque el documento por su N° STD para empezar.',
  notaVacioConSeleccion: 'Escriba una pregunta sobre este documento.',
  notaSinResultados: 'No se encontró ningún documento del STD con ese término.',
  sustantivoContexto: 'documento',

  claveEntidad: (d) => String(d.idDocumento),
  etiquetaEntidad: etiquetaDocumentoStd,
  descripcionResultado: (d) => `${d.docsIngestados} de ${d.adjuntosPdfStd} documentos indexados`,

  buscar: buscarDocumentosStd,
  fetchSesion: (d) => fetchSesionDocumentoStd(d.idDocumento),
  fetchEstadoIngesta: (d) => fetchEstadoIngestaDocumentoStd(d.idDocumento),
  fetchHistorial: fetchHistorialSesionStd,
  enviarGeneral: enviarMensajeGeneralStd,
  enviarContexto: (d, mensaje, sesionId) => enviarMensajeDocumentoStd(d.idDocumento, mensaje, sesionId),
  fetchTexto: fetchTextoChunkStd,
  abrirCita: (cita) => ({
    url: rutaAdjuntoStd(cita.idAdjunto),
    titulo: `[D${cita.numero}] ${cita.rutaTitulos ?? 'Documento citado'}`,
    visualizable: true,
  }),

  permisoGestionar: 'std.gestionar',
};
