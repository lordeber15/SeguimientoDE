/**
 * Juez LLM en producción (docs/PLAN-RAG-AVANZADO.md, Fase 5): interpretación tolerante del veredicto,
 * muestreo, que un juez roto quede registrado sin lanzar, y la alerta por tendencia de fidelidad baja.
 */

const alertar = jest.fn();
const exportarPuntajesALangfuse = jest.fn();
const leerBooleano = jest.fn();
const leerNumero = jest.fn();

jest.mock('../../../src/compartido/observabilidad/alertas', () => ({ alertar: (...a: unknown[]) => alertar(...a) }));
jest.mock('../../../src/compartido/observabilidad/publicacion', () => ({
  exportarPuntajesALangfuse: (...a: unknown[]) => exportarPuntajesALangfuse(...a),
}));
jest.mock('../../../src/compartido/rag/configService', () => ({
  leerBooleano: (...a: unknown[]) => leerBooleano(...a),
  leerNumero: (...a: unknown[]) => leerNumero(...a),
}));
jest.mock('../../../src/compartido/ai/providerFactory', () => ({ crearChatProviderJuez: () => null }));

import type { Sequelize } from 'sequelize';
import type { ChatProvider } from '../../../src/compartido/ai/types';
import {
  construirEntradaJuez,
  interpretarVeredicto,
  juzgarSiToca,
  juzgarYGuardar,
  type TurnoAJuzgar,
} from '../../../src/compartido/rag/juezService';

const query = jest.fn();
const db = { query: (...a: unknown[]) => query(...a) } as unknown as Sequelize;

function turno(over: Partial<TurnoAJuzgar> = {}): TurnoAJuzgar {
  return {
    modulo: 'sgd', db, usuarioId: 'u1', sesionId: 7, mensajeId: 42, trazaId: 'a'.repeat(32),
    pregunta: '¿Cuál es el monto del contrato?', respuesta: 'El monto es S/ 1 200 000 [D1].',
    fragmentos: [{ numero: 1, texto: 'El monto contractual asciende a S/ 1 200 000,00.' }],
    ...over,
  };
}

function proveedor(texto: string | Error): ChatProvider & { responder: jest.Mock } {
  return {
    nombre: 'openai', modelo: 'gpt-4o', comprobar: jest.fn(),
    responder: jest.fn(() => (texto instanceof Error
      ? Promise.reject(texto)
      : Promise.resolve({ texto, uso: { tokensIn: 400, tokensOut: 60, estimado: false } }))),
  };
}

const VEREDICTO_OK = '{"fidelidad":0.9,"relevancia":1,"uso_citas":0.8,"se_abstiene":false,"abstencion_correcta":null,"comentario":"sin observaciones"}';

/** Por defecto: INSERT del juicio devuelve fila (es nuevo) y la tendencia es sana. */
function instalarBd(tendencia = { n: 3, media: 0.9 }) {
  query.mockReset().mockImplementation((sql: string) => {
    if (sql.includes('INSERT INTO rag.juicio_turno')) return Promise.resolve([{ id: 1 }]);
    if (sql.includes('avg(fidelidad)')) return Promise.resolve([tendencia]);
    return Promise.resolve(undefined);
  });
}

beforeEach(() => {
  alertar.mockReset();
  exportarPuntajesALangfuse.mockReset().mockResolvedValue(undefined);
  leerBooleano.mockReset();
  leerNumero.mockReset().mockImplementation((_c: string, porDefecto: number) => Promise.resolve(porDefecto));
  instalarBd();
});

describe('interpretarVeredicto', () => {
  it('normaliza el JSON del juez, aunque venga con texto alrededor', () => {
    expect(interpretarVeredicto(`Aquí va:\n\`\`\`json\n${VEREDICTO_OK}\n\`\`\``)).toEqual({
      fidelidad: 0.9, relevancia: 1, usoCitas: 0.8, seAbstiene: false, abstencionCorrecta: null, comentario: 'sin observaciones',
    });
  });

  it('acota los puntajes a [0, 1] y acepta números como texto', () => {
    const v = interpretarVeredicto('{"fidelidad":"1.4","relevancia":-0.2,"uso_citas":0.5}');
    expect(v).toMatchObject({ fidelidad: 1, relevancia: 0, usoCitas: 0.5, seAbstiene: false });
  });

  it('abstencion_correcta solo cuenta si se abstuvo', () => {
    expect(interpretarVeredicto('{"fidelidad":1,"relevancia":1,"uso_citas":1,"se_abstiene":false,"abstencion_correcta":true}')?.abstencionCorrecta).toBeNull();
    expect(interpretarVeredicto('{"fidelidad":1,"relevancia":0,"uso_citas":1,"se_abstiene":true,"abstencion_correcta":false}')?.abstencionCorrecta).toBe(false);
  });

  it('null si falta un puntaje o no hay JSON', () => {
    expect(interpretarVeredicto('{"fidelidad":0.9}')).toBeNull();
    expect(interpretarVeredicto('La respuesta es buena.')).toBeNull();
  });
});

describe('construirEntradaJuez', () => {
  it('incluye pregunta, fragmentos numerados, línea de tiempo y respuesta, recortando los fragmentos largos', () => {
    const entrada = construirEntradaJuez(turno({
      fragmentos: [{ numero: 1, texto: 'x'.repeat(5000) }, { numero: 2, texto: 'corto' }],
      lineaTiempo: [{ fecha: '2026-01-02', asunto: 'Adenda' }],
    }));
    expect(entrada).toContain('Pregunta: ¿Cuál es el monto del contrato?');
    expect(entrada).toContain('[D2] corto');
    expect(entrada).toContain('Línea de tiempo: [{"fecha":"2026-01-02","asunto":"Adenda"}]');
    expect(entrada).toContain('Respuesta del asistente:\nEl monto es S/ 1 200 000 [D1].');
    expect(entrada.length).toBeLessThan(2000);
  });
});

describe('juzgarYGuardar', () => {
  it('guarda el veredicto y su costo, y exporta los puntajes a la traza del turno', async () => {
    const v = await juzgarYGuardar(turno(), proveedor(VEREDICTO_OK));

    expect(v?.fidelidad).toBe(0.9);
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO rag.juicio_turno'))!;
    expect(insert[1].bind.slice(0, 8)).toEqual([42, 'a'.repeat(32), 'openai', 'gpt-4o', 0.9, 1, 0.8, false]);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("'chat_juez'"))).toBe(true);
    expect(exportarPuntajesALangfuse).toHaveBeenCalledWith('a'.repeat(32), expect.arrayContaining([
      expect.objectContaining({ nombre: 'fidelidad', valor: 0.9 }),
    ]));
  });

  it('un juez caído no lanza: el juicio queda guardado con el error', async () => {
    const v = await juzgarYGuardar(turno(), proveedor(new Error('timeout')));

    expect(v).toBeNull();
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO rag.juicio_turno'))!;
    expect(insert[1].bind[12]).toContain('timeout');
    expect(exportarPuntajesALangfuse).not.toHaveBeenCalled();
  });

  it('una salida que no es veredicto también queda como error, con su texto', async () => {
    await juzgarYGuardar(turno(), proveedor('Me parece bien.'));
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO rag.juicio_turno'))!;
    expect(insert[1].bind[12]).toContain('Me parece bien.');
  });

  it('si el turno ya estaba juzgado (reintento del mismo mensaje) no exporta ni revisa la tendencia', async () => {
    query.mockImplementation((sql: string) => Promise.resolve(sql.includes('INSERT INTO rag.juicio_turno') ? [] : undefined));
    await juzgarYGuardar(turno(), proveedor(VEREDICTO_OK));
    expect(exportarPuntajesALangfuse).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes('avg(fidelidad)'))).toBe(false);
  });

  it('alerta si la fidelidad media reciente cae bajo el umbral (con un mínimo de juicios)', async () => {
    instalarBd({ n: 8, media: 0.55 });
    await juzgarYGuardar(turno(), proveedor(VEREDICTO_OK));
    expect(alertar).toHaveBeenCalledWith('calidad_baja', expect.stringContaining('55 %'), expect.objectContaining({ n: 8 }), 'sgd');
  });

  it('no alerta con pocos juicios aunque la media sea baja', async () => {
    instalarBd({ n: 3, media: 0.2 });
    await juzgarYGuardar(turno(), proveedor(VEREDICTO_OK));
    expect(alertar).not.toHaveBeenCalled();
  });
});

describe('juzgarSiToca', () => {
  it('apagado: no juzga', async () => {
    leerBooleano.mockResolvedValue(false);
    expect(await juzgarSiToca(turno(), () => 0)).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('encendido: juzga solo si el azar cae dentro del muestreo', async () => {
    leerBooleano.mockResolvedValue(true);
    leerNumero.mockImplementation((clave: string, porDefecto: number) => Promise.resolve(clave === 'chat.juez.muestreo' ? 0.25 : porDefecto));
    expect(await juzgarSiToca(turno(), () => 0.3)).toBe(false);
  });
});
