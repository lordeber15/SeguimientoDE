import { QueryTypes } from 'sequelize';
import { appSequelize } from '../../../compartido/config/appDatabase';
import { chatDisponible, crearChatProvider, crearChatProviderRapido } from '../../../compartido/ai/providerFactory';
import type { ChatProvider, MensajeChat, ResultadoChat } from '../../../compartido/ai/types';
import { filtroGratis, mensajeFijo, type MotivoFijo } from '../../../compartido/rag/cierreChat';
import { leerBooleano } from '../../../compartido/rag/configService';
import { planDeRespaldo, planificar, type ResultadoPlanificador } from '../../../compartido/rag/planificadorService';
import { programarJuicio } from '../../../compartido/rag/juezService';
import { ERRORES_VALORACION, guardarValoracion } from '../../../compartido/rag/valoracionService';
import { rerankear, type ResultadoRerank } from '../../../compartido/rag/rerankService';
import { terminosDeConsulta } from '../../../compartido/rag/busquedaTerminos';
import {
  combinarBusquedas,
  expandirConVocabulario,
  generarHyde,
  transformacionesDelTurno,
  type Transformaciones,
} from '../../../compartido/rag/transformacionConsulta';
import { avisarMarcadoresAlucinados } from '../../../compartido/observabilidad/alertas';
import { enTraza, evento, paso, trazaActual, type Traza } from '../../../compartido/observabilidad/traza';
import { leerParametros, prepararTerminos, terminosDelPlan } from './busquedaExpedientesService';
import {
  ejecutarParticipantes,
  ejecutarUltimoDocumento,
  agruparPorObra,
  type BloqueParticipantes,
  type TarjetaDocumento,
} from './respuestasEstructuradasService';
import {
  ejecutarListado,
  esMetaListado,
  paginaDesdeMeta,
  resumenTabla,
  type TablaExpedientes,
} from './listadoChatService';
import {
  buscarHibrido,
  elegirDocumentoParaCita,
  estadoExpediente,
  LIMITE_RESULTADO,
  recortarPorPresupuesto,
  TOPE_POR_DOCUMENTO,
  type FiltroAcceso,
  type LineaTiempo,
  type ChunkRecuperado,
  type ResultadoBusqueda,
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
/**
 * Tope por respuesta previa del asistente al reenviarla como historial: una respuesta con citas
 * ronda los 800 tokens y 8 de ellas multiplicaban el costo de cada turno en un chat largo. Para
 * seguir el hilo basta el comienzo (la tesis de la respuesta); el detalle sigue en los fragmentos.
 */
const MAX_CHARS_HISTORIAL_ASISTENTE = 700;
/** Tope del conjunto activo al acotar la búsqueda de contenido (un IN de miles no aporta foco). */
const MAX_CONJUNTO_CONTENIDO = 300;

export class ChatError extends Error {
  readonly status: number;
  /** Viaja en el cuerpo de la respuesta de error (p. ej. `mensajeFallidoId` para ofrecer "Reintentar"). */
  readonly datos?: Record<string, unknown>;
  constructor(mensaje: string, status = 400, datos?: Record<string, unknown>) {
    super(mensaje);
    this.name = 'ChatError';
    this.status = status;
    this.datos = datos;
  }
}

/** La llamada de respuesta falló: el turno queda guardado como 'fallido' y se puede reintentar. */
export function errorTurnoFallido(mensajeId: number, sesionId: number, causa: unknown): ChatError {
  const detalle = causa instanceof Error ? causa.message : String(causa);
  return new ChatError(
    'El modelo no pudo generar la respuesta. La búsqueda quedó guardada: puede reintentar sin volver a escribir la pregunta.',
    502,
    // Number(): los ids bigserial llegan como string desde pg.
    { mensajeFallidoId: Number(mensajeId), sesionId: Number(sesionId), reintentable: true, detalle: detalle.slice(0, 300) },
  );
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

/**
 * 'fijo' = mensaje de cierre sin LLM (ver `compartido/rag/cierreChat.ts`); 'tabla' = listado de
 * expedientes (ver `listadoChatService.ts`); 'documento' / 'participantes' = respuestas
 * estructuradas sin LLM (ver `respuestasEstructuradasService.ts`).
 */
export type TipoRespuesta = 'texto' | 'tabla' | 'fijo' | 'documento' | 'participantes';

export interface RespuestaChat {
  sesionId: number;
  mensajeId: number;
  tipo: TipoRespuesta;
  texto: string;
  citas: CitaRespuesta[];
  /** Solo en `tipo='tabla'`: la primera página. Las siguientes, con `paginaResultados`. */
  tabla?: TablaExpedientes;
  /** Solo en `tipo='documento'`. */
  documento?: TarjetaDocumento;
  /** Solo en `tipo='participantes'`. */
  participantes?: BloqueParticipantes;
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

async function crearMensajeAsistentePendiente(sesionId: number, trazaId: string | null): Promise<number> {
  const filas = await appSequelize.query<{ id: number }>(
    `INSERT INTO rag.chat_mensaje (sesion_id, rol, texto, traza_id) VALUES ($1, 'assistant', '', $2) RETURNING id`,
    { bind: [sesionId, trazaId], type: QueryTypes.SELECT },
  );
  return filas[0].id;
}

/**
 * La llamada de respuesta falló: el mensaje queda 'fallido' CON sus citas (antes se borraba y se
 * perdía todo lo calculado). `meta` guarda lo necesario para reintentar y auditar: el plan y las
 * cifras del retrieval; las citas ya están en `rag.cita`.
 */
async function marcarFallido(mensajeId: number, meta: Record<string, unknown>): Promise<void> {
  await appSequelize.query(
    `UPDATE rag.chat_mensaje SET estado = 'fallido', meta = $2::jsonb WHERE id = $1`,
    { bind: [mensajeId, JSON.stringify(meta)], type: QueryTypes.UPDATE },
  );
}

async function actualizarMensajeAsistente(
  mensajeId: number,
  texto: string,
  uso: { tokensIn: number; tokensOut: number },
): Promise<void> {
  await appSequelize.query(
    `UPDATE rag.chat_mensaje SET texto = $2, tokens_in = $3, tokens_out = $4, estado = 'ok' WHERE id = $1`,
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

/**
 * Turnos previos de la sesión, del más viejo al más nuevo. `antesDe` = solo los anteriores a ese
 * mensaje (el reintento de un turno viejo no debe ver lo que vino después). Los turnos fallidos no
 * cuentan: no tienen respuesta.
 */
async function historialReciente(sesionId: number, antesDe: number | null = null): Promise<MensajeChat[]> {
  const filas = await appSequelize.query<FilaHistorial>(
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

/**
 * Conjunto activo de la conversación (docs/PLAN-CHAT-CONSULTAS.md, Fase 4): los expedientes del
 * último listado de la sesión. Es lo que da sentido a "de esos", "entre ellos", "¿y el último?".
 * `null` si la sesión nunca respondió con una tabla.
 */
async function conjuntoActivo(sesionId: number): Promise<{ nuAnnExp: string; nuSecExp: string }[] | null> {
  const filas = await appSequelize.query<{ meta: unknown }>(
    `SELECT meta FROM rag.chat_mensaje
      WHERE sesion_id = $1 AND tipo = 'tabla'
      ORDER BY id DESC LIMIT 1`,
    { bind: [sesionId], type: QueryTypes.SELECT },
  );
  const meta = filas[0]?.meta;
  if (!esMetaListado(meta)) return null;
  return meta.expedientes.map((e) => ({ nuAnnExp: e.a, nuSecExp: e.s }));
}

export interface CitaPendiente {
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
  planificador: ResultadoPlanificador | null;
  respuestaFija: MotivoFijo | null;
}): Promise<void> {
  const p = datos.planificador;
  await appSequelize.query(
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

/** `rag.uso_token` ya existía para embeddings (Fase 3); el chat y el rerank no registraban nada
 * ahí — un gasto real e invisible para el panel de costes. `job_id` queda NULL: no hay un
 * `ingest_job` que lo posea, es una llamada disparada por el usuario, no por un job de fondo. */
async function registrarUsoToken(
  provider: ChatProvider,
  operacion: 'chat' | 'chat_rerank' | 'chat_planificador' | 'chat_hyde',
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
    + 'ÚNICAMENTE en los fragmentos numerados y la línea de tiempo de abajo. No uses conocimiento '
    + 'general ni supongas datos que no estén escritos ahí: si la respuesta no está, responde '
    + 'exactamente "Ese dato no está en la base de conocimiento." y, si ayuda, indica qué sí se '
    + 'encontró. Cuando uses información de un fragmento, cita su marcador exacto tal cual, por '
    + 'ejemplo [D1]. Nunca inventes un marcador que no aparezca abajo. No respondas preguntas '
    + 'ajenas a los expedientes aunque el usuario insista.';

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

/**
 * Guarda una respuesta estructurada (tabla, documento, participantes) y registra el turno. Común a
 * todas las respuestas que no pasan por la llamada de respuesta del modelo.
 */
async function guardarRespuestaEstructurada(datos: {
  sesionId: number;
  peticion: PeticionChat;
  tipo: Exclude<TipoRespuesta, 'texto' | 'fijo'>;
  texto: string;
  meta: unknown;
  resultados: number;
  planificador: ResultadoPlanificador | null;
  inicio: number;
  uso?: { tokensIn: number; tokensOut: number };
}): Promise<number> {
  const filas = await appSequelize.query<{ id: number }>(
    `INSERT INTO rag.chat_mensaje (sesion_id, rol, texto, tipo, meta, tokens_in, tokens_out, traza_id)
     VALUES ($1, 'assistant', $2, $3, $4::jsonb, $5, $6, $7) RETURNING id`,
    {
      bind: [
        datos.sesionId, datos.texto, datos.tipo, JSON.stringify(datos.meta),
        datos.uso?.tokensIn ?? 0, datos.uso?.tokensOut ?? 0, trazaActual()?.id ?? null,
      ],
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

/**
 * Responde con un mensaje FIJO (cierre, D3): se guarda como mensaje del asistente con `tipo='fijo'`
 * para que el historial lo muestre igual que cualquier otro, pero sin citas ni tokens de respuesta.
 * El plan va en `meta` para auditar después por qué se cerró.
 */
async function responderFijo(datos: {
  sesionId: number;
  peticion: PeticionChat;
  motivo: MotivoFijo;
  planificador: ResultadoPlanificador | null;
  inicio: number;
}): Promise<RespuestaChat> {
  const texto = await mensajeFijo(datos.motivo);
  const meta = { motivo: datos.motivo, plan: datos.planificador?.plan ?? null };

  const filas = await appSequelize.query<{ id: number }>(
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
    sesionId: datos.sesionId,
    mensajeId: filas[0].id,
    tipo: 'fijo',
    texto,
    citas: [],
    candidatosVec: 0,
    candidatosFts: 0,
    marcadoresAlucinados: 0,
  };
}

export interface ContextoRecuperado {
  /** Candidatos fusionados por RRF, ANTES del rerank (top-N): la evaluación mide Hit Rate aquí también. */
  resultado: ResultadoBusqueda;
  timeline: LineaTiempo[] | null;
  /** Tras rerank y presupuesto de tokens, antes de resolver el documento de cada cita. */
  chunksAcotados: ChunkRecuperado[];
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
 * Ruta `contenido` hasta tener las citas numeradas, SIN escribir nada en la BD: la usan
 * `responderChat` y la evaluación del RAG (`src/scripts/evaluarRag.ts`), que así mide exactamente
 * el pipeline de producción y no una copia que se desincroniza.
 */
export async function recuperarContexto(
  provider: ChatProvider,
  opciones: {
    consulta: string;
    filtro: FiltroAcceso;
    expediente?: { nuAnnExp: string; nuSecExp: string };
    conjunto?: { nuAnnExp: string; nuSecExp: string }[] | null;
    /** Términos del plan (con sus sinónimos) para la rama FTS: la consulta reescrita completa es
     *  demasiado estricta para plainto_tsquery. */
    terminosFts?: string[];
    /** Fase 4: subconsultas del plan, HyDE y vocabulario de dominio. */
    transformaciones?: Transformaciones;
  },
): Promise<ContextoRecuperado> {
  const { consulta, filtro, expediente, conjunto, terminosFts, transformaciones: t = {} } = opciones;
  const subconsultas = t.subconsultas ?? [];

  // HyDE va antes de buscar (su vector entra en el RRF de la consulta completa); el resto, en paralelo.
  const hyde = t.hyde ? await generarHyde(t.hyde, consulta) : null;
  const textoHyde = hyde?.texto ?? null;
  const buscar = (q: string, terminos: string[] | undefined, hyde: string | null) => {
    const extra = {
      consultaVectorial: t.sinonimos ? expandirConVocabulario(q, t.sinonimos) : undefined,
      textoHyde: hyde,
      // Dentro de un expediente también sirven: "¿qué dice el informe de marzo?" entre sus documentos.
      filtrosDoc: t.filtrosDoc ?? null,
    };
    return expediente
      ? buscarHibrido(q, filtro, expediente, undefined, terminos, extra)
      : buscarHibrido(q, filtro, undefined, conjunto?.slice(0, MAX_CONJUNTO_CONTENIDO), terminos, extra);
  };

  const [principal, timeline, ...porSubconsulta] = await Promise.all([
    buscar(consulta, terminosFts, textoHyde),
    expediente ? estadoExpediente(expediente.nuAnnExp, expediente.nuSecExp) : Promise.resolve(null),
    // Cada subconsulta con sus propias palabras en la FTS: los términos del plan son de la pregunta entera.
    ...subconsultas.map((q) => buscar(q, terminosDeConsulta(q), null)),
  ]) as [ResultadoBusqueda, LineaTiempo[] | null, ...ResultadoBusqueda[]];
  const resultado = combinarBusquedas([principal, ...porSubconsulta], {
    limite: LIMITE_RESULTADO, topePorDocumento: TOPE_POR_DOCUMENTO,
  });

  const inicioRerank = Date.now();
  const rerank = await rerankear(provider, consulta, resultado.chunks);
  const msRerank = Date.now() - inicioRerank;
  const chunksAcotados = recortarPorPresupuesto(rerank.chunks, PRESUPUESTO_TOKENS_CONTEXTO);

  const citas: CitaPendiente[] = [];
  let numero = 1;
  for (const c of chunksAcotados) {
    // Reafirma el filtro de permisos al elegir el documento de la cita: el chunk ya vino
    // filtrado por `buscarHibrido`, pero la cita debe señalar un documento accesible en concreto.
    const documento = await elegirDocumentoParaCita(c.sha256, filtro, expediente);
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

  return {
    resultado, timeline, chunksAcotados, citas, usoRerank: rerank.uso, usoHyde: hyde?.uso ?? null,
    transformacion: {
      subconsultas: subconsultas.length,
      hyde: textoHyde !== null,
      vocabulario: t.sinonimos !== undefined && expandirConVocabulario(consulta, t.sinonimos) !== consulta,
    },
    rerank: {
      metodo: rerank.metodo, respaldo: rerank.respaldo, puntajeMax: rerank.puntajeMax, bajoUmbral: rerank.bajoUmbral, ms: msRerank,
    },
  };
}

/**
 * Llamada de respuesta sobre un contexto ya recuperado, sin escribir nada en la BD. `historial` son
 * los turnos ANTERIORES a la pregunta: la pregunta va aparte, como último mensaje `user`.
 */
export async function generarRespuesta(
  provider: ChatProvider,
  datos: { timeline: LineaTiempo[] | null; citas: CitaPendiente[]; historial: MensajeChat[]; mensaje: string },
): Promise<{ respuesta: ResultadoChat; texto: string; numerosUsados: number[]; marcadoresInvalidos: number[] }> {
  return paso(
    'respuesta',
    { citas: datos.citas.map((c) => c.numero), lineaTiempo: datos.timeline?.length ?? 0, turnosHistorial: datos.historial.length },
    async () => {
      const mensajes: MensajeChat[] = [
        { rol: 'system', contenido: construirPromptSistema(datos.timeline, datos.citas) },
        ...datos.historial,
        { rol: 'user', contenido: datos.mensaje },
      ];
      const respuesta = await provider.responder(mensajes, { maxTokens: MAX_TOKENS_RESPUESTA });
      const limpio = limpiarMarcadores(respuesta.texto, datos.citas);
      avisarMarcadoresAlucinados('sgd', limpio.marcadoresInvalidos, provider);
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

export async function responderChat(p: PeticionChat): Promise<RespuestaChat> {
  const disponibilidad = chatDisponible();
  if (!disponibilidad.disponible) {
    throw new ChatError(`El chat no está disponible: ${disponibilidad.motivo}`, 409);
  }
  if (!p.mensaje.trim()) throw new ChatError('El mensaje no puede estar vacío');

  return enTraza(
    { nombre: `chat.sgd.${p.modo}`, modulo: 'sgd', db: appSequelize, usuarioId: p.usuarioId, entrada: p.mensaje },
    async (traza) => {
      const r = await responderChatEnTraza(p, traza);
      traza.mensajeId = r.mensajeId;
      traza.salida = { tipo: r.tipo, texto: r.texto, citas: r.citas.length };
      return r;
    },
  );
}

async function responderChatEnTraza(p: PeticionChat, traza: Traza): Promise<RespuestaChat> {
  // Un solo proveedor para todo el turno (rerank + respuesta): evita instanciarlo dos veces y dos
  // configuraciones que en teoría deberían ser la misma pero, tras un cambio de `.env`, no lo son.
  const provider = crearChatProvider();
  // Modelo rápido (Fase 4) para el planificador y HyDE; sin configurar, el mismo de chat.
  const rapido = crearChatProviderRapido() ?? provider;

  const inicio = Date.now();
  const sesion = await obtenerOCrearSesion(p);
  traza.sesionId = sesion.id;
  // El historial se lee ANTES de guardar el mensaje nuevo: el planificador lo recibe aparte como
  // "pregunta nueva", y la respuesta también (la pregunta va como último mensaje `user`). Antes la
  // respuesta releía el historial ya con la pregunta guardada y la recibía DOS veces.
  const historialPrevio = await historialReciente(sesion.id);
  await guardarMensajeUsuario(sesion.id, p.mensaje);

  const fijo = (motivo: MotivoFijo, planificador: ResultadoPlanificador | null) =>
    responderFijo({ sesionId: sesion.id, peticion: p, motivo, planificador, inicio });

  // [0] Filtro gratis: saludos y "¿qué puedes hacer?" no gastan ni el planificador.
  const trivial = filtroGratis(p.mensaje);
  if (trivial) return fijo(trivial, null);

  // [1] Planificador. Con el interruptor apagado se comporta como antes de existir: todo es
  // `contenido` y no se gasta la llamada.
  let planificador: ResultadoPlanificador | null = null;
  if (await leerBooleano('chat.planificador.activo', true)) {
    planificador = await planificar(rapido, p.mensaje, { modo: p.modo, historial: historialPrevio }, provider);
    if (planificador.uso) {
      await registrarUsoToken(planificador.modelo === rapido.modelo ? rapido : provider, 'chat_planificador', planificador.uso);
    }
  }
  const plan = planificador?.plan ?? planDeRespaldo(p.mensaje);
  if (plan.intencion === 'fuera_de_alcance') return fijo('fuera_de_alcance', planificador);

  const filtro: FiltroAcceso = { coDependencia: p.sinRestriccionDependencia ? null : p.coDependencia };

  // Contexto (Fase 4). La consulta REESCRITA por el planificador ("¿y el último?" → "último documento
  // de controversia de la obra Huancavelica") es la que se busca; el texto literal no encuentra nada.
  // Si la pregunta continúa la anterior, se acota al conjunto del último listado. Con el plan de
  // respaldo no hay reescritura confiable: se busca el mensaje tal cual y sin conjunto.
  const planConfiable = planificador !== null && !planificador.respaldo;
  const consultaBusqueda = planConfiable ? plan.consulta : p.mensaje;
  const conjunto = planConfiable && plan.continuaAnterior && p.modo === 'general'
    ? await conjuntoActivo(sesion.id)
    : null;

  const base = { sesionId: sesion.id, peticion: p, planificador, inicio };
  const sinModelo = { citas: [], candidatosVec: 0, candidatosFts: 0, marcadoresAlucinados: 0 };

  // [2] listar / contar: tabla de expedientes por SQL, sin modelo de respuesta (D6). En el modo
  // "por expediente" no aplica — ya se está dentro de uno —, así que sigue a la búsqueda de contenido.
  if (p.modo === 'general' && (plan.intencion === 'listar' || plan.intencion === 'contar')) {
    const listado = await paso(plan.intencion, { conjunto: conjunto?.length ?? 0 },
      () => ejecutarListado(plan.intencion as 'listar' | 'contar', plan, filtro, conjunto ? { dentroDe: conjunto } : {}),
      { tipo: 'recuperacion', resumir: (l) => ({ salida: l ? l.meta.busqueda : null }) });
    if (!listado) return fijo('sin_resultados', planificador);

    const mensajeId = await guardarRespuestaEstructurada({
      ...base, tipo: 'tabla', texto: listado.texto, meta: listado.meta, resultados: listado.meta.busqueda.total,
    });
    return { sesionId: sesion.id, mensajeId, tipo: 'tabla', texto: listado.texto, tabla: listado.tabla, ...sinModelo };
  }

  // [2] último documento / participantes: SQL + SGD en vivo, sin modelo (Fase 5). También en el modo
  // "por expediente", donde operan sobre ese expediente.
  const objetivo = {
    expediente: p.modo === 'expediente' ? p.expediente : undefined,
    conjunto,
  };
  if (plan.intencion === 'ultimo_documento') {
    const r = await paso('ultimo_documento', { conjunto: conjunto?.length ?? 0 }, () => ejecutarUltimoDocumento(plan, filtro, objetivo),
      { tipo: 'recuperacion', resumir: (x) => ({ salida: x ? x.meta : null }) });
    if (!r) return fijo('sin_resultados', planificador);
    const mensajeId = await guardarRespuestaEstructurada({ ...base, tipo: 'documento', texto: r.texto, meta: r.meta, resultados: 1 });
    return { sesionId: sesion.id, mensajeId, tipo: 'documento', texto: r.texto, documento: r.documento, ...sinModelo };
  }
  if (plan.intencion === 'participantes') {
    const r = await paso('participantes', { conjunto: conjunto?.length ?? 0 }, () => ejecutarParticipantes(plan, filtro, objetivo),
      { tipo: 'recuperacion', resumir: (x) => ({ salida: x ? { expedientes: x.participantes.totalExpedientes } : null }) });
    if (!r) return fijo('sin_resultados', planificador);
    const mensajeId = await guardarRespuestaEstructurada({
      ...base, tipo: 'participantes', texto: r.texto, meta: r.meta, resultados: r.participantes.totalExpedientes,
    });
    return { sesionId: sesion.id, mensajeId, tipo: 'participantes', texto: r.texto, participantes: r.participantes, ...sinModelo };
  }

  // [2] agrupar: el listado da los expedientes y se agrupan por el contrato que más citan (con el
  // nombre de su proyecto), sin modelo — ver `agruparPorContrato`. Se responde como tabla para que
  // cada grupo sea verificable abajo.
  if (p.modo === 'general' && plan.intencion === 'agrupar') {
    const listado = await paso('agrupar', { conjunto: conjunto?.length ?? 0 },
      () => ejecutarListado('listar', plan, filtro, conjunto ? { dentroDe: conjunto } : {}),
      { tipo: 'recuperacion', resumir: (l) => ({ salida: l ? l.meta.busqueda : null }) });
    if (!listado) return fijo('sin_resultados', planificador);

    const agrupacion = await agruparPorObra(listado.meta, filtro);
    const alcance = agrupacion.soloDirectos
      ? ` Agrupé por obra los ${agrupacion.agrupados} que coinciden directamente (los demás solo lo mencionan en su contenido y están en la tabla):`
      : listado.meta.busqueda.total > agrupacion.agrupados
        ? ` Agrupé por obra los ${agrupacion.agrupados} más relevantes de ${listado.meta.busqueda.total}:`
        : ' Agrupados por obra:';
    const texto = `${listado.texto}${alcance}\n\n${agrupacion.texto}`;
    const mensajeId = await guardarRespuestaEstructurada({
      ...base, tipo: 'tabla', texto, meta: listado.meta, resultados: listado.meta.busqueda.total,
    });
    return { sesionId: sesion.id, mensajeId, tipo: 'tabla', texto, tabla: listado.tabla, ...sinModelo };
  }

  const parametros = await leerParametros();
  const terminosFts = planConfiable
    ? prepararTerminos(terminosDelPlan(plan), plan, parametros).consultas
    : undefined;

  const { resultado, timeline, chunksAcotados, citas, usoRerank, usoHyde } = await recuperarContexto(provider, {
    consulta: consultaBusqueda,
    filtro,
    expediente: p.modo === 'expediente' ? p.expediente : undefined,
    conjunto,
    terminosFts,
    transformaciones: await transformacionesDelTurno(planConfiable ? plan : null, rapido, parametros.sinonimos),
  });
  if (usoRerank) await registrarUsoToken(provider, 'chat_rerank', usoRerank);
  if (usoHyde) await registrarUsoToken(rapido, 'chat_hyde', usoHyde);

  // [3] Sin nada que sostenga una respuesta (ni fragmentos ni línea de tiempo del expediente), no
  // se le pregunta al modelo: solo podría adivinar o repetir que no sabe, y cobrando por ello.
  if (citas.length === 0 && !(timeline && timeline.length > 0)) {
    return fijo('sin_resultados', planificador);
  }

  const mensajeAsistenteId = await crearMensajeAsistentePendiente(sesion.id, traza.id);
  traza.mensajeId = mensajeAsistenteId;
  await persistirCitas(mensajeAsistenteId, citas);

  return completarTurno({
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

/**
 * Última etapa de un turno de contenido, con las citas ya persistidas: la llamada de respuesta y su
 * registro. Común al turno normal y a su reintento. Si la llamada falla, el mensaje queda 'fallido'
 * (con las citas y lo necesario en `meta`) y se lanza un ChatError 502 reintentable: antes se BORRABA
 * y había que volver a escribir la pregunta, planificar y buscar de cero.
 */
async function completarTurno(d: {
  provider: ChatProvider;
  sesionId: number;
  mensajeId: number;
  modo: string;
  pregunta: string;
  timeline: LineaTiempo[] | null;
  citas: CitaPendiente[];
  historial: MensajeChat[];
  retrieval: CifrasRetrieval;
  planificador: ResultadoPlanificador | null;
  inicio: number;
}): Promise<RespuestaChat> {
  let generada: Awaited<ReturnType<typeof generarRespuesta>>;
  try {
    generada = await generarRespuesta(d.provider, {
      timeline: d.timeline, citas: d.citas, historial: d.historial, mensaje: d.pregunta,
    });
  } catch (error) {
    await marcarFallido(d.mensajeId, {
      fallo: { error: error instanceof Error ? error.message.slice(0, 500) : String(error), fe: new Date().toISOString() },
      plan: d.planificador ? { ...d.planificador.plan, respaldo: d.planificador.respaldo, ms: d.planificador.ms } : null,
      retrieval: d.retrieval,
    });
    throw errorTurnoFallido(d.mensajeId, d.sesionId, error);
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
    modulo: 'sgd', db: appSequelize, usuarioId: traza?.usuarioId ?? '', sesionId: d.sesionId, mensajeId: d.mensajeId,
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
      nuAnn: c.nuAnn,
      nuEmi: c.nuEmi,
      nuAne: c.nuAne,
      extracto: extractoDeChunk(c.texto),
      chars: c.texto.length,
      rutaTitulos: c.rutaTitulos,
      usada: numerosUsados.includes(c.numero),
    })),
    candidatosVec: d.retrieval.candidatosVec,
    candidatosFts: d.retrieval.candidatosFts,
    marcadoresAlucinados: marcadoresInvalidos.length,
  };
}

interface FilaMensajeFallido {
  id: number;
  sesion_id: number;
  estado: string;
  meta: { retrieval?: CifrasRetrieval } | null;
  traza_id: string | null;
  usuario_id: string;
  modo: 'general' | 'expediente';
  nu_ann_exp: string | null;
  nu_sec_exp: string | null;
}

/**
 * Reintenta la respuesta de un turno 'fallido' (docs/PLAN-RAG-AVANZADO.md, Fase 2: recuperación de
 * estado). No vuelve a planificar ni a buscar: usa las citas que el turno ya había guardado, y
 * CONTINÚA su traza (mismo id) en vez de abrir otra desde cero. Las citas se vuelven a filtrar con
 * los permisos ACTUALES del usuario.
 */
export async function reintentarRespuesta(
  mensajeId: number,
  usuario: { usuarioId: string; sinRestriccionDependencia: boolean; coDependencia: string | null },
): Promise<RespuestaChat> {
  const disponibilidad = chatDisponible();
  if (!disponibilidad.disponible) {
    throw new ChatError(`El chat no está disponible: ${disponibilidad.motivo}`, 409);
  }

  const [m] = await appSequelize.query<FilaMensajeFallido>(
    `SELECT m.id, m.sesion_id, m.estado, m.meta, m.traza_id, s.usuario_id, s.modo, s.nu_ann_exp, s.nu_sec_exp
       FROM rag.chat_mensaje m
       JOIN rag.chat_sesion s ON s.id = m.sesion_id
      WHERE m.id = $1 AND m.rol = 'assistant'`,
    { bind: [mensajeId], type: QueryTypes.SELECT },
  );
  if (!m) throw new ChatError('El mensaje no existe', 404);
  if (m.usuario_id !== usuario.usuarioId) throw new ChatError('Ese mensaje no le pertenece', 403);
  if (m.estado !== 'fallido') throw new ChatError('Ese mensaje ya tiene respuesta: no hay nada que reintentar', 409);

  return enTraza(
    {
      id: m.traza_id ?? undefined, nombre: `chat.sgd.${m.modo}`, modulo: 'sgd', db: appSequelize,
      usuarioId: usuario.usuarioId, sesionId: m.sesion_id, mensajeId, entrada: { reintento: mensajeId },
    },
    async (traza) => {
      const inicio = Date.now();
      const [pregunta] = await appSequelize.query<{ id: number; texto: string }>(
        `SELECT id, texto FROM rag.chat_mensaje
          WHERE sesion_id = $1 AND rol = 'user' AND id < $2 ORDER BY id DESC LIMIT 1`,
        { bind: [m.sesion_id, mensajeId], type: QueryTypes.SELECT },
      );
      if (!pregunta) throw new ChatError('No se encontró la pregunta de ese turno', 409);

      const filtro: FiltroAcceso = { coDependencia: usuario.sinRestriccionDependencia ? null : usuario.coDependencia };
      const citas = await paso('citas_guardadas', { mensajeId }, () => citasGuardadas(mensajeId, filtro),
        { tipo: 'recuperacion', resumir: (c) => ({ salida: { citas: c.map((x) => x.numero) } }) });
      const expediente = m.modo === 'expediente' && m.nu_ann_exp && m.nu_sec_exp
        ? { nuAnnExp: m.nu_ann_exp, nuSecExp: m.nu_sec_exp }
        : null;
      const timeline = expediente ? await estadoExpediente(expediente.nuAnnExp, expediente.nuSecExp) : null;
      if (citas.length === 0 && !(timeline && timeline.length > 0)) {
        throw new ChatError('Los fragmentos de ese turno ya no están disponibles: vuelva a hacer la pregunta', 409);
      }

      const r = await completarTurno({
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

/** Citas ya persistidas de un mensaje, con el texto de su chunk, re-filtradas por permisos. */
async function citasGuardadas(mensajeId: number, filtro: FiltroAcceso): Promise<CitaPendiente[]> {
  const filas = await appSequelize.query<{
    numero: number; chunk_id: number; documento_id: number; nu_ann: string; nu_emi: string; nu_ane: number;
    texto: string; ruta_titulos: string | null;
  }>(
    `SELECT ci.numero, ci.chunk_id, ci.documento_id, d.nu_ann, d.nu_emi, d.nu_ane, c.texto, c.ruta_titulos
       FROM rag.cita ci
       JOIN rag.chunk c ON c.id = ci.chunk_id
       JOIN rag.documento d ON d.id = ci.documento_id
      WHERE ci.mensaje_id = $1 AND ($2::text IS NULL OR d.co_dep_emi = $2)
      ORDER BY ci.numero`,
    { bind: [mensajeId, filtro.coDependencia], type: QueryTypes.SELECT },
  );
  return filas.map((f) => ({
    numero: f.numero, chunkId: f.chunk_id, documentoId: f.documento_id,
    nuAnn: f.nu_ann, nuEmi: f.nu_emi, nuAne: f.nu_ane, texto: f.texto, rutaTitulos: f.ruta_titulos,
  }));
}

interface FilaMensajeHistorial {
  id: number;
  rol: 'user' | 'assistant';
  tipo: TipoRespuesta;
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
  tipo: TipoRespuesta;
  texto: string;
  feAlta: string;
  /** 'fallido' = la respuesta no se pudo generar; el frontend ofrece reintentarla. */
  estado: 'ok' | 'fallido';
  /** 👍 (1) / 👎 (-1) que dio el usuario a esta respuesta; null si no la valoró (Fase 5). */
  valoracion: 1 | -1 | null;
  citas: CitaRespuesta[];
  /** En `tipo='tabla'`: totales sin filas (`filas: []`, `pagina: 0`). El frontend pide la página 1
   *  al pintarla: abrir una conversación no re-consulta el SGD por cada listado del historial. */
  tabla?: TablaExpedientes;
  /** En `tipo='documento'` / `'participantes'`: la foto guardada al responder (estado de entonces). */
  documento?: TarjetaDocumento;
  participantes?: BloqueParticipantes;
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
    `SELECT m.id, m.rol, m.tipo, m.texto, m.fe_alta::text, m.estado, v.valor AS valoracion,
            CASE WHEN m.tipo IN ('tabla', 'documento', 'participantes') THEN m.meta END AS meta
       FROM rag.chat_mensaje m
       LEFT JOIN rag.valoracion_mensaje v ON v.mensaje_id = m.id
      WHERE m.sesion_id = $1 ORDER BY m.id ASC`,
    { bind: [sesionId], type: QueryTypes.SELECT },
  );

  const idsAsistente = filas.filter((f) => f.rol === 'assistant').map((f) => f.id);
  const citasPorMensaje = await citasDeMensajes(idsAsistente);

  return filas.map((f) => ({
    id: f.id,
    rol: f.rol,
    tipo: f.tipo,
    texto: f.texto,
    feAlta: f.fe_alta,
    estado: f.estado ?? 'ok',
    valoracion: f.valoracion ?? null,
    citas: citasPorMensaje.get(f.id) ?? [],
    ...(f.tipo === 'tabla' && esMetaListado(f.meta) ? { tabla: resumenTabla(f.meta) } : {}),
    ...(f.tipo === 'documento' && metaConCampo(f.meta, 'documento') ? { documento: f.meta.documento as TarjetaDocumento } : {}),
    ...(f.tipo === 'participantes' && metaConCampo(f.meta, 'participantes')
      ? { participantes: f.meta.participantes as BloqueParticipantes }
      : {}),
  }));
}

function metaConCampo<K extends string>(meta: unknown, campo: K): meta is Record<K, unknown> {
  return typeof meta === 'object' && meta !== null && campo in meta;
}

/**
 * Página `pagina` de un listado ya respondido ("ver más"): se lee la lista guardada en `meta`, sin
 * volver a buscar ni llamar al modelo.
 *
 * Autoriza por PROPIEDAD DE LA CONVERSACIÓN (mismo criterio que `textoChunkCitado`): la lista se
 * armó con el filtro de dependencia del usuario al responder. El detalle se vuelve a acotar con su
 * filtro actual, así que un cambio de dependencia posterior no amplía lo que ve.
 */
export async function paginaResultados(
  mensajeId: number,
  pagina: number,
  usuarioId: string,
  filtro: FiltroAcceso,
): Promise<TablaExpedientes> {
  const filas = await appSequelize.query<{ meta: unknown }>(
    `SELECT m.meta
       FROM rag.chat_mensaje m
       JOIN rag.chat_sesion s ON s.id = m.sesion_id
      WHERE m.id = $1 AND s.usuario_id = $2 AND m.tipo = 'tabla'`,
    { bind: [mensajeId, usuarioId], type: QueryTypes.SELECT },
  );
  const meta = filas[0]?.meta;
  if (!esMetaListado(meta)) throw new ChatError('Ese listado no está disponible', 404);
  return paginaDesdeMeta(meta, pagina, filtro);
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

/**
 * 👍/👎 del usuario sobre una respuesta (docs/PLAN-RAG-AVANZADO.md, Fase 5): alimenta el panel de calidad y,
 * los negativos, el dataset de evaluación (`eval:rag:semilla --valorados`). `valor = 0` la retira.
 */
export async function valorarMensaje(
  mensajeId: number,
  usuarioId: string,
  datos: { valor: -1 | 0 | 1; comentario: string | null },
): Promise<{ ok: true }> {
  const r = await guardarValoracion(appSequelize, { mensajeId, usuarioId, ...datos });
  if (r !== 'ok') throw new ChatError(ERRORES_VALORACION[r].mensaje, ERRORES_VALORACION[r].status);
  return { ok: true };
}
