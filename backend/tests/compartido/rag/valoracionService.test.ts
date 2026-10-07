/** 👍/👎 de las respuestas del chat (docs/PLAN-RAG-AVANZADO.md, Fase 5). */
import type { Sequelize } from 'sequelize';
import { guardarValoracion, leerCuerpoValoracion } from '../../../src/compartido/rag/valoracionService';

const query = jest.fn();
const db = { query: (...a: unknown[]) => query(...a) } as unknown as Sequelize;

function mensaje(fila: { rol?: string; estado?: string | null; usuario_id?: string } | null) {
  query.mockReset().mockImplementation((sql: string) => (sql.includes('FROM rag.chat_mensaje m JOIN rag.chat_sesion')
    ? Promise.resolve(fila ? [{ rol: 'assistant', estado: 'ok', usuario_id: 'u1', ...fila }] : [])
    : Promise.resolve(undefined)));
}

const sqls = () => query.mock.calls.map(([sql]) => String(sql));

describe('guardarValoracion', () => {
  it('guarda (o reemplaza) la valoración del dueño sobre una respuesta', async () => {
    mensaje({});
    expect(await guardarValoracion(db, { mensajeId: 9, usuarioId: 'u1', valor: -1, comentario: '  inventó el monto ' })).toBe('ok');
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO rag.valoracion_mensaje'))!;
    expect(insert[0]).toContain('ON CONFLICT (mensaje_id) DO UPDATE');
    expect(insert[1].bind).toEqual([9, 'u1', -1, 'inventó el monto']);
  });

  it('valor 0 retira la valoración', async () => {
    mensaje({});
    expect(await guardarValoracion(db, { mensajeId: 9, usuarioId: 'u1', valor: 0 })).toBe('ok');
    expect(sqls().some((s) => s.startsWith('DELETE FROM rag.valoracion_mensaje'))).toBe(true);
  });

  it('rechaza mensajes ajenos, inexistentes, del usuario o fallidos sin tocar nada', async () => {
    mensaje(null);
    expect(await guardarValoracion(db, { mensajeId: 9, usuarioId: 'u1', valor: 1 })).toBe('no_existe');
    mensaje({ usuario_id: 'otro' });
    expect(await guardarValoracion(db, { mensajeId: 9, usuarioId: 'u1', valor: 1 })).toBe('ajeno');
    mensaje({ rol: 'user' });
    expect(await guardarValoracion(db, { mensajeId: 9, usuarioId: 'u1', valor: 1 })).toBe('no_valorable');
    mensaje({ estado: 'fallido' });
    expect(await guardarValoracion(db, { mensajeId: 9, usuarioId: 'u1', valor: 1 })).toBe('no_valorable');
    expect(sqls().some((s) => s.includes('INSERT') || s.includes('DELETE'))).toBe(false);
  });
});

describe('leerCuerpoValoracion', () => {
  it('acepta 1, -1 y 0 con comentario opcional', () => {
    expect(leerCuerpoValoracion({ valor: 1 })).toEqual({ valor: 1, comentario: null });
    expect(leerCuerpoValoracion({ valor: -1, comentario: 'mal' })).toEqual({ valor: -1, comentario: 'mal' });
    expect(leerCuerpoValoracion({ valor: 0 })).toEqual({ valor: 0, comentario: null });
  });

  it('rechaza otros valores o un comentario que no es texto', () => {
    expect(leerCuerpoValoracion({ valor: 2 })).toBeNull();
    expect(leerCuerpoValoracion({ valor: '1' })).toBeNull();
    expect(leerCuerpoValoracion({ valor: 1, comentario: 5 })).toBeNull();
    expect(leerCuerpoValoracion(null)).toBeNull();
  });
});
