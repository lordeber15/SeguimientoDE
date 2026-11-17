import { QueryTypes, type Sequelize } from 'sequelize';
import { z } from 'zod';
import { crearChatProviderJuez } from '../ai/providerFactory';
import type { ChatProvider, ResultadoChat } from '../ai/types';
import { alertar } from '../observabilidad/alertas';
import { exportarPuntajesALangfuse } from '../observabilidad/publicacion';
import { enTraza, mensajeDe, paso } from '../observabilidad/traza';
import { leerBooleano, leerNumero } from './configService';
import { extraerJson } from './planificadorService';

/**
 * Juez LLM en producción (docs/PLAN-RAG-AVANZADO.md, Fase 5): una muestra de los turnos que respondió el
 * modelo (`chat.juez.muestreo`) se evalúa EN SEGUNDO PLANO, después de contestar al usuario — nunca
 * demora ni tumba la respuesta. Mide lo mismo que Ragas en la evaluación offline, pero sobre preguntas
 * reales y sin ground truth: fidelidad a los fragmentos, relevancia, uso de las citas y si la abstención
 * ("no está en la base") era correcta.
 *
 * El veredicto se guarda en `rag.juicio_turno` (y como puntajes de la traza en Langfuse, si está
 * configurado); si la fidelidad media reciente cae bajo `chat.juez.umbral_fidelidad`, alerta. Cada juicio
 * corre en su propia traza (`juez.<modulo>`), con su costo en `rag.uso_token` (`chat_juez`).
 */

export interface TurnoAJuzgar {
  modulo: 'sgd' | 'std';
  db: Sequelize;
  usuarioId: string;
  sesionId: number;
  mensajeId: number;
  /** Traza del turno juzgado: el veredicto se cuelga de ella en Langfuse. */
  trazaId: string | null;
  pregunta: string;
  respuesta: string;
  fragmentos: { numero: number; texto: string }[];
  /** Datos estructurados que también vio el modelo (línea de tiempo del expediente/documento). */
  lineaTiempo?: unknown;
}

export interface Veredicto {
  fidelidad: number;
  relevancia: number;
  usoCitas: number;
  seAbstiene: boolean;
  abstencionCorrecta: boolean | null;
  comentario: string;
}

const MAX_FRAGMENTOS = 8;
const MAX_CHARS_FRAGMENTO = 1500;
const MAX_CHARS_LINEA_TIEMPO = 3000;
const MAX_TOKENS_JUICIO = 300;
/** La alerta mira los últimos N juicios de 7 días, y solo con un mínimo: un mal turno aislado no es una tendencia. */
const VENTANA_ALERTA = 20;
const MINIMO_ALERTA = 5;

const PROMPT_JUEZ = `Eres un evaluador estricto de un asistente que responde preguntas sobre documentos de \
trámite de una entidad pública. El asistente debe usar SOLO los fragmentos que se le dieron (citados como \
[D1], [D2]…) y la línea de tiempo, y decir que la información no está en la base cuando no aparece. \
Devuelve SOLO un objeto JSON, sin texto alrededor:
{"fidelidad":0.0,"relevancia":0.0,"uso_citas":0.0,"se_abstiene":false,"abstencion_correcta":null,"comentario":"…"}

- "fidelidad" (0–1): proporción de las afirmaciones de la respuesta que los fragmentos o la línea de \
tiempo sostienen. Un monto, fecha, nombre o número de documento que no aparece en ellos es una \
alucinación y baja la nota. 1 = todo sostenido.
- "relevancia" (0–1): cuánto responde lo que se preguntó (no otra cosa, no a medias).
- "uso_citas" (0–1): si cada afirmación lleva la cita [Dn] del fragmento que de verdad la dice. Citar un \
fragmento que no dice eso baja la nota. Si la respuesta solo se abstiene, 1.
- "se_abstiene": true si la respuesta dice que la información no está en los documentos o la base.
- "abstencion_correcta": si se abstiene, true cuando los fragmentos de verdad NO contienen la respuesta y \
false cuando sí la contenían; si no se abstiene, null.
- "comentario": una frase con el problema principal, o "sin observaciones".`;

const nota = z.coerce.number().transform((v) => Math.min(1, Math.max(0, v)));
const esquemaVeredicto = z.object({
  fidelidad: nota,
  relevancia: nota,
  uso_citas: nota,
  se_abstiene: z.boolean().nullish().transform((v) => v ?? false),
  abstencion_correcta: z.boolean().nullish().transform((v) => v ?? null),
  comentario: z.string().nullish().transform((v) => (v ?? '').trim().slice(0, 500)),
});

/** `null` si la salida no es un veredicto utilizable. */
export function interpretarVeredicto(texto: string): Veredicto | null {
  const crudo = extraerJson(texto);
  if (crudo === null) return null;
  const r = esquemaVeredicto.safeParse(crudo);
  if (!r.success) return null;
  return {
    fidelidad: r.data.fidelidad,
    relevancia: r.data.relevancia,
    usoCitas: r.data.uso_citas,
    seAbstiene: r.data.se_abstiene,
    abstencionCorrecta: r.data.se_abstiene ? r.data.abstencion_correcta : null,
    comentario: r.data.comentario,
  };
}

export function construirEntradaJuez(turno: Pick<TurnoAJuzgar, 'pregunta' | 'respuesta' | 'fragmentos' | 'lineaTiempo'>): string {
  const fragmentos = turno.fragmentos.slice(0, MAX_FRAGMENTOS).map((f) => {
    const texto = f.texto.replace(/\s+/g, ' ').trim();
    return `[D${f.numero}] ${texto.length > MAX_CHARS_FRAGMENTO ? `${texto.slice(0, MAX_CHARS_FRAGMENTO)}…` : texto}`;
  });
  const lineaTiempo = turno.lineaTiempo
    ? JSON.stringify(turno.lineaTiempo).slice(0, MAX_CHARS_LINEA_TIEMPO)
    : null;
  return [
    `Pregunta: ${turno.pregunta.trim()}`,
    `Fragmentos:\n${fragmentos.length > 0 ? fragmentos.join('\n') : '(ninguno)'}`,
    ...(lineaTiempo ? [`Línea de tiempo: ${lineaTiempo}`] : []),
    `Respuesta del asistente:\n${turno.respuesta.trim()}`,
  ].join('\n\n');
}

export async function juzgar(
  provider: ChatProvider,
  turno: Pick<TurnoAJuzgar, 'pregunta' | 'respuesta' | 'fragmentos' | 'lineaTiempo'>,
): Promise<{ veredicto: Veredicto | null; uso: ResultadoChat['uso']; salida: string }> {
  const r = await provider.responder(
    [{ rol: 'system', contenido: PROMPT_JUEZ }, { rol: 'user', contenido: construirEntradaJuez(turno) }],
    { maxTokens: MAX_TOKENS_JUICIO },
  );
  return { veredicto: interpretarVeredicto(r.texto), uso: r.uso, salida: r.texto };
}

async function guardarJuicio(
  turno: TurnoAJuzgar,
  provider: ChatProvider,
  datos: { veredicto: Veredicto | null; uso: ResultadoChat['uso'] | null; error: string | null },
): Promise<boolean> {
  const v = datos.veredicto;
  const filas = await turno.db.query<{ id: number }>(
    `INSERT INTO rag.juicio_turno
       (mensaje_id, traza_id, proveedor, modelo, fidelidad, relevancia, uso_citas, se_abstiene,
        abstencion_correcta, comentario, tokens_in, tokens_out, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (mensaje_id) DO NOTHING
     RETURNING id`,
    {
      bind: [
        turno.mensajeId, turno.trazaId, provider.nombre, provider.modelo,
        v?.fidelidad ?? null, v?.relevancia ?? null, v?.usoCitas ?? null, v?.seAbstiene ?? null,
        v?.abstencionCorrecta ?? null, v?.comentario ?? null,
        datos.uso?.tokensIn ?? null, datos.uso?.tokensOut ?? null, datos.error,
      ],
      type: QueryTypes.SELECT,
    },
  );
  if (datos.uso) {
    await turno.db.query(
      `INSERT INTO rag.uso_token (proveedor, modelo, operacion, tokens_in, tokens_out, estimado, exito)
       VALUES ($1, $2, 'chat_juez', $3, $4, $5, $6)`,
      {
        bind: [provider.nombre, provider.modelo, datos.uso.tokensIn, datos.uso.tokensOut, datos.uso.estimado, datos.error === null],
        type: QueryTypes.INSERT,
      },
    );
  }
  return filas.length > 0;
}

/** Fidelidad media de los últimos juicios del módulo; alerta si cae bajo el umbral. */
export async function revisarTendencia(db: Sequelize, modulo: 'sgd' | 'std'): Promise<{ n: number; media: number | null }> {
  const [fila] = await db.query<{ n: number; media: number | null }>(
    `SELECT count(*)::int AS n, avg(fidelidad)::float AS media FROM (
       SELECT fidelidad FROM rag.juicio_turno
        WHERE error IS NULL AND fidelidad IS NOT NULL AND fe > now() - interval '7 days'
        ORDER BY fe DESC LIMIT ${VENTANA_ALERTA}
     ) s`,
    { type: QueryTypes.SELECT },
  );
  const umbral = await leerNumero('chat.juez.umbral_fidelidad', 0.7, db);
  if (fila.n >= MINIMO_ALERTA && fila.media !== null && fila.media < umbral) {
    alertar(
      'calidad_baja',
      `Fidelidad media del chat ${(100 * fila.media).toFixed(0)} % en los últimos ${fila.n} turnos juzgados (umbral ${(100 * umbral).toFixed(0)} %).`,
      { modulo, n: fila.n, media: fila.media, umbral },
      modulo,
    );
  }
  return fila;
}

/** Juzga, guarda, exporta a Langfuse y revisa la tendencia. No lanza: un juez roto queda en `error`. */
export async function juzgarYGuardar(turno: TurnoAJuzgar, provider: ChatProvider = crearChatProviderJuez()): Promise<Veredicto | null> {
  let veredicto: Veredicto | null = null;
  let uso: ResultadoChat['uso'] | null = null;
  let error: string | null = null;
  try {
    const r = await paso('juez', { mensajeId: turno.mensajeId, modelo: provider.modelo }, () => juzgar(provider, turno), {
      resumir: (x) => ({ salida: x.veredicto ?? x.salida, nivel: x.veredicto ? 'DEFAULT' : 'WARNING' }),
    });
    veredicto = r.veredicto;
    uso = r.uso;
    if (!veredicto) error = `salida no interpretable: ${r.salida.slice(0, 300)}`;
  } catch (e) {
    error = `error del proveedor: ${mensajeDe(e)}`.slice(0, 500);
  }

  const nuevo = await guardarJuicio(turno, provider, { veredicto, uso, error });
  if (nuevo && veredicto) {
    if (turno.trazaId) {
      await exportarPuntajesALangfuse(turno.trazaId, [
        { nombre: 'fidelidad', valor: veredicto.fidelidad, comentario: veredicto.comentario },
        { nombre: 'relevancia', valor: veredicto.relevancia },
        { nombre: 'uso_citas', valor: veredicto.usoCitas },
      ]);
    }
    await revisarTendencia(turno.db, turno.modulo);
  }
  return veredicto;
}

/**
 * Decide por muestreo si juzgar el turno y, si toca, lo hace en su propia traza. `azar` se inyecta en
 * los tests. Devuelve si se juzgó.
 */
export async function juzgarSiToca(turno: TurnoAJuzgar, azar: () => number = Math.random): Promise<boolean> {
  const [activo, muestreo] = await Promise.all([
    leerBooleano('chat.juez.activo', false, turno.db),
    leerNumero('chat.juez.muestreo', 0.1, turno.db),
  ]);
  if (!activo || azar() >= Math.min(1, Math.max(0, muestreo))) return false;
  await enTraza(
    {
      nombre: `juez.${turno.modulo}`, modulo: turno.modulo, db: turno.db, usuarioId: turno.usuarioId,
      sesionId: turno.sesionId, mensajeId: turno.mensajeId, entrada: { mensajeId: turno.mensajeId, trazaJuzgada: turno.trazaId },
    },
    async (traza) => {
      const v = await juzgarYGuardar(turno);
      traza.salida = v;
      return v;
    },
  );
  return true;
}

/**
 * Lo llama el chat al terminar un turno con respuesta del modelo: corre DESPUÉS de responder, fuera de
 * la petición. Cualquier fallo queda en el log; el usuario nunca lo ve.
 */
export function programarJuicio(turno: TurnoAJuzgar): void {
  setImmediate(() => {
    juzgarSiToca(turno).catch((e) => console.warn(`[juez] no se pudo juzgar el mensaje ${turno.mensajeId}: ${mensajeDe(e)}`));
  });
}
