import { QueryTypes } from 'sequelize';
import { stdRagSequelize } from '../config/stdRagDatabase';
import { chatDisponible, crearChatProvider, crearChatProviderRapido } from '../../../compartido/ai/providerFactory';
import type { ChatProvider, MensajeChat, ResultadoChat } from '../../../compartido/ai/types';
import { leerParametros, prepararTerminos, terminosDeConsulta, terminosDelPlan } from '../../../compartido/rag/busquedaTerminos';
import { filtroGratis, mensajeFijo, type MotivoFijo } from '../../../compartido/rag/cierreChat';
import { leerBooleano } from '../../../compartido/rag/configService';
import { planDeRespaldo, planificar, type ResultadoPlanificador } from '../../../compartido/rag/planificadorService';
import { programarJuicio } from '../../../compartido/rag/juezService';
import { ERRORES_VALORACION, guardarValoracion } from '../../../compartido/rag/valoracionService';
import { rerankear, type ResultadoRerank } from '../../../compartido/rag/rerankService';
import {
  combinarBusquedas,
  expandirConVocabulario,
  generarHyde,
  transformacionesDelTurno,
  type Transformaciones,
} from '../../../compartido/rag/transformacionConsulta';
import { enTraza, evento, paso, trazaActual, type Traza } from '../../../compartido/observabilidad/traza';
import { avisarMarcadoresAlucinados } from '../../../compartido/observabilidad/alertas';
import { idDeCandidato } from './busquedaDocumentosStdService';
import {
  ejecutarListadoStd,
  esMetaListadoStd,
  paginaDesdeMetaStd,
  resumenTablaStd,
  type TablaDocumentosStd,
} from './listadoChatStdService';
import {
  agruparPorObraStd,
  ejecutarParticipantesStd,
  ejecutarUltimoDocumentoStd,
  type BloqueParticipantesStd,
  type TarjetaDocumentoStd,
} from './respuestasEstructuradasStdService';
import {
  buscarHibridoStd,
  elegirDocumentoParaCitaStd,
  LIMITE_RESULTADO,
  lineaTiempoStd,
  recortarPorPresupuestoStd,
  TOPE_POR_DOCUMENTO,
  type ChunkRecuperadoStd,
  type LineaTiempoDocumentoStd,
  type ResultadoBusquedaStd,
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
 *
 * Desde la Fase 7 de docs/PLAN-CHAT-CONSULTAS.md, el mismo flujo por intención que el SGD: filtro
 * gratis y planificador (compartidos), mensajes fijos, `listar`/`contar` → tabla de documentos,
 * `ultimo_documento` / `participantes` / `agrupar` sin modelo de respuesta, y `contenido` con la
 * consulta reescrita, el conjunto activo ("de esos…") y los términos del plan en el FTS.
 */

const PRESUPUESTO_TOKENS_CONTEXTO = Number(process.env.RAG_CHAT_PRESUPUESTO_TOKENS ?? 3000);
const MAX_TOKENS_RESPUESTA = Number(process.env.RAG_CHAT_MAX_TOKENS_RESPUESTA ?? 800);
const MENSAJES_HISTORIAL = 8;
/** Igual que el SGD: el comienzo de cada respuesta previa basta para seguir el hilo. */
const MAX_CHARS_HISTORIAL_ASISTENTE = 700;
/** Tope del conjunto activo al acotar la búsqueda de contenido. */
const MAX_CONJUNTO_CONTENIDO = 300;

export class ChatStdError extends Error {
  readonly status: number;
  /** Viaja en el cuerpo de la respuesta de error (p. ej. `mensajeFallidoId` para ofrecer "Reintentar"). */
  readonly datos?: Record<string, unknown>;
  constructor(mensaje: string, status = 400, datos?: Record<string, unknown>) {
    super(mensaje);
    this.name = 'ChatStdError';
    this.status = status;
    this.datos = datos;
  }
}

/** Igual que `errorTurnoFallido` del SGD. */
function errorTurnoFallidoStd(mensajeId: number, sesionId: number, causa: unknown): ChatStdError {
  const detalle = causa instanceof Error ? causa.message : String(causa);
  return new ChatStdError(
    'El modelo no pudo generar la respuesta. La búsqueda quedó guardada: puede reintentar sin volver a escribir la pregunta.',
    502,
    // Number(): los ids bigserial llegan como string desde pg.
    { mensajeFallidoId: Number(mensajeId), sesionId: Number(sesionId), reintentable: true, detalle: detalle.slice(0, 300) },
  );
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

export type TipoRespuestaStd = 'texto' | 'tabla' | 'fijo' | 'documento' | 'participantes';

export interface RespuestaChatStd {
  sesionId: number;
  mensajeId: number;
  tipo: TipoRespuestaStd;
  texto: string;
  citas: CitaRespuestaStd[];
  tabla?: TablaDocumentosStd;
  documento?: TarjetaDocumentoStd;
  participantes?: BloqueParticipantesStd;
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

async function crearMensajeAsistentePendiente(sesionId: number, trazaId: string | null): Promise<number> {
  const filas = await stdRagSequelize.query<{ id: number }>(
    `INSERT INTO rag.chat_mensaje (sesion_id, rol, texto, traza_id) VALUES ($1, 'assistant', '', $2) RETURNING id`,
    { bind: [sesionId, trazaId], type: QueryTypes.SELECT },
  );
  return filas[0].id;
}

/** Ver `marcarFallido` del SGD: el turno queda reintentable en vez de borrarse. */
async function marcarFallido(mensajeId: number, meta: Record<string, unknown>): Promise<void> {
  await stdRagSequelize.query(
    `UPDATE rag.chat_mensaje SET estado = 'fallido', meta = $2::jsonb WHERE id = $1`,
    { bind: [mensajeId, JSON.stringify(meta)], type: QueryTypes.UPDATE },
  );
}

async function actualizarMensajeAsistente(
  mensajeId: number,
  texto: string,
  uso: { tokensIn: number; tokensOut: number },
): Promise<void> {
  await stdRagSequelize.query(
    `UPDATE rag.chat_mensaje SET texto = $2, tokens_in = $3, tokens_out = $4, estado = 'ok' WHERE id = $1`,
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

/** Ver `historialReciente` del SGD: turnos anteriores a `antesDe`, sin los fallidos. */
async function historialReciente(sesionId: number, antesDe: number | null = null): Promise<MensajeChat[]> {
  const filas = await stdRagSequelize.query<FilaHistorial>(
    `SELECT rol, texto FROM rag.chat_mensaje
      WHERE sesion_id = $1 AND ($2::bigint IS NULL OR id < $2) AND estado = 'ok'
      ORDER BY id DESC LIMIT $3`,
    { bind: [sesionId, antesDe, MENSAJES_HISTORIAL], type: QueryTypes.SELECT },
  );
  return filas.reverse().map((f) => ({
    rol: f.rol,
    contenido: f.rol === 'assistant' && f.texto.length > MAX_CHARS_HISTORIAL_ASISTENTE
      ? `${f.texto.slice(0, MAX_CHARS_HISTORIAL_ASISTENTE).trimEnd()}…`
      : f.texto,
  }));
}

/** Conjunto activo: los N° STD del último listado de la sesión (`null` si no hubo ninguno). */
async function conjuntoActivo(sesionId: number): Promise<number[] | null> {
  const filas = await stdRagSequelize.query<{ meta: unknown }>(
    `SELECT meta FROM rag.chat_mensaje
      WHERE sesion_id = $1 AND tipo = 'tabla'
      ORDER BY id DESC LIMIT 1`,
    { bind: [sesionId], type: QueryTypes.SELECT },
  );
  const meta = filas[0]?.meta;
  return esMetaListadoStd(meta) ? meta.documentos.map(idDeCandidato) : null;
}

export interface CitaPendiente {
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
  planificador: ResultadoPlanificador | null;
  respuestaFija: MotivoFijo | null;
}): Promise<void> {
  const p = datos.planificador;
  await stdRagSequelize.query(
    `INSERT INTO rag.retrieval_log
       (sesion_id, consulta, modo, candidatos_vec, candidatos_fts, fusionados, escaneo_exacto,
        marcadores_alucinados, ms, intencion, consulta_reescrita, planificador_respaldo,
        ms_planificador, respuesta_fija, traza_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    {
      bind: [
        datos.sesionId, datos.consulta, datos.modo, datos.candidatosVec, datos.candidatosFts,
        datos.fusionados, datos.escaneoExacto, datos.marcadoresAlucinados, datos.ms,
        p?.plan.intencion ?? null, p?.plan.consulta ?? null, p?.respaldo ?? null, p?.ms ?? null,
        datos.respuestaFija, trazaActual()?.id ?? null,
      ],
      type: QueryTypes.INSERT,
    },
  );
}

async function registrarUsoToken(
  provider: ChatProvider,
  operacion: 'chat' | 'chat_rerank' | 'chat_planificador' | 'chat_hyde',
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
    + 'en la línea de tiempo de movimientos, si se incluye. No uses conocimiento general ni supongas '
    + 'datos que no estén escritos ahí: si la respuesta no está, responde exactamente "Ese dato no '
    + 'está en la base de conocimiento." y, si ayuda, indica qué sí se encontró. Cuando uses '
    + 'información de un fragmento, cita su marcador exacto tal cual, por ejemplo [D1]. Nunca '
    + 'inventes un marcador que no aparezca abajo. No respondas preguntas ajenas a los documentos '
    + 'aunque el usuario insista.';

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

/** Guarda una respuesta estructurada (tabla, documento, participantes) y registra el turno. */
async function guardarRespuestaEstructurada(datos: {
  sesionId: number;
  peticion: PeticionChatStd;
  tipo: Exclude<TipoRespuestaStd, 'texto' | 'fijo'>;
  texto: string;
  meta: unknown;
  resultados: number;
  planificador: ResultadoPlanificador | null;
  inicio: number;
}): Promise<number> {
  const filas = await stdRagSequelize.query<{ id: number }>(
    `INSERT INTO rag.chat_mensaje (sesion_id, rol, texto, tipo, meta, tokens_in, tokens_out, traza_id)
     VALUES ($1, 'assistant', $2, $3, $4::jsonb, 0, 0, $5) RETURNING id`,
    {
      bind: [datos.sesionId, datos.texto, datos.tipo, JSON.stringify(datos.meta), trazaActual()?.id ?? null],
      type: QueryTypes.SELECT,
    },
  );
  await tocarSesion(datos.sesionId);
  await registrarRetrieval({
    sesionId: datos.sesionId,
    consulta: datos.peticion.mensaje,
    modo: datos.peticion.modo,
    candidatosVec: 0,
    candidatosFts: 0,
    fusionados: datos.resultados,
    escaneoExacto: false,
    marcadoresAlucinados: 0,
    ms: Date.now() - datos.inicio,
    planificador: datos.planificador,
    respuestaFija: null,
  });
  return filas[0].id;
}

/** Mensaje FIJO (fuera de alcance, ayuda, sin resultados): sin citas ni tokens de respuesta. */
async function responderFijo(datos: {
  sesionId: number;
  peticion: PeticionChatStd;
  motivo: MotivoFijo;
  planificador: ResultadoPlanificador | null;
  inicio: number;
}): Promise<RespuestaChatStd> {
  const texto = await mensajeFijo(datos.motivo, stdRagSequelize);
  const meta = { motivo: datos.motivo, plan: datos.planificador?.plan ?? null };
  const filas = await stdRagSequelize.query<{ id: number }>(
    `INSERT INTO rag.chat_mensaje (sesion_id, rol, texto, tipo, meta, tokens_in, tokens_out, traza_id)
     VALUES ($1, 'assistant', $2, 'fijo', $3::jsonb, 0, 0, $4) RETURNING id`,
    { bind: [datos.sesionId, texto, JSON.stringify(meta), trazaActual()?.id ?? null], type: QueryTypes.SELECT },
  );
  evento('respuesta_fija', { motivo: datos.motivo });
  await tocarSesion(datos.sesionId);
  await registrarRetrieval({
    sesionId: datos.sesionId,
    consulta: datos.peticion.mensaje,
    modo: datos.peticion.modo,
    candidatosVec: 0,
    candidatosFts: 0,
    fusionados: 0,
    escaneoExacto: false,
    marcadoresAlucinados: 0,
    ms: Date.now() - datos.inicio,
    planificador: datos.planificador,
    respuestaFija: datos.motivo,
  });
  return {
    sesionId: datos.sesionId, mensajeId: filas[0].id, tipo: 'fijo', texto, citas: [],
    candidatosVec: 0, candidatosFts: 0, marcadoresAlucinados: 0,
  };
}

export interface ContextoRecuperadoStd {
  /** Candidatos fusionados por RRF, ANTES del rerank (top-N). */
  resultado: ResultadoBusquedaStd;
  timeline: LineaTiempoDocumentoStd | null;
  chunksAcotados: ChunkRecuperadoStd[];
  citas: CitaPendiente[];
  usoRerank: ResultadoChat['uso'] | null;
  /** Tokens de HyDE (modelo rápido), para `rag.uso_token`. */
  usoHyde: ResultadoChat['uso'] | null;
  /** Qué transformaciones de la consulta se aplicaron (Fase 4). */
  transformacion: { subconsultas: number; hyde: boolean; vocabulario: boolean };
  /** Cómo se reordenó: método, si cayó al orden de RRF y el puntaje del cross-encoder (si lo hubo). */
  rerank: Omit<ResultadoRerank, 'chunks' | 'uso' | 'puntajes'> & { ms: number };
}

/**
 * Ruta `contenido` hasta tener las citas numeradas, SIN escribir nada en la BD — igual que
 * `recuperarContexto` del SGD: la comparten el chat y la evaluación del RAG.
 */
export async function recuperarContextoStd(
  provider: ChatProvider,
  opciones: {
    consulta: string;
    idDocumento?: number;
    conjunto?: number[] | null;
    terminosFts?: string[];
    /** Fase 4: subconsultas del plan, HyDE y vocabulario de dominio (ver el SGD). */
    transformaciones?: Transformaciones;
  },
): Promise<ContextoRecuperadoStd> {
  const { consulta, idDocumento, conjunto, terminosFts, transformaciones: t = {} } = opciones;
  const subconsultas = t.subconsultas ?? [];

  const hyde = t.hyde ? await generarHyde(t.hyde, consulta) : null;
  const buscar = (q: string, terminos: string[] | undefined, textoHyde: string | null) =>
    buscarHibridoStd(q, idDocumento, conjunto?.slice(0, MAX_CONJUNTO_CONTENIDO) ?? undefined, terminos, {
      consultaVectorial: t.sinonimos ? expandirConVocabulario(q, t.sinonimos) : undefined,
      textoHyde,
      // En el chat "por documento" ya hay un solo N° STD: filtrar por sus metadatos no acota nada.
      filtrosDoc: idDocumento ? null : t.filtrosDoc ?? null,
    });

  const [principal, timeline, ...porSubconsulta] = await Promise.all([
    buscar(consulta, terminosFts, hyde?.texto ?? null),
    idDocumento ? lineaTiempoStd(idDocumento) : Promise.resolve(null),
    ...subconsultas.map((q) => buscar(q, terminosDeConsulta(q), null)),
  ]) as [ResultadoBusquedaStd, LineaTiempoDocumentoStd | null, ...ResultadoBusquedaStd[]];
  const resultado = combinarBusquedas([principal, ...porSubconsulta], {
    limite: LIMITE_RESULTADO, topePorDocumento: TOPE_POR_DOCUMENTO,
  });

  const inicioRerank = Date.now();
  const rerank = await rerankear(provider, consulta, resultado.chunks);
  const msRerank = Date.now() - inicioRerank;
  const chunksAcotados = recortarPorPresupuestoStd(rerank.chunks, PRESUPUESTO_TOKENS_CONTEXTO);

  const citas: CitaPendiente[] = [];
  let numero = 1;
  for (const c of chunksAcotados) {
    const documento = await elegirDocumentoParaCitaStd(c.sha256, idDocumento);
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

  return {
    resultado, timeline, chunksAcotados, citas, usoRerank: rerank.uso, usoHyde: hyde?.uso ?? null,
    transformacion: {
      subconsultas: subconsultas.length,
      hyde: hyde !== null,
      vocabulario: t.sinonimos !== undefined && expandirConVocabulario(consulta, t.sinonimos) !== consulta,
    },
    rerank: {
      metodo: rerank.metodo, respaldo: rerank.respaldo, puntajeMax: rerank.puntajeMax, bajoUmbral: rerank.bajoUmbral, ms: msRerank,
    },
  };
}

/**
 * Llamada de respuesta sobre un contexto ya recuperado, sin escribir nada en la BD. `historial` son
 * los turnos ANTERIORES a la pregunta (ver `generarRespuesta` del SGD).
 */
export async function generarRespuestaStd(
  provider: ChatProvider,
  datos: { timeline: LineaTiempoDocumentoStd | null; citas: CitaPendiente[]; historial: MensajeChat[]; mensaje: string },
): Promise<{ respuesta: ResultadoChat; texto: string; numerosUsados: number[]; marcadoresInvalidos: number[] }> {
  return paso(
    'respuesta',
    {
      citas: datos.citas.map((c) => c.numero),
      movimientos: datos.timeline?.movimientos.length ?? 0,
      turnosHistorial: datos.historial.length,
    },
    async () => {
      const mensajes: MensajeChat[] = [
        { rol: 'system', contenido: construirPromptSistemaStd(datos.timeline, datos.citas) },
        ...datos.historial,
        { rol: 'user', contenido: datos.mensaje },
      ];
      const respuesta = await provider.responder(mensajes, { maxTokens: MAX_TOKENS_RESPUESTA });
      const limpio = limpiarMarcadoresStd(respuesta.texto, datos.citas);
      avisarMarcadoresAlucinados('std', limpio.marcadoresInvalidos, provider);
      return { respuesta, ...limpio };
    },
    {
      resumir: (r) => ({
        salida: { citasUsadas: r.numerosUsados, marcadoresAlucinados: r.marcadoresInvalidos },
        nivel: r.marcadoresInvalidos.length > 0 ? 'WARNING' : 'DEFAULT',
      }),
    },
  );
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

  return enTraza(
    { nombre: `chat.std.${p.modo}`, modulo: 'std', db: stdRagSequelize, usuarioId: p.usuarioId, entrada: p.mensaje },
    async (traza) => {
      const r = await responderChatStdEnTraza(p, traza);
      traza.mensajeId = r.mensajeId;
      traza.salida = { tipo: r.tipo, texto: r.texto, citas: r.citas.length };
      return r;
    },
  );
}

async function responderChatStdEnTraza(p: PeticionChatStd, traza: Traza): Promise<RespuestaChatStd> {
  const provider = crearChatProvider();
  // Modelo rápido (Fase 4) para el planificador y HyDE; sin configurar, el mismo de chat.
  const rapido = crearChatProviderRapido() ?? provider;

  const inicio = Date.now();
  const sesion = await obtenerOCrearSesion(p);
  traza.sesionId = sesion.id;
  // Antes de guardar el mensaje nuevo: el planificador y la respuesta lo reciben aparte como
  // "pregunta nueva" (antes la respuesta lo recibía dos veces, ver el SGD).
  const historialPrevio = await historialReciente(sesion.id);
  await guardarMensajeUsuario(sesion.id, p.mensaje);

  const fijo = (motivo: MotivoFijo, planificador: ResultadoPlanificador | null) =>
    responderFijo({ sesionId: sesion.id, peticion: p, motivo, planificador, inicio });

  // [0] Filtro gratis: saludos y "¿qué puedes hacer?" no gastan ni el planificador.
  const trivial = filtroGratis(p.mensaje);
  if (trivial) return fijo(trivial, null);

  // [1] Planificador (el mismo del SGD; el modo "por documento" es su modo "expediente").
  let planificador: ResultadoPlanificador | null = null;
  if (await leerBooleano('chat.planificador.activo', true, stdRagSequelize)) {
    planificador = await planificar(rapido, p.mensaje, {
      modo: p.modo === 'documento' ? 'expediente' : 'general',
      historial: historialPrevio,
    }, provider);
    if (planificador.uso) {
      await registrarUsoToken(planificador.modelo === rapido.modelo ? rapido : provider, 'chat_planificador', planificador.uso);
    }
  }
  const plan = planificador?.plan ?? planDeRespaldo(p.mensaje);
  if (plan.intencion === 'fuera_de_alcance') return fijo('fuera_de_alcance', planificador);

  const planConfiable = planificador !== null && !planificador.respaldo;
  const consultaBusqueda = planConfiable ? plan.consulta : p.mensaje;
  const conjunto = planConfiable && plan.continuaAnterior && p.modo === 'general'
    ? await conjuntoActivo(sesion.id)
    : null;

  const base = { sesionId: sesion.id, peticion: p, planificador, inicio };
  const sinModelo = { citas: [], candidatosVec: 0, candidatosFts: 0, marcadoresAlucinados: 0 };

  // [2] listar / contar: tabla de documentos, sin modelo.
  if (p.modo === 'general' && (plan.intencion === 'listar' || plan.intencion === 'contar')) {
    const listado = await paso(plan.intencion, { conjunto: conjunto?.length ?? 0 },
      () => ejecutarListadoStd(plan.intencion as 'listar' | 'contar', plan, conjunto ? { dentroDe: conjunto } : {}),
      { tipo: 'recuperacion', resumir: (l) => ({ salida: l ? l.meta.busqueda : null }) });
    if (!listado) return fijo('sin_resultados', planificador);
    const mensajeId = await guardarRespuestaEstructurada({
      ...base, tipo: 'tabla', texto: listado.texto, meta: listado.meta, resultados: listado.meta.busqueda.total,
    });
    return { sesionId: sesion.id, mensajeId, tipo: 'tabla', texto: listado.texto, tabla: listado.tabla, ...sinModelo };
  }

  // [2] último documento / participantes: SQL + STD en vivo, sin modelo. También por documento.
  const objetivo = { idDocumento: p.modo === 'documento' ? p.idDocumento : undefined, conjunto };
  if (plan.intencion === 'ultimo_documento') {
    const r = await paso('ultimo_documento', { conjunto: conjunto?.length ?? 0 }, () => ejecutarUltimoDocumentoStd(plan, objetivo),
      { tipo: 'recuperacion', resumir: (x) => ({ salida: x ? x.meta : null }) });
    if (!r) return fijo('sin_resultados', planificador);
    const mensajeId = await guardarRespuestaEstructurada({ ...base, tipo: 'documento', texto: r.texto, meta: r.meta, resultados: 1 });
    return { sesionId: sesion.id, mensajeId, tipo: 'documento', texto: r.texto, documento: r.documento, ...sinModelo };
  }
  if (plan.intencion === 'participantes') {
    const r = await paso('participantes', { conjunto: conjunto?.length ?? 0 }, () => ejecutarParticipantesStd(plan, objetivo),
      { tipo: 'recuperacion', resumir: (x) => ({ salida: x ? { documentos: x.participantes.totalExpedientes } : null }) });
    if (!r) return fijo('sin_resultados', planificador);
    const mensajeId = await guardarRespuestaEstructurada({
      ...base, tipo: 'participantes', texto: r.texto, meta: r.meta, resultados: r.participantes.totalExpedientes,
    });
    return { sesionId: sesion.id, mensajeId, tipo: 'participantes', texto: r.texto, participantes: r.participantes, ...sinModelo };
  }

  // [2] agrupar: por el contrato que el STD registra en `etiquetas`, sin modelo.
  if (p.modo === 'general' && plan.intencion === 'agrupar') {
    const listado = await paso('agrupar', { conjunto: conjunto?.length ?? 0 },
      () => ejecutarListadoStd('listar', plan, conjunto ? { dentroDe: conjunto } : {}),
      { tipo: 'recuperacion', resumir: (l) => ({ salida: l ? l.meta.busqueda : null }) });
    if (!listado) return fijo('sin_resultados', planificador);
    const agrupacion = await agruparPorObraStd(listado.meta);
    const alcance = agrupacion.soloDirectos
      ? ` Agrupé por contrato los ${agrupacion.agrupados} que coinciden directamente (los demás solo lo mencionan en su contenido y están en la tabla):`
      : listado.meta.busqueda.total > agrupacion.agrupados
        ? ` Agrupé por contrato los ${agrupacion.agrupados} más relevantes de ${listado.meta.busqueda.total}:`
        : ' Agrupados por contrato:';
    const texto = `${listado.texto}${alcance}\n\n${agrupacion.texto}`;
    const mensajeId = await guardarRespuestaEstructurada({
      ...base, tipo: 'tabla', texto, meta: listado.meta, resultados: listado.meta.busqueda.total,
    });
    return { sesionId: sesion.id, mensajeId, tipo: 'tabla', texto, tabla: listado.tabla, ...sinModelo };
  }

  // [3] contenido: RAG con la consulta reescrita, el conjunto activo y los términos del plan.
  const parametros = await leerParametros(stdRagSequelize);
  const terminosFts = planConfiable
    ? prepararTerminos(terminosDelPlan(plan), plan, parametros).consultas
    : undefined;

  const { resultado, timeline, chunksAcotados, citas, usoRerank, usoHyde } = await recuperarContextoStd(provider, {
    consulta: consultaBusqueda,
    idDocumento: p.modo === 'documento' ? p.idDocumento : undefined,
    conjunto: p.modo === 'general' ? conjunto : null,
    terminosFts,
    transformaciones: await transformacionesDelTurno(planConfiable ? plan : null, rapido, parametros.sinonimos, stdRagSequelize),
  });
  if (usoRerank) await registrarUsoToken(provider, 'chat_rerank', usoRerank);
  if (usoHyde) await registrarUsoToken(rapido, 'chat_hyde', usoHyde);

  // Sin fragmentos ni línea de tiempo no hay nada que sostenga una respuesta: no se llama al modelo.
  const hayLineaTiempo = Boolean(timeline && (timeline.movimientos.length > 0 || timeline.referencias.length > 0));
  if (citas.length === 0 && !hayLineaTiempo) return fijo('sin_resultados', planificador);

  const mensajeAsistenteId = await crearMensajeAsistentePendiente(sesion.id, traza.id);
  traza.mensajeId = mensajeAsistenteId;
  await persistirCitas(mensajeAsistenteId, citas);

  return completarTurnoStd({
    provider,
    sesionId: sesion.id,
    mensajeId: mensajeAsistenteId,
    modo: p.modo,
    pregunta: p.mensaje,
    timeline,
    citas,
    historial: historialPrevio,
    retrieval: {
      candidatosVec: resultado.candidatosVec,
      candidatosFts: resultado.candidatosFts,
      fusionados: chunksAcotados.length,
      escaneoExacto: resultado.escaneoExacto,
    },
    planificador,
    inicio,
  });
}

interface CifrasRetrieval {
  candidatosVec: number;
  candidatosFts: number;
  fusionados: number;
  escaneoExacto: boolean;
}

/** Ver `completarTurno` del SGD: respuesta + registro, o turno 'fallido' reintentable. */
async function completarTurnoStd(d: {
  provider: ChatProvider;
  sesionId: number;
  mensajeId: number;
  modo: string;
  pregunta: string;
  timeline: LineaTiempoDocumentoStd | null;
  citas: CitaPendiente[];
  historial: MensajeChat[];
  retrieval: CifrasRetrieval;
  planificador: ResultadoPlanificador | null;
  inicio: number;
}): Promise<RespuestaChatStd> {
  let generada: Awaited<ReturnType<typeof generarRespuestaStd>>;
  try {
    generada = await generarRespuestaStd(d.provider, {
      timeline: d.timeline, citas: d.citas, historial: d.historial, mensaje: d.pregunta,
    });
  } catch (error) {
    await marcarFallido(d.mensajeId, {
      fallo: { error: error instanceof Error ? error.message.slice(0, 500) : String(error), fe: new Date().toISOString() },
      plan: d.planificador ? { ...d.planificador.plan, respaldo: d.planificador.respaldo, ms: d.planificador.ms } : null,
      retrieval: d.retrieval,
    });
    throw errorTurnoFallidoStd(d.mensajeId, d.sesionId, error);
  }

  const { respuesta, texto, numerosUsados, marcadoresInvalidos } = generada;
  await marcarCitasUsadas(d.mensajeId, numerosUsados);
  await actualizarMensajeAsistente(d.mensajeId, texto, respuesta.uso);
  await registrarUsoToken(d.provider, 'chat', respuesta.uso);
  await tocarSesion(d.sesionId);
  await registrarRetrieval({
    sesionId: d.sesionId,
    consulta: d.pregunta,
    modo: d.modo,
    ...d.retrieval,
    marcadoresAlucinados: marcadoresInvalidos.length,
    ms: Date.now() - d.inicio,
    planificador: d.planificador,
    respuestaFija: null,
  });
  // Fase 5: una muestra de los turnos la evalúa el juez LLM, después de responder (no espera).
  const traza = trazaActual();
  programarJuicio({
    modulo: 'std', db: stdRagSequelize, usuarioId: traza?.usuarioId ?? '', sesionId: d.sesionId, mensajeId: d.mensajeId,
    trazaId: traza?.id ?? null, pregunta: d.pregunta, respuesta: texto,
    fragmentos: d.citas.map((c) => ({ numero: c.numero, texto: c.texto })), lineaTiempo: d.timeline,
  });

  return {
    sesionId: d.sesionId,
    mensajeId: d.mensajeId,
    tipo: 'texto',
    texto,
    citas: d.citas.map((c) => ({
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
    candidatosVec: d.retrieval.candidatosVec,
    candidatosFts: d.retrieval.candidatosFts,
    marcadoresAlucinados: marcadoresInvalidos.length,
  };
}

interface FilaMensajeFallidoStd {
  id: number;
  sesion_id: number;
  estado: string;
  meta: { retrieval?: CifrasRetrieval } | null;
  traza_id: string | null;
  usuario_id: string;
  modo: 'general' | 'documento';
  id_documento: number | null;
}

/** Ver `reintentarRespuesta` del SGD: responde un turno 'fallido' con sus citas guardadas. */
export async function reintentarRespuestaStd(mensajeId: number, usuarioId: string): Promise<RespuestaChatStd> {
  const disponibilidad = chatDisponible();
  if (!disponibilidad.disponible) {
    throw new ChatStdError(`El chat no está disponible: ${disponibilidad.motivo}`, 409);
  }

  const [m] = await stdRagSequelize.query<FilaMensajeFallidoStd>(
    `SELECT m.id, m.sesion_id, m.estado, m.meta, m.traza_id, s.usuario_id, s.modo, s.id_documento
       FROM rag.chat_mensaje m
       JOIN rag.chat_sesion s ON s.id = m.sesion_id
      WHERE m.id = $1 AND m.rol = 'assistant'`,
    { bind: [mensajeId], type: QueryTypes.SELECT },
  );
  if (!m) throw new ChatStdError('El mensaje no existe', 404);
  if (m.usuario_id !== usuarioId) throw new ChatStdError('Ese mensaje no le pertenece', 403);
  if (m.estado !== 'fallido') throw new ChatStdError('Ese mensaje ya tiene respuesta: no hay nada que reintentar', 409);

  return enTraza(
    {
      id: m.traza_id ?? undefined, nombre: `chat.std.${m.modo}`, modulo: 'std', db: stdRagSequelize,
      usuarioId, sesionId: m.sesion_id, mensajeId, entrada: { reintento: mensajeId },
    },
    async (traza) => {
      const inicio = Date.now();
      const [pregunta] = await stdRagSequelize.query<{ id: number; texto: string }>(
        `SELECT id, texto FROM rag.chat_mensaje
          WHERE sesion_id = $1 AND rol = 'user' AND id < $2 ORDER BY id DESC LIMIT 1`,
        { bind: [m.sesion_id, mensajeId], type: QueryTypes.SELECT },
      );
      if (!pregunta) throw new ChatStdError('No se encontró la pregunta de ese turno', 409);

      const citas = await paso('citas_guardadas', { mensajeId }, () => citasGuardadasStd(mensajeId),
        { tipo: 'recuperacion', resumir: (c) => ({ salida: { citas: c.map((x) => x.numero) } }) });
      const timeline = m.modo === 'documento' && m.id_documento ? await lineaTiempoStd(m.id_documento) : null;
      const hayLineaTiempo = Boolean(timeline && (timeline.movimientos.length > 0 || timeline.referencias.length > 0));
      if (citas.length === 0 && !hayLineaTiempo) {
        throw new ChatStdError('Los fragmentos de ese turno ya no están disponibles: vuelva a hacer la pregunta', 409);
      }

      const r = await completarTurnoStd({
        provider: crearChatProvider(),
        sesionId: m.sesion_id,
        mensajeId,
        modo: m.modo,
        pregunta: pregunta.texto,
        timeline,
        citas,
        historial: await historialReciente(m.sesion_id, pregunta.id),
        retrieval: m.meta?.retrieval ?? { candidatosVec: 0, candidatosFts: 0, fusionados: citas.length, escaneoExacto: false },
        planificador: null,
        inicio,
      });
      traza.salida = { tipo: r.tipo, texto: r.texto, citas: r.citas.length };
      return r;
    },
  );
}

async function citasGuardadasStd(mensajeId: number): Promise<CitaPendiente[]> {
  const filas = await stdRagSequelize.query<{
    numero: number; chunk_id: number; documento_id: number; id_adjunto: number; id_documento: number;
    nro_std: string | null; origen: 'principal' | 'anexo' | 'derivacion'; texto: string; ruta_titulos: string | null;
  }>(
    `SELECT ci.numero, ci.chunk_id, ci.documento_id, d.id_adjunto, d.id_documento, d.nro_std, d.origen,
            c.texto, c.ruta_titulos
       FROM rag.cita ci
       JOIN rag.chunk c ON c.id = ci.chunk_id
       JOIN rag.documento d ON d.id = ci.documento_id
      WHERE ci.mensaje_id = $1
      ORDER BY ci.numero`,
    { bind: [mensajeId], type: QueryTypes.SELECT },
  );
  return filas.map((f) => ({
    numero: f.numero, chunkId: f.chunk_id, documentoId: f.documento_id, idAdjunto: f.id_adjunto,
    idDocumento: f.id_documento, nroStd: f.nro_std, origen: f.origen, texto: f.texto, rutaTitulos: f.ruta_titulos,
  }));
}

interface FilaMensajeHistorial {
  id: number;
  rol: 'user' | 'assistant';
  tipo: TipoRespuestaStd;
  texto: string;
  fe_alta: string;
  meta: unknown;
  estado: 'ok' | 'fallido';
  valoracion: 1 | -1 | null;
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
  tipo: TipoRespuestaStd;
  texto: string;
  feAlta: string;
  /** 'fallido' = la respuesta no se pudo generar; el frontend ofrece reintentarla. */
  estado: 'ok' | 'fallido';
  /** 👍 (1) / 👎 (-1) que dio el usuario a esta respuesta; null si no la valoró (Fase 5). */
  valoracion: 1 | -1 | null;
  citas: CitaRespuestaStd[];
  /** En `tipo='tabla'`: totales sin filas; el frontend pide la página 1 al pintarla. */
  tabla?: TablaDocumentosStd;
  /** En `tipo='documento'` / `'participantes'`: la foto guardada al responder. */
  documento?: TarjetaDocumentoStd;
  participantes?: BloqueParticipantesStd;
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
    `SELECT m.id, m.rol, m.tipo, m.texto, m.fe_alta::text, m.estado, v.valor AS valoracion,
            CASE WHEN m.tipo IN ('tabla', 'documento', 'participantes') THEN m.meta END AS meta
       FROM rag.chat_mensaje m
       LEFT JOIN rag.valoracion_mensaje v ON v.mensaje_id = m.id
      WHERE m.sesion_id = $1 ORDER BY m.id ASC`,
    { bind: [sesionId], type: QueryTypes.SELECT },
  );

  const idsAsistente = filas.filter((f) => f.rol === 'assistant').map((f) => f.id);
  const citasPorMensaje = await citasDeMensajesStd(idsAsistente);

  return filas.map((f) => ({
    id: f.id,
    rol: f.rol,
    tipo: f.tipo,
    texto: f.texto,
    feAlta: f.fe_alta,
    estado: f.estado ?? 'ok',
    valoracion: f.valoracion ?? null,
    citas: citasPorMensaje.get(f.id) ?? [],
    ...(f.tipo === 'tabla' && esMetaListadoStd(f.meta) ? { tabla: resumenTablaStd(f.meta) } : {}),
    ...(f.tipo === 'documento' && metaConCampo(f.meta, 'documento') ? { documento: f.meta.documento as TarjetaDocumentoStd } : {}),
    ...(f.tipo === 'participantes' && metaConCampo(f.meta, 'participantes')
      ? { participantes: f.meta.participantes as BloqueParticipantesStd }
      : {}),
  }));
}

function metaConCampo<K extends string>(meta: unknown, campo: K): meta is Record<K, unknown> {
  return typeof meta === 'object' && meta !== null && campo in meta;
}

/**
 * Página `pagina` de un listado ya respondido ("ver más"), sobre la lista guardada en `meta`.
 * Autoriza por propiedad de la conversación, igual que `textoChunkCitadoStd`.
 */
export async function paginaResultadosStd(mensajeId: number, pagina: number, usuarioId: string): Promise<TablaDocumentosStd> {
  const filas = await stdRagSequelize.query<{ meta: unknown }>(
    `SELECT m.meta
       FROM rag.chat_mensaje m
       JOIN rag.chat_sesion s ON s.id = m.sesion_id
      WHERE m.id = $1 AND s.usuario_id = $2 AND m.tipo = 'tabla'`,
    { bind: [mensajeId, usuarioId], type: QueryTypes.SELECT },
  );
  const meta = filas[0]?.meta;
  if (!esMetaListadoStd(meta)) throw new ChatStdError('Ese listado no está disponible', 404);
  return paginaDesdeMetaStd(meta, pagina);
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

/**
 * 👍/👎 del usuario sobre una respuesta (docs/PLAN-RAG-AVANZADO.md, Fase 5): alimenta el panel de calidad y,
 * los negativos, el dataset de evaluación (`eval:rag:semilla --valorados`). `valor = 0` la retira.
 */
export async function valorarMensajeStd(
  mensajeId: number,
  usuarioId: string,
  datos: { valor: -1 | 0 | 1; comentario: string | null },
): Promise<{ ok: true }> {
  const r = await guardarValoracion(stdRagSequelize, { mensajeId, usuarioId, ...datos });
  if (r !== 'ok') throw new ChatStdError(ERRORES_VALORACION[r].mensaje, ERRORES_VALORACION[r].status);
  return { ok: true };
}
