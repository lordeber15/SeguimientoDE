import { QueryTypes, type Sequelize } from 'sequelize';

/**
 * Valoración 👍/👎 de una respuesta del chat (docs/PLAN-RAG-AVANZADO.md, Fase 5). Común al SGD y al STD:
 * cada uno la llama con su BD y traduce el resultado a su propio error HTTP.
 *
 * Solo el dueño de la conversación valora, y solo respuestas del asistente que llegaron a responderse
 * (un turno `fallido` no tiene respuesta que valorar). Una nueva valoración reemplaza la anterior;
 * `valor = 0` la retira.
 */

export type ResultadoValoracion = 'ok' | 'no_existe' | 'ajeno' | 'no_valorable';

export async function guardarValoracion(
  db: Sequelize,
  datos: { mensajeId: number; usuarioId: string; valor: -1 | 0 | 1; comentario?: string | null },
): Promise<ResultadoValoracion> {
  const [m] = await db.query<{ rol: string; estado: string | null; usuario_id: string }>(
    `SELECT m.rol, m.estado, s.usuario_id
       FROM rag.chat_mensaje m JOIN rag.chat_sesion s ON s.id = m.sesion_id
      WHERE m.id = $1`,
    { bind: [datos.mensajeId], type: QueryTypes.SELECT },
  );
  if (!m) return 'no_existe';
  if (m.usuario_id !== datos.usuarioId) return 'ajeno';
  if (m.rol !== 'assistant' || (m.estado ?? 'ok') !== 'ok') return 'no_valorable';

  if (datos.valor === 0) {
    await db.query('DELETE FROM rag.valoracion_mensaje WHERE mensaje_id = $1', {
      bind: [datos.mensajeId], type: QueryTypes.DELETE,
    });
    return 'ok';
  }
  await db.query(
    `INSERT INTO rag.valoracion_mensaje (mensaje_id, usuario_id, valor, comentario)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (mensaje_id) DO UPDATE SET valor = $3, comentario = $4, fe = now()`,
    {
      bind: [datos.mensajeId, datos.usuarioId, datos.valor, datos.comentario?.trim().slice(0, 1000) || null],
      type: QueryTypes.INSERT,
    },
  );
  return 'ok';
}

/** Mensaje HTTP y estado de cada resultado distinto de 'ok'. */
export const ERRORES_VALORACION: Record<Exclude<ResultadoValoracion, 'ok'>, { status: number; mensaje: string }> = {
  no_existe: { status: 404, mensaje: 'El mensaje no existe' },
  ajeno: { status: 403, mensaje: 'Ese mensaje no le pertenece' },
  no_valorable: { status: 409, mensaje: 'Solo se pueden valorar respuestas del asistente ya respondidas' },
};

/** Valida el cuerpo `{ valor: 1 | -1 | 0, comentario?: string }`. `null` si no es válido. */
export function leerCuerpoValoracion(cuerpo: unknown): { valor: -1 | 0 | 1; comentario: string | null } | null {
  if (typeof cuerpo !== 'object' || cuerpo === null) return null;
  const { valor, comentario } = cuerpo as { valor?: unknown; comentario?: unknown };
  if (valor !== 1 && valor !== -1 && valor !== 0) return null;
  if (comentario !== undefined && comentario !== null && typeof comentario !== 'string') return null;
  return { valor, comentario: typeof comentario === 'string' ? comentario : null };
}
