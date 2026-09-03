import { QueryTypes } from 'sequelize';
import { appSequelize } from '../config/appDatabase';
import { chatDisponible, crearChatProvider } from '../ai/providerFactory';
import type { ChatProvider, MensajeChat, ResultadoChat } from '../ai/types';
import { rerankear } from './rerankService';
import {
  buscarHibrido,
  elegirDocumentoParaCita,
  estadoExpediente,
  recortarPorPresupuesto,
  type FiltroAcceso,
  type LineaTiempo,
} from './retrievalService';

/**
 * Orquestación del chat sobre el corpus RAG (PLAN-RAG.md §9, Fase 5; rerank de Fase 6).
 *
 * Las citas se persisten en `rag.cita` ANTES de llamar al proveedor de chat: el mensaje del
 * asistente se crea primero con texto vacío para tener un `mensaje_id` al que colgarlas, y solo
 * después se pide la respuesta al modelo. Así `[Dn]` siempre resuelve a algo real aunque el
 * modelo alucine un número que nunca se ofreció — y si la llamada al proveedor falla, se puede
 * deshacer limpiamente (el mensaje pendiente se borra, cascada incluida en `rag.cita`).
 *
 * El rerank (Fase 6) corre ANTES de numerar las citas: así `[D1]` es siempre el fragmento que el
 * propio modelo consideró más relevante, no un accidente del orden de RRF.
 */

const PRESUPUESTO_TOKENS_CONTEXTO = Number(process.env.RAG_CHAT_PRESUPUESTO_TOKENS ?? 3000);
const MAX_TOKENS_RESPUESTA = Number(process.env.RAG_CHAT_MAX_TOKENS_RESPUESTA ?? 800);
const MENSAJES_HISTORIAL = 8;

export class ChatError extends Error {
  readonly status: number;
  constructor(mensaje: string, status = 400) {
    super(mensaje);
    this.name = 'ChatError';
    this.status = status;
  }
}

/**
 * La cita NO viaja con el texto completo del chunk: el frontend lo pide aparte con
 * `GET /api/rag/chat/chunks/:id` solo cuando el usuario despliega esa cita. Un chunk ronda los
 * 2 800 caracteres y un historial de 10 mensajes × 5 citas serializaba ~140 KB de markdown crudo
 * que casi nunca se llegaba a leer.
 */
export interface CitaRespuesta {
  numero: number;
  chunkId: number;
  documentoId: number;
  nuAnn: string;
  nuEmi: string;
  nuAne: number;
  /** Una línea ya normalizada, para el preview de la cita cerrada. */
  extracto: string;
  /** Largo real del chunk — el frontend decide con esto si vale la pena ofrecer "abrir". */
  chars: number;
  rutaTitulos: string | null;
  usada: boolean;
}

export interface RespuestaChat {
  sesionId: number;
  mensajeId: number;
  texto: string;
  citas: CitaRespuesta[];
  candidatosVec: number;
  candidatosFts: number;
  marcadoresAlucinados: number;
}

export interface PeticionChat {
  usuarioId: string;
  /** admin y jefe ven todo el corpus; cualquier otro rol queda acotado a su propia dependencia. */
  sinRestriccionDependencia: boolean;
  coDependencia: string | null;
  modo: 'general' | 'expediente';
  mensaje: string;
  sesionId?: number;
  expediente?: { nuAnnExp: string; nuSecExp: string };
}

interface FilaSesion { id: number; usuario_id: string; modo: string; nu_ann_exp: string | null; nu_sec_exp: string | null }

export interface SesionExpediente {
  id: number;
  modo: string;
  nuAnnExp: string | null;
  nuSecExp: string | null;
  feUltimoMsg: string;
}

/**
 * Última sesión del usuario para un expediente concreto, o `null` si nunca conversó sobre él.
 * `nuSecExp` debe llegar ya paddeado a 10 dígitos: así es como se guarda en `rag.chat_sesion`
 * (ver `postChatExpediente`), y una comparación sin paddear nunca encontraría la fila.
 */
export async function sesionParaExpediente(
  usuarioId: string,
  nuAnnExp: string,
  nuSecExp: string,
): Promise<SesionExpediente | null> {
  const filas = await appSequelize.query<SesionExpediente>(
    `SELECT id, modo, nu_ann_exp AS "nuAnnExp", nu_sec_exp AS "nuSecExp",
            fe_ultimo_msg::text AS "feUltimoMsg"
       FROM rag.chat_sesion
      WHERE usuario_id = $1 AND modo = 'expediente' AND nu_ann_exp = $2 AND nu_sec_exp = $3
      ORDER BY fe_ultimo_msg DESC LIMIT 1`,
    { bind: [usuarioId, nuAnnExp, nuSecExp], type: QueryTypes.SELECT },
  );
  return filas[0] ?? null;
}

async function obtenerOCrearSesion(p: PeticionChat): Promise<FilaSesion> {
  if (p.sesionId) {
    const filas = await appSequelize.query<FilaSesion>(
      `SELECT id, usuario_id, modo, nu_ann_exp, nu_sec_exp FROM rag.chat_sesion WHERE id = $1`,
      { bind: [p.sesionId], type: QueryTypes.SELECT },
    );
    const sesion = filas[0];
    if (!sesion) throw new ChatError('La sesión de chat no existe', 404);
    if (sesion.usuario_id !== p.usuarioId) throw new ChatError('Esa sesión no le pertenece', 403);
    return sesion;
  }

  const filas = await appSequelize.query<FilaSesion>(
    `INSERT INTO rag.chat_sesion (usuario_id, modo, nu_ann_exp, nu_sec_exp)
     VALUES ($1, $2, $3, $4)
     RETURNING id, usuario_id, modo, nu_ann_exp, nu_sec_exp`,
    {
      bind: [p.usuarioId, p.modo, p.expediente?.nuAnnExp ?? null, p.expediente?.nuSecExp ?? null],
      type: QueryTypes.SELECT,
    },
  );
  return filas[0];
}

async function guardarMensajeUsuario(sesionId: number, texto: string): Promise<void> {
  await appSequelize.query(
    `INSERT INTO rag.chat_mensaje (sesion_id, rol, texto) VALUES ($1, 'user', $2)`,
    { bind: [sesionId, texto], type: QueryTypes.INSERT },
  );
}

async function crearMensajeAsistentePendiente(sesionId: number): Promise<number> {
  const filas = await appSequelize.query<{ id: number }>(
    `INSERT INTO rag.chat_mensaje (sesion_id, rol, texto) VALUES ($1, 'assistant', '') RETURNING id`,
    { bind: [sesionId], type: QueryTypes.SELECT },
  );
  return filas[0].id;
}

async function borrarMensaje(mensajeId: number): Promise<void> {
  await appSequelize.query(`DELETE FROM rag.chat_mensaje WHERE id = $1`, {
    bind: [mensajeId],
    type: QueryTypes.DELETE,
  });
}

async function actualizarMensajeAsistente(
  mensajeId: number,
  texto: string,
  uso: { tokensIn: number; tokensOut: number },
): Promise<void> {
  await appSequelize.query(
    `UPDATE rag.chat_mensaje SET texto = $2, tokens_in = $3, tokens_out = $4 WHERE id = $1`,
    { bind: [mensajeId, texto, uso.tokensIn, uso.tokensOut], type: QueryTypes.UPDATE },
  );
}

async function tocarSesion(sesionId: number): Promise<void> {
  await appSequelize.query(`UPDATE rag.chat_sesion SET fe_ultimo_msg = now() WHERE id = $1`, {
    bind: [sesionId],
    type: QueryTypes.UPDATE,
  });
}

interface FilaHistorial { rol: 'user' | 'assistant'; texto: string }

async function historialReciente(sesionId: number, excluirMensajeId: number): Promise<MensajeChat[]> {
  const filas = await appSequelize.query<FilaHistorial>(
    `SELECT rol, texto FROM rag.chat_mensaje
      WHERE sesion_id = $1 AND id != $2
      ORDER BY id DESC LIMIT $3`,
    { bind: [sesionId, excluirMensajeId, MENSAJES_HISTORIAL], type: QueryTypes.SELECT },
  );
  return filas.reverse().map((f) => ({ rol: f.rol, contenido: f.texto }));
}

interface CitaPendiente {
  numero: number;
  chunkId: number;
  documentoId: number;
  nuAnn: string;
  nuEmi: string;
  nuAne: number;
  texto: string;
  rutaTitulos: string | null;
}

async function persistirCitas(mensajeId: number, citas: CitaPendiente[]): Promise<void> {
  for (const c of citas) {
    await appSequelize.query(
      `INSERT INTO rag.cita (mensaje_id, numero, chunk_id, documento_id) VALUES ($1, $2, $3, $4)`,
      { bind: [mensajeId, c.numero, c.chunkId, c.documentoId], type: QueryTypes.INSERT },
    );
  }
}

async function marcarCitasUsadas(mensajeId: number, numerosUsados: number[]): Promise<void> {
  if (numerosUsados.length === 0) return;
  await appSequelize.query(
    `UPDATE rag.cita SET usada = true WHERE mensaje_id = $1 AND numero = ANY($2::int[])`,
    { bind: [mensajeId, numerosUsados], type: QueryTypes.UPDATE },
  );
}

async function registrarRetrieval(datos: {
  sesionId: number;
  consulta: string;
  modo: string;
  candidatosVec: number;
  candidatosFts: number;
  fusionados: number;
  escaneoExacto: boolean;
  marcadoresAlucinados: number;
  ms: number;
}): Promise<void> {
  await appSequelize.query(
    `INSERT INTO rag.retrieval_log
       (sesion_id, consulta, modo, candidatos_vec, candidatos_fts, fusionados, escaneo_exacto,
        marcadores_alucinados, ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    {
      bind: [
        datos.sesionId, datos.consulta, datos.modo, datos.candidatosVec, datos.candidatosFts,
        datos.fusionados, datos.escaneoExacto, datos.marcadoresAlucinados, datos.ms,
      ],
      type: QueryTypes.INSERT,
    },
  );
}

/** `rag.uso_token` ya existía para embeddings (Fase 3); el chat y el rerank no registraban nada
 * ahí — un gasto real e invisible para el panel de costes. `job_id` queda NULL: no hay un
 * `ingest_job` que lo posea, es una llamada disparada por el usuario, no por un job de fondo. */
async function registrarUsoToken(
  provider: ChatProvider,
  operacion: 'chat' | 'chat_rerank',
  uso: ResultadoChat['uso'],
): Promise<void> {
  await appSequelize.query(
    `INSERT INTO rag.uso_token (proveedor, modelo, operacion, tokens_in, tokens_out, estimado, exito)
     VALUES ($1, $2, $3, $4, $5, $6, true)`,
    {
      bind: [provider.nombre, provider.modelo, operacion, uso.tokensIn, uso.tokensOut, uso.estimado],
      type: QueryTypes.INSERT,
    },
  );
}

function construirPromptSistema(timeline: LineaTiempo[] | null, citas: CitaPendiente[]): string {
  let contexto =
    'Eres un asistente que responde preguntas sobre expedientes del SGD de ONPE, basándote '
    + 'ÚNICAMENTE en los fragmentos numerados de abajo. Cuando uses información de un fragmento, '
    + 'cita su marcador exacto tal cual, por ejemplo [D1]. Nunca inventes un marcador que no '
    + 'aparezca abajo. Si la respuesta no está en los fragmentos ni en la línea de tiempo, dilo '
    + 'explícitamente en vez de adivinar.';

  if (timeline && timeline.length > 0) {
    contexto += '\n\nLínea de tiempo del expediente (dato estructurado, no necesita cita):\n'
      + timeline
        .map((t) => `- ${t.fecha ?? 's/f'} · ${t.tipoDocumento ?? ''} ${t.numeroDocumento ?? ''} · `
          + `${t.dependenciaEmisora ?? '?'} → ${t.dependenciaDestino ?? '?'} · ${t.estado ?? ''} · ${t.asunto ?? ''}`)
        .join('\n');
  }

  contexto += citas.length > 0
    ? '\n\nFragmentos disponibles:\n'
      + citas.map((c) => `[D${c.numero}] (${c.rutaTitulos ?? 'sin sección'})\n${c.texto}`).join('\n\n')
    : '\n\nNo se encontró ningún fragmento relevante para esta consulta.';

  return contexto;
}

/**
 * Extracto de una línea para la cita cerrada: sin los `#` de los encabezados y con los saltos
 * colapsados, porque en la cabecera de la cita se pinta en una sola línea con ellipsis.
 */
export function extractoDeChunk(texto: string, limite = 180): string {
  const plano = texto.replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim();
  return plano.length <= limite ? plano : `${plano.slice(0, limite).trimEnd()}…`;
}

/** Elimina del texto los marcadores `[Dn]` que no corresponden a ninguna cita ofrecida. */
export function limpiarMarcadores(
  texto: string,
  citas: { numero: number }[],
): { texto: string; numerosUsados: number[]; marcadoresInvalidos: number[] } {
  const validos = new Set(citas.map((c) => c.numero));
  const usados = new Set<number>();
  const invalidos: number[] = [];

  const limpio = texto.replace(/\[D(\d+)\]/g, (coincide, grupo: string) => {
    const numero = Number(grupo);
    if (validos.has(numero)) {
      usados.add(numero);
      return coincide;
    }
    invalidos.push(numero);
    return '';
  });

  return { texto: limpio, numerosUsados: [...usados], marcadoresInvalidos: invalidos };
}

export async function responderChat(p: PeticionChat): Promise<RespuestaChat> {
  const disponibilidad = chatDisponible();
  if (!disponibilidad.disponible) {
    throw new ChatError(`El chat no está disponible: ${disponibilidad.motivo}`, 409);
  }
  if (!p.mensaje.trim()) throw new ChatError('El mensaje no puede estar vacío');

  // Un solo proveedor para todo el turno (rerank + respuesta): evita instanciarlo dos veces y dos
  // configuraciones que en teoría deberían ser la misma pero, tras un cambio de `.env`, no lo son.
  const provider = crearChatProvider();

  const inicio = Date.now();
  const sesion = await obtenerOCrearSesion(p);
  await guardarMensajeUsuario(sesion.id, p.mensaje);

  const filtro: FiltroAcceso = { coDependencia: p.sinRestriccionDependencia ? null : p.coDependencia };

  const [resultado, timeline] = await Promise.all([
    buscarHibrido(p.mensaje, filtro),
    p.modo === 'expediente' && p.expediente
      ? estadoExpediente(p.expediente.nuAnnExp, p.expediente.nuSecExp)
      : Promise.resolve(null),
  ]);

  const rerank = await rerankear(provider, p.mensaje, resultado.chunks);
  if (rerank.uso) await registrarUsoToken(provider, 'chat_rerank', rerank.uso);

  const chunksAcotados = recortarPorPresupuesto(rerank.chunks, PRESUPUESTO_TOKENS_CONTEXTO);

  const citas: CitaPendiente[] = [];
  let numero = 1;
  for (const c of chunksAcotados) {
    // Reafirma el filtro de permisos al elegir el documento de la cita: el chunk ya vino
    // filtrado por `buscarHibrido`, pero la cita debe señalar un documento accesible en concreto.
    const documento = await elegirDocumentoParaCita(c.sha256, filtro, p.expediente);
    if (documento === null) continue;
    citas.push({
      numero: numero++,
      chunkId: c.chunkId,
      documentoId: documento.id,
      nuAnn: documento.nuAnn,
      nuEmi: documento.nuEmi,
      nuAne: documento.nuAne,
      texto: c.texto,
      rutaTitulos: c.rutaTitulos,
    });
  }

  const mensajeAsistenteId = await crearMensajeAsistentePendiente(sesion.id);
  await persistirCitas(mensajeAsistenteId, citas);

  try {
    const historial = await historialReciente(sesion.id, mensajeAsistenteId);
    const mensajes: MensajeChat[] = [
      { rol: 'system', contenido: construirPromptSistema(timeline, citas) },
      ...historial,
      { rol: 'user', contenido: p.mensaje },
    ];

    const respuesta = await provider.responder(mensajes, { maxTokens: MAX_TOKENS_RESPUESTA });
    const { texto, numerosUsados, marcadoresInvalidos } = limpiarMarcadores(respuesta.texto, citas);

    await marcarCitasUsadas(mensajeAsistenteId, numerosUsados);
    await actualizarMensajeAsistente(mensajeAsistenteId, texto, respuesta.uso);
    await registrarUsoToken(provider, 'chat', respuesta.uso);
    await tocarSesion(sesion.id);
    await registrarRetrieval({
      sesionId: sesion.id,
      consulta: p.mensaje,
      modo: p.modo,
      candidatosVec: resultado.candidatosVec,
      candidatosFts: resultado.candidatosFts,
      fusionados: chunksAcotados.length,
      escaneoExacto: resultado.escaneoExacto,
      marcadoresAlucinados: marcadoresInvalidos.length,
      ms: Date.now() - inicio,
    });

    return {
      sesionId: sesion.id,
      mensajeId: mensajeAsistenteId,
      texto,
      citas: citas.map((c) => ({
        numero: c.numero,
        chunkId: c.chunkId,
        documentoId: c.documentoId,
        nuAnn: c.nuAnn,
        nuEmi: c.nuEmi,
        nuAne: c.nuAne,
        extracto: extractoDeChunk(c.texto),
        chars: c.texto.length,
        rutaTitulos: c.rutaTitulos,
        usada: numerosUsados.includes(c.numero),
      })),
      candidatosVec: resultado.candidatosVec,
      candidatosFts: resultado.candidatosFts,
      marcadoresAlucinados: marcadoresInvalidos.length,
    };
  } catch (error) {
    // La llamada al proveedor falló: no queda ninguna respuesta real que sostenga las citas
    // ofrecidas, así que se deshace el mensaje pendiente (cascada sobre `rag.cita`).
    await borrarMensaje(mensajeAsistenteId);
    throw error;
  }
}

interface FilaMensajeHistorial {
  id: number;
  rol: 'user' | 'assistant';
  texto: string;
  fe_alta: string;
}

interface FilaCitaHistorial {
  mensaje_id: number;
  numero: number;
  chunkId: number;
  documentoId: number;
  nuAnn: string;
  nuEmi: string;
  nuAne: number;
  /** Primeros caracteres del chunk, ya recortados por Postgres — ver `citasDeMensajes`. */
  cabeza: string;
  chars: number;
  rutaTitulos: string | null;
  usada: boolean;
}

export interface MensajeHistorial {
  id: number;
  rol: string;
  texto: string;
  feAlta: string;
  citas: CitaRespuesta[];
}

export async function listarSesiones(usuarioId: string): Promise<
  { id: number; modo: string; nuAnnExp: string | null; nuSecExp: string | null; feUltimoMsg: string }[]
> {
  return appSequelize.query(
    `SELECT id, modo, nu_ann_exp AS "nuAnnExp", nu_sec_exp AS "nuSecExp",
            fe_ultimo_msg::text AS "feUltimoMsg"
       FROM rag.chat_sesion WHERE usuario_id = $1 ORDER BY fe_ultimo_msg DESC LIMIT 50`,
    { bind: [usuarioId], type: QueryTypes.SELECT },
  );
}

/**
 * Citas de los mensajes `assistant` de una sesión, en un solo `SELECT` (no N+1). No filtra por
 * `d.vigente`: el `documento_id` ya quedó fijado al responder (vía `elegirDocumentoParaCita`), y
 * releerlo reproduce exactamente lo que se citó entonces, sin importar si el documento cambió de
 * vigencia después.
 *
 * El chunk se recorta con `left()` EN POSTGRES, no en Node: abrir una conversación larga traía
 * decenas de chunks completos por la red solo para tirar el 95 % al serializar. 400 caracteres
 * sobran para que `extractoDeChunk` produzca su línea de 180 aunque el chunk empiece con varios
 * encabezados que se colapsan.
 */
async function citasDeMensajes(mensajeIds: number[]): Promise<Map<number, CitaRespuesta[]>> {
  const porMensaje = new Map<number, CitaRespuesta[]>();
  if (mensajeIds.length === 0) return porMensaje;

  const filas = await appSequelize.query<FilaCitaHistorial>(
    `SELECT c.mensaje_id, c.numero, c.chunk_id AS "chunkId", c.documento_id AS "documentoId",
            d.nu_ann AS "nuAnn", d.nu_emi AS "nuEmi", d.nu_ane AS "nuAne",
            left(ch.texto, 400) AS cabeza, length(ch.texto) AS chars,
            ch.ruta_titulos AS "rutaTitulos", c.usada
       FROM rag.cita c
       JOIN rag.chunk ch ON ch.id = c.chunk_id
       JOIN rag.documento d ON d.id = c.documento_id
      WHERE c.mensaje_id = ANY($1::bigint[])
      ORDER BY c.mensaje_id, c.numero`,
    { bind: [mensajeIds], type: QueryTypes.SELECT },
  );

  for (const f of filas) {
    const lista = porMensaje.get(f.mensaje_id) ?? [];
    lista.push({
      numero: f.numero,
      chunkId: f.chunkId,
      documentoId: f.documentoId,
      nuAnn: f.nuAnn,
      nuEmi: f.nuEmi,
      nuAne: f.nuAne,
      extracto: extractoDeChunk(f.cabeza),
      chars: Number(f.chars),
      rutaTitulos: f.rutaTitulos,
      usada: f.usada,
    });
    porMensaje.set(f.mensaje_id, lista);
  }
  return porMensaje;
}

export async function obtenerHistorialSesion(
  sesionId: number,
  usuarioId: string,
): Promise<MensajeHistorial[]> {
  const sesiones = await appSequelize.query<{ usuario_id: string }>(
    `SELECT usuario_id FROM rag.chat_sesion WHERE id = $1`,
    { bind: [sesionId], type: QueryTypes.SELECT },
  );
  if (!sesiones[0]) throw new ChatError('La sesión de chat no existe', 404);
  if (sesiones[0].usuario_id !== usuarioId) throw new ChatError('Esa sesión no le pertenece', 403);

  const filas = await appSequelize.query<FilaMensajeHistorial>(
    `SELECT id, rol, texto, fe_alta::text FROM rag.chat_mensaje WHERE sesion_id = $1 ORDER BY id ASC`,
    { bind: [sesionId], type: QueryTypes.SELECT },
  );

  const idsAsistente = filas.filter((f) => f.rol === 'assistant').map((f) => f.id);
  const citasPorMensaje = await citasDeMensajes(idsAsistente);

  return filas.map((f) => ({
    id: f.id,
    rol: f.rol,
    texto: f.texto,
    feAlta: f.fe_alta,
    citas: citasPorMensaje.get(f.id) ?? [],
  }));
}

/**
 * Texto completo de un chunk, para cuando el usuario despliega una cita.
 *
 * Autoriza por PROPIEDAD DE LA CONVERSACIÓN, no por dependencia: solo devuelve el chunk si fue
 * citado dentro de una sesión del propio usuario. Es más estricto que replicar `FiltroAcceso` aquí
 * — el filtro de dependencia ya se aplicó en su momento dentro de `elegirDocumentoParaCita`, así
 * que un chunk que llegó a citarse en una sesión propia es, por construcción, uno que este usuario
 * tenía derecho a ver. Un id inventado o ajeno no encuentra fila y sale por el 404.
 */
export async function textoChunkCitado(chunkId: number, usuarioId: string): Promise<string> {
  const filas = await appSequelize.query<{ texto: string }>(
    `SELECT ch.texto
       FROM rag.chunk ch
       JOIN rag.cita c         ON c.chunk_id = ch.id
       JOIN rag.chat_mensaje m ON m.id = c.mensaje_id
       JOIN rag.chat_sesion s  ON s.id = m.sesion_id
      WHERE ch.id = $1 AND s.usuario_id = $2
      LIMIT 1`,
    { bind: [chunkId, usuarioId], type: QueryTypes.SELECT },
  );
  if (!filas[0]) throw new ChatError('Ese fragmento no está disponible', 404);
  return filas[0].texto;
}
