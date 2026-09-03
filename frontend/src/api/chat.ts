import { apiJson } from './cliente';

/**
 * La cita NO trae el texto completo del fragmento: solo un extracto de una línea para el preview.
 * El texto entero se pide con `fetchTextoChunk` al desplegarla — así una conversación larga no
 * arrastra decenas de miles de caracteres de markdown que casi nunca se leen.
 */
export interface CitaChat {
  numero: number;
  chunkId: number;
  documentoId: number;
  nuAnn: string;
  nuEmi: string;
  /** 0 = documento principal, >0 = anexo con ese número literal. */
  nuAne: number;
  extracto: string;
  /** Largo real del fragmento, para poder anunciarlo antes de cargarlo. */
  chars: number;
  rutaTitulos: string | null;
  usada: boolean;
}

export interface RespuestaChat {
  sesionId: number;
  mensajeId: number;
  texto: string;
  citas: CitaChat[];
  candidatosVec: number;
  candidatosFts: number;
  marcadoresAlucinados: number;
}

export interface SesionChat {
  id: number;
  modo: 'general' | 'expediente';
  nuAnnExp: string | null;
  nuSecExp: string | null;
  feUltimoMsg: string;
}

export interface MensajeHistorial {
  id: number;
  rol: 'user' | 'assistant';
  texto: string;
  feAlta: string;
  citas: CitaChat[];
}

export interface EstadoIngestaExpediente {
  total: number;
  listos: number;
  convertidos: number;
  pendientes: number;
  sinTexto: number;
  error: number;
  noSoportado: number;
  completo: boolean;
}

export interface ExpedienteChat {
  nuAnnExp: string;
  nuSecExp: string;
  /** Número visible del SGD. `null` si el barrido nunca lo trajo — se cae a la clave interna. */
  numeroExpediente: string | null;
  documentos: number;
  ingestados: number;
}

export function enviarMensajeGeneral(mensaje: string, sesionId?: number): Promise<RespuestaChat> {
  return apiJson('/api/rag/chat/general', 'enviar el mensaje', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mensaje, sesionId }),
  });
}

export function enviarMensajeExpediente(
  nuAnnExp: string,
  nuSecExp: string,
  mensaje: string,
  sesionId?: number,
): Promise<RespuestaChat> {
  return apiJson(`/api/rag/chat/expediente/${nuAnnExp}/${nuSecExp}`, 'enviar el mensaje', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mensaje, sesionId }),
  });
}

/** Texto completo del fragmento citado. Se pide al desplegar la cita, nunca antes. */
export function fetchTextoChunk(chunkId: number): Promise<{ texto: string }> {
  return apiJson(`/api/rag/chat/chunks/${chunkId}`, 'obtener el fragmento citado');
}

export function fetchSesiones(): Promise<SesionChat[]> {
  return apiJson('/api/rag/chat/sesiones', 'obtener las conversaciones anteriores');
}

export function fetchHistorialSesion(sesionId: number): Promise<MensajeHistorial[]> {
  return apiJson(`/api/rag/chat/sesiones/${sesionId}`, 'obtener el historial de la conversación');
}

/** `null` si el usuario nunca conversó antes sobre este expediente — no es un error. */
export function fetchSesionExpediente(nuAnnExp: string, nuSecExp: string): Promise<SesionChat | null> {
  return apiJson(
    `/api/rag/chat/sesiones/expediente/${nuAnnExp}/${nuSecExp}`,
    'buscar la conversación anterior de este expediente',
  );
}

export function fetchEstadoIngestaExpediente(
  nuAnnExp: string,
  nuSecExp: string,
): Promise<EstadoIngestaExpediente> {
  return apiJson(
    `/api/rag/chat/expediente/${nuAnnExp}/${nuSecExp}/estado`,
    'obtener el estado de indexación de este expediente',
  );
}

/** Misma clave que ya usa `ExpedienteTable` para las filas: `${nuAnnExp}-${nuSecExp}`. */
export function claveExpediente(nuAnnExp: string, nuSecExp: string): string {
  return `${nuAnnExp}-${nuSecExp}`;
}

/**
 * Busca por el número compuesto del expediente ("DE000020260000062", "2026-0000325"), que es el que
 * el usuario ve en el resto de la aplicación. También acepta el par año-secuencia ("2026-325").
 */
export function buscarExpedientesChat(termino: string): Promise<ExpedienteChat[]> {
  const params = new URLSearchParams({ q: termino });
  return apiJson(`/api/rag/chat/expedientes/buscar?${params}`, 'buscar el expediente');
}

/** Mismo fallback que ya usan las tablas: el número visible, o la clave interna si no lo hay. */
export function etiquetaExpediente(
  e: Pick<ExpedienteChat, 'numeroExpediente' | 'nuAnnExp' | 'nuSecExp'>,
): string {
  return e.numeroExpediente ?? claveExpediente(e.nuAnnExp, e.nuSecExp);
}

const LOTE_ESTADO_INDEXACION = 100; // debe calzar con MAX_PARES_ESTADO del backend

/**
 * Estado de ingesta de varios expedientes en una sola tanda de llamadas — para pintar el badge de
 * cada fila de la tabla sin pedirlo uno por uno. Trocea en lotes de 100 (el tope del backend) y
 * junta todo en un solo `Map`, indexado con `claveExpediente`.
 */
export async function fetchEstadosIndexacion(
  expedientes: { nuAnnExp: string; nuSecExp: string }[],
): Promise<Map<string, EstadoIngestaExpediente>> {
  const mapa = new Map<string, EstadoIngestaExpediente>();
  if (expedientes.length === 0) return mapa;

  const lotes: { nuAnnExp: string; nuSecExp: string }[][] = [];
  for (let i = 0; i < expedientes.length; i += LOTE_ESTADO_INDEXACION) {
    lotes.push(expedientes.slice(i, i + LOTE_ESTADO_INDEXACION));
  }

  const resultados = await Promise.all(
    lotes.map((lote) => {
      const pares = lote.map((e) => `${e.nuAnnExp}:${e.nuSecExp}`).join(',');
      return apiJson<(EstadoIngestaExpediente & { nuAnnExp: string; nuSecExp: string })[]>(
        `/api/rag/chat/expedientes/estado?pares=${encodeURIComponent(pares)}`,
        'obtener el estado de indexación de los expedientes',
      );
    }),
  );

  for (const lote of resultados) {
    for (const e of lote) mapa.set(claveExpediente(e.nuAnnExp, e.nuSecExp), e);
  }
  return mapa;
}
