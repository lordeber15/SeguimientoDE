import { QueryTypes, type Sequelize } from 'sequelize';
import { appSequelize } from '../config/appDatabase';
import { leerBooleano, leerNumero } from './configService';

/**
 * Panel de calidad del chat (docs/PLAN-RAG-AVANZADO.md, Fase 5), común al SGD y al STD: tendencia semanal
 * del juez LLM y de las valoraciones 👍/👎, los turnos peor evaluados (para revisarlos y llevarlos al
 * dataset) y la última corrida offline de `eval:rag` del módulo.
 */

const SEMANAS = 8;
const MAX_PEORES = 10;

export interface SemanaCalidad {
  semana: string;
  juicios: number;
  fidelidad: number | null;
  relevancia: number | null;
  usoCitas: number | null;
  abstenciones: number;
  abstencionesIncorrectas: number;
  erroresJuez: number;
  positivas: number;
  negativas: number;
}

export interface TurnoObservado {
  mensajeId: number;
  fe: string;
  pregunta: string | null;
  respuesta: string;
  fidelidad: number | null;
  relevancia: number | null;
  comentario: string | null;
  valoracion: 1 | -1 | null;
  comentarioUsuario: string | null;
}

export interface ResumenCalidad {
  config: { activo: boolean; muestreo: number; umbralFidelidad: number };
  semanas: SemanaCalidad[];
  peores: TurnoObservado[];
  evalOffline: { id: number; fe: string; casos: number; hitN: number | null; hitK: number | null; mrr: number | null; aceptada: boolean } | null;
}

export async function resumenCalidad(db: Sequelize, modulo: 'sgd' | 'std'): Promise<ResumenCalidad> {
  const [activo, muestreo, umbralFidelidad] = await Promise.all([
    leerBooleano('chat.juez.activo', false, db),
    leerNumero('chat.juez.muestreo', 0.1, db),
    leerNumero('chat.juez.umbral_fidelidad', 0.7, db),
  ]);

  // Semanas sin juicios ni valoraciones también salen (en cero): un hueco es información.
  const semanas = await db.query<SemanaCalidad>(
    `WITH semanas AS (
       SELECT generate_series(date_trunc('week', now()) - interval '${SEMANAS - 1} weeks', date_trunc('week', now()), interval '1 week') AS semana
     ), j AS (
       SELECT date_trunc('week', fe) AS semana, count(*) FILTER (WHERE error IS NULL)::int AS juicios,
              avg(fidelidad)::float AS fidelidad, avg(relevancia)::float AS relevancia, avg(uso_citas)::float AS "usoCitas",
              count(*) FILTER (WHERE se_abstiene)::int AS abstenciones,
              count(*) FILTER (WHERE se_abstiene AND abstencion_correcta = false)::int AS "abstencionesIncorrectas",
              count(*) FILTER (WHERE error IS NOT NULL)::int AS "erroresJuez"
         FROM rag.juicio_turno WHERE fe >= date_trunc('week', now()) - interval '${SEMANAS - 1} weeks'
        GROUP BY 1
     ), v AS (
       SELECT date_trunc('week', fe) AS semana,
              count(*) FILTER (WHERE valor = 1)::int AS positivas, count(*) FILTER (WHERE valor = -1)::int AS negativas
         FROM rag.valoracion_mensaje WHERE fe >= date_trunc('week', now()) - interval '${SEMANAS - 1} weeks'
        GROUP BY 1
     )
     SELECT to_char(s.semana, 'YYYY-MM-DD') AS semana,
            coalesce(j.juicios, 0) AS juicios, j.fidelidad, j.relevancia, j."usoCitas",
            coalesce(j.abstenciones, 0) AS abstenciones, coalesce(j."abstencionesIncorrectas", 0) AS "abstencionesIncorrectas",
            coalesce(j."erroresJuez", 0) AS "erroresJuez",
            coalesce(v.positivas, 0) AS positivas, coalesce(v.negativas, 0) AS negativas
       FROM semanas s LEFT JOIN j ON j.semana = s.semana LEFT JOIN v ON v.semana = s.semana
      ORDER BY s.semana`,
    { type: QueryTypes.SELECT },
  );

  // Peores: 👎 del usuario o fidelidad bajo el umbral, de los últimos 30 días, lo más reciente primero.
  const peores = await db.query<TurnoObservado>(
    `SELECT m.id AS "mensajeId", m.fe_alta::text AS fe,
            (SELECT u.texto FROM rag.chat_mensaje u
              WHERE u.sesion_id = m.sesion_id AND u.id < m.id AND u.rol = 'user' ORDER BY u.id DESC LIMIT 1) AS pregunta,
            left(m.texto, 400) AS respuesta, j.fidelidad, j.relevancia, j.comentario,
            v.valor AS valoracion, v.comentario AS "comentarioUsuario"
       FROM rag.chat_mensaje m
       LEFT JOIN rag.juicio_turno j ON j.mensaje_id = m.id AND j.error IS NULL
       LEFT JOIN rag.valoracion_mensaje v ON v.mensaje_id = m.id
      WHERE m.rol = 'assistant' AND m.fe_alta > now() - interval '30 days'
        AND (v.valor = -1 OR j.fidelidad < $1)
      ORDER BY m.fe_alta DESC
      LIMIT ${MAX_PEORES}`,
    { bind: [umbralFidelidad], type: QueryTypes.SELECT },
  );

  // Las corridas offline de ambos módulos se guardan en la BD propia del SGD (ver evaluarRag.ts).
  const [corrida] = await appSequelize.query<{
    id: number; fe: string; casos: number; aceptada: boolean; promedios: Record<string, number | null> | null;
  }>(
    `SELECT id, fe::text AS fe, casos, aceptada, metricas->'promedios' AS promedios
       FROM rag.eval_corrida WHERE modulo = $1 ORDER BY fe DESC LIMIT 1`,
    { bind: [modulo], type: QueryTypes.SELECT },
  );

  return {
    config: { activo, muestreo, umbralFidelidad },
    semanas,
    peores: peores.map((p) => ({ ...p, mensajeId: Number(p.mensajeId) })),
    evalOffline: corrida
      ? {
        id: Number(corrida.id), fe: corrida.fe, casos: corrida.casos, aceptada: corrida.aceptada,
        hitN: corrida.promedios?.hitN ?? null, hitK: corrida.promedios?.hitK ?? null, mrr: corrida.promedios?.mrr ?? null,
      }
      : null,
  };
}
