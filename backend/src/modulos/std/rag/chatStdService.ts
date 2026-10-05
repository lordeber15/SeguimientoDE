import { QueryTypes } from 'sequelize';
import { stdRagSequelize } from '../config/stdRagDatabase';
import { chatDisponible, crearChatProvider } from '../../../compartido/ai/providerFactory';
import type { ChatProvider, MensajeChat, ResultadoChat } from '../../../compartido/ai/types';
import { rerankear } from '../../../compartido/rag/rerankService';
import {
  buscarHibridoStd,
  elegirDocumentoParaCitaStd,
  lineaTiempoStd,
  recortarPorPresupuestoStd,
  type LineaTiempoDocumentoStd,
} from './retrievalStdService';

/**
 * Orquestación del chat sobre el corpus RAG del STD — mismo flujo que
 * `modulos/sgd/rag/chatService.ts` (citas persistidas ANTES de llamar al proveedor, rerank previo
 * a numerar, degradación segura si el proveedor falla), reescrito contra `std_rag` y sin filtro de
 * permisos (el módulo STD completo ya está acotado a `admin` por las rutas, no por este servicio).
 *
 * Diferencia de identidad: el SGD "chatea por expediente"; el STD "chatea por documento" (N° STD,
 * `rag.chat_sesion.id_documento` — ver la migración `001_std_rag.sql`, `modo` solo admite
 * `'general'|'documento'`).
 */

const PRESUPUESTO_TOKENS_CONTEXTO = Number(process.env.RAG_CHAT_PRESUPUESTO_TOKENS ?? 3000);
const MAX_TOKENS_RESPUESTA = Number(process.env.RAG_CHAT_MAX_TOKENS_RESPUESTA ?? 800);
const MENSAJES_HISTORIAL = 8;

export class ChatStdError extends Error {
  readonly status: number;
  constructor(mensaje: string, status = 400) {
    super(mensaje);
    this.name = 'ChatStdError';
    this.status = status;
  }
}

/** Mismo motivo que `CitaRespuesta` del SGD: el texto completo se pide aparte, solo al desplegar la cita. */
export interface CitaRespuestaStd {
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
  citas: CitaRespuestaStd[];
  candidatosVec: number;
  candidatosFts: number;
  marcadoresAlucinados: number;
}

export interface PeticionChatStd {
  usuarioId: string;
  modo: 'general' | 'documento';
  mensaje: string;
  sesionId?: number;
  idDocumento?: number;
}

interface FilaSesion { id: number; usuario_id: string; modo: string; id_documento: number | null }

export interface SesionDocumentoStd {
  id: number;
  modo: string;
  idDocumento: number | null;
  feUltimoMsg: string;
}

/** Última sesión del usuario sobre un N° STD concreto, o `null` si nunca conversó sobre él. */
export async function sesionParaDocumentoStd(
  usuarioId: string,
  idDocumento: number,
): Promise<SesionDocumentoStd | null> {
  const filas = await stdRagSequelize.query<SesionDocumentoStd>(
    `SELECT id, modo, id_documento AS "idDocumento", fe_ultimo_msg::text AS "feUltimoMsg"
       FROM rag.chat_sesion
      WHERE usuario_id = $1 AND modo = 'documento' AND id_documento = $2
      ORDER BY fe_ultimo_msg DESC LIMIT 1`,
    { bind: [usuarioId, idDocumento], type: QueryTypes.SELECT },
  );
  return filas[0] ?? null;
}

async function obtenerOCrearSesion(p: PeticionChatStd): Promise<FilaSesion> {
  if (p.sesionId) {
    const filas = await stdRagSequelize.query<FilaSesion>(
      `SELECT id, usuario_id, modo, id_documento FROM rag.chat_sesion WHERE id = $1`,
      { bind: [p.sesionId], type: QueryTypes.SELECT },
    );
    const sesion = filas[0];
    if (!sesion) throw new ChatStdError('La sesión de chat no existe', 404);
    if (sesion.usuario_id !== p.usuarioId) throw new ChatStdError('Esa sesión no le pertenece', 403);
    return sesion;
  }

  const filas = await stdRagSequelize.query<FilaSesion>(
    `INSERT INTO rag.chat_sesion (usuario_id, modo, id_documento)
     VALUES ($1, $2, $3)
     RETURNING id, usuario_id, modo, id_documento`,
    { bind: [p.usuarioId, p.modo, p.idDocumento ?? null], type: QueryTypes.SELECT },
  );
  return filas[0];
}

async function guardarMensajeUsuario(sesionId: number, texto: string): Promise<void> {
  await stdRagSequelize.query(
    `INSERT INTO rag.chat_mensaje (sesion_id, rol, texto) VALUES ($1, 'user', $2)`,
    { bind: [sesionId, texto], type: QueryTypes.INSERT },
  );
}

async function crearMensajeAsistentePendiente(sesionId: number): Promise<number> {
  const filas = await stdRagSequelize.query<{ id: number }>(
    `INSERT INTO rag.chat_mensaje (sesion_id, rol, texto) VALUES ($1, 'assistant', '') RETURNING id`,
    { bind: [sesionId], type: QueryTypes.SELECT },
  );
  return filas[0].id;
}

async function borrarMensaje(mensajeId: number): Promise<void> {
  await stdRagSequelize.query(`DELETE FROM rag.chat_mensaje WHERE id = $1`, {
    bind: [mensajeId],
    type: QueryTypes.DELETE,
  });
}

async function actualizarMensajeAsistente(
  mensajeId: number,
  texto: string,
  uso: { tokensIn: number; tokensOut: number },
): Promise<void> {
  await stdRagSequelize.query(
    `UPDATE rag.chat_mensaje SET texto = $2, tokens_in = $3, tokens_out = $4 WHERE id = $1`,
    { bind: [mensajeId, texto, uso.tokensIn, uso.tokensOut], type: QueryTypes.UPDATE },
  );
}

async function tocarSesion(sesionId: number): Promise<void> {
  await stdRagSequelize.query(`UPDATE rag.chat_sesion SET fe_ultimo_msg = now() WHERE id = $1`, {
    bind: [sesionId],
    type: QueryTypes.UPDATE,
  });
}

interface FilaHistorial { rol: 'user' | 'assistant'; texto: string }

async function historialReciente(sesionId: number, excluirMensajeId: number): Promise<MensajeChat[]> {
  const filas = await stdRagSequelize.query<FilaHistorial>(
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
  idAdjunto: number;
  idDocumento: number;
  nroStd: string | null;
  origen: 'principal' | 'anexo' | 'derivacion';
  texto: string;
  rutaTitulos: string | null;
}

async function persistirCitas(mensajeId: number, citas: CitaPendiente[]): Promise<void> {
  for (const c of citas) {
    await stdRagSequelize.query(
      `INSERT INTO rag.cita (mensaje_id, numero, chunk_id, documento_id) VALUES ($1, $2, $3, $4)`,
      { bind: [mensajeId, c.numero, c.chunkId, c.documentoId], type: QueryTypes.INSERT },
    );
  }
}

async function marcarCitasUsadas(mensajeId: number, numerosUsados: number[]): Promise<void> {
  if (numerosUsados.length === 0) return;
  await stdRagSequelize.query(
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
  await stdRagSequelize.query(
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

async function registrarUsoToken(
  provider: ChatProvider,
  operacion: 'chat' | 'chat_rerank',
  uso: ResultadoChat['uso'],
): Promise<void> {
  await stdRagSequelize.query(
    `INSERT INTO rag.uso_token (proveedor, modelo, operacion, tokens_in, tokens_out, estimado, exito)
     VALUES ($1, $2, $3, $4, $5, $6, true)`,
    {
      bind: [provider.nombre, provider.modelo, operacion, uso.tokensIn, uso.tokensOut, uso.estimado],
      type: QueryTypes.INSERT,
    },
  );
}

function construirPromptSistemaStd(timeline: LineaTiempoDocumentoStd | null, citas: CitaPendiente[]): string {
  let contexto =
    'Eres un asistente que responde preguntas sobre documentos del STD (Sistema de Trámite '
    + 'Documentario de UE118/PMESUT), basándote ÚNICAMENTE en los fragmentos numerados de abajo y '
    + 'en la línea de tiempo de movimientos, si se incluye. Cuando uses información de un '
    + 'fragmento, cita su marcador exacto tal cual, por ejemplo [D1]. Nunca inventes un marcador '
    + 'que no aparezca abajo. Si la respuesta no está en los fragmentos ni en la línea de tiempo, '
    + 'dilo explícitamente en vez de adivinar.';

  if (timeline && timeline.movimientos.length > 0) {
    contexto += '\n\nLínea de tiempo de movimientos del documento (dato estructurado, no necesita cita):\n'
      + timeline.movimientos
        .map((m) => `- ${m.creado ?? 's/f'} · ${m.areaOrigen ?? '?'} (${m.remitente ?? '?'}) → `
          + `${m.areaDestino ?? '?'} (${m.destinatario ?? '?'}) · ${m.accion ?? ''} · ${m.estado ?? ''}`
          + `${m.observacion ? ` · ${m.observacion}` : ''}`)
        .join('\n');
  }

  if (timeline && timeline.referencias.length > 0) {
    contexto += '\n\nDocumentos que este referencia (dato estructurado, no necesita cita):\n'
      + timeline.referencias
        .map((r) => `- STD ${r.idDocumentoRef} · ${r.tipoDocumento ?? ''} ${r.documento ?? ''} · ${r.asunto ?? ''}`)
        .join('\n');
  }

  contexto += citas.length > 0
    ? '\n\nFragmentos disponibles:\n'
      + citas.map((c) => `[D${c.numero}] (${c.rutaTitulos ?? 'sin sección'})\n${c.texto}`).join('\n\n')
    : '\n\nNo se encontró ningún fragmento relevante para esta consulta.';

  return contexto;
}

export function extractoDeChunkStd(texto: string, limite = 180): string {
  const plano = texto.replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim();
  return plano.length <= limite ? plano : `${plano.slice(0, limite).trimEnd()}…`;
}

export function limpiarMarcadoresStd(
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

export async function responderChatStd(p: PeticionChatStd): Promise<RespuestaChatStd> {
  const disponibilidad = chatDisponible();
  if (!disponibilidad.disponible) {
    throw new ChatStdError(`El chat no está disponible: ${disponibilidad.motivo}`, 409);
  }
  if (!p.mensaje.trim()) throw new ChatStdError('El mensaje no puede estar vacío');
  if (p.modo === 'documento' && !p.idDocumento) {
    throw new ChatStdError('El modo "documento" requiere un N° STD', 400);
  }

  const provider = crearChatProvider();

  const inicio = Date.now();
  const sesion = await obtenerOCrearSesion(p);
  await guardarMensajeUsuario(sesion.id, p.mensaje);

  const [resultado, timeline] = await Promise.all([
    buscarHibridoStd(p.mensaje, p.modo === 'documento' ? p.idDocumento : undefined),
    p.modo === 'documento' && p.idDocumento ? lineaTiempoStd(p.idDocumento) : Promise.resolve(null),
  ]);

  const rerank = await rerankear(provider, p.mensaje, resultado.chunks);
  if (rerank.uso) await registrarUsoToken(provider, 'chat_rerank', rerank.uso);

  const chunksAcotados = recortarPorPresupuestoStd(rerank.chunks, PRESUPUESTO_TOKENS_CONTEXTO);

  const citas: CitaPendiente[] = [];
  let numero = 1;
  for (const c of chunksAcotados) {
    const documento = await elegirDocumentoParaCitaStd(c.sha256, p.idDocumento);
    if (documento === null) continue;
    citas.push({
      numero: numero++,
      chunkId: c.chunkId,
      documentoId: documento.id,
      idAdjunto: documento.idAdjunto,
      idDocumento: documento.idDocumento,
      nroStd: documento.nroStd,
      origen: documento.origen,
      texto: c.texto,
      rutaTitulos: c.rutaTitulos,
    });
  }

  const mensajeAsistenteId = await crearMensajeAsistentePendiente(sesion.id);
  await persistirCitas(mensajeAsistenteId, citas);

  try {
    const historial = await historialReciente(sesion.id, mensajeAsistenteId);
    const mensajes: MensajeChat[] = [
      { rol: 'system', contenido: construirPromptSistemaStd(timeline, citas) },
      ...historial,
      { rol: 'user', contenido: p.mensaje },
    ];

    const respuesta = await provider.responder(mensajes, { maxTokens: MAX_TOKENS_RESPUESTA });
    const { texto, numerosUsados, marcadoresInvalidos } = limpiarMarcadoresStd(respuesta.texto, citas);

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
        idAdjunto: c.idAdjunto,
        idDocumento: c.idDocumento,
        nroStd: c.nroStd,
        origen: c.origen,
        extracto: extractoDeChunkStd(c.texto),
        chars: c.texto.length,
        rutaTitulos: c.rutaTitulos,
        usada: numerosUsados.includes(c.numero),
      })),
      candidatosVec: resultado.candidatosVec,
      candidatosFts: resultado.candidatosFts,
      marcadoresAlucinados: marcadoresInvalidos.length,
    };
  } catch (error) {
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
  idAdjunto: number;
  idDocumento: number;
  nroStd: string | null;
  origen: 'principal' | 'anexo' | 'derivacion';
  cabeza: string;
  chars: number;
  rutaTitulos: string | null;
  usada: boolean;
}

export interface MensajeHistorialStd {
  id: number;
  rol: string;
  texto: string;
  feAlta: string;
  citas: CitaRespuestaStd[];
}

export async function listarSesionesStd(usuarioId: string): Promise<
  { id: number; modo: string; idDocumento: number | null; feUltimoMsg: string }[]
> {
  return stdRagSequelize.query(
    `SELECT id, modo, id_documento AS "idDocumento", fe_ultimo_msg::text AS "feUltimoMsg"
       FROM rag.chat_sesion WHERE usuario_id = $1 ORDER BY fe_ultimo_msg DESC LIMIT 50`,
    { bind: [usuarioId], type: QueryTypes.SELECT },
  );
}

async function citasDeMensajesStd(mensajeIds: number[]): Promise<Map<number, CitaRespuestaStd[]>> {
  const porMensaje = new Map<number, CitaRespuestaStd[]>();
  if (mensajeIds.length === 0) return porMensaje;

  const filas = await stdRagSequelize.query<FilaCitaHistorial>(
    `SELECT c.mensaje_id, c.numero, c.chunk_id AS "chunkId", c.documento_id AS "documentoId",
            d.id_adjunto AS "idAdjunto", d.id_documento AS "idDocumento", d.nro_std AS "nroStd", d.origen,
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
      idAdjunto: f.idAdjunto,
      idDocumento: f.idDocumento,
      nroStd: f.nroStd,
      origen: f.origen,
      extracto: extractoDeChunkStd(f.cabeza),
      chars: Number(f.chars),
      rutaTitulos: f.rutaTitulos,
      usada: f.usada,
    });
    porMensaje.set(f.mensaje_id, lista);
  }
  return porMensaje;
}

export async function obtenerHistorialSesionStd(
  sesionId: number,
  usuarioId: string,
): Promise<MensajeHistorialStd[]> {
  const sesiones = await stdRagSequelize.query<{ usuario_id: string }>(
    `SELECT usuario_id FROM rag.chat_sesion WHERE id = $1`,
    { bind: [sesionId], type: QueryTypes.SELECT },
  );
  if (!sesiones[0]) throw new ChatStdError('La sesión de chat no existe', 404);
  if (sesiones[0].usuario_id !== usuarioId) throw new ChatStdError('Esa sesión no le pertenece', 403);

  const filas = await stdRagSequelize.query<FilaMensajeHistorial>(
    `SELECT id, rol, texto, fe_alta::text FROM rag.chat_mensaje WHERE sesion_id = $1 ORDER BY id ASC`,
    { bind: [sesionId], type: QueryTypes.SELECT },
  );

  const idsAsistente = filas.filter((f) => f.rol === 'assistant').map((f) => f.id);
  const citasPorMensaje = await citasDeMensajesStd(idsAsistente);

  return filas.map((f) => ({
    id: f.id,
    rol: f.rol,
    texto: f.texto,
    feAlta: f.fe_alta,
    citas: citasPorMensaje.get(f.id) ?? [],
  }));
}

/**
 * Texto completo de un chunk citado, autorizado por PROPIEDAD DE LA CONVERSACIÓN — mismo criterio
 * que `textoChunkCitado` del SGD, solo que aquí no hace falta reafirmar ningún filtro de
 * dependencia: todo el módulo STD ya es de un único rol.
 */
export async function textoChunkCitadoStd(chunkId: number, usuarioId: string): Promise<string> {
  const filas = await stdRagSequelize.query<{ texto: string }>(
    `SELECT ch.texto
       FROM rag.chunk ch
       JOIN rag.cita c         ON c.chunk_id = ch.id
       JOIN rag.chat_mensaje m ON m.id = c.mensaje_id
       JOIN rag.chat_sesion s  ON s.id = m.sesion_id
      WHERE ch.id = $1 AND s.usuario_id = $2
      LIMIT 1`,
    { bind: [chunkId, usuarioId], type: QueryTypes.SELECT },
  );
  if (!filas[0]) throw new ChatStdError('Ese fragmento no está disponible', 404);
  return filas[0].texto;
}
