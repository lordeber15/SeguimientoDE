/**
 * La combinación de hits por término es lo que decide qué expediente aparece y en qué nivel, así
 * que se prueba pura, sin BD (el SQL de cada rama se verificó contra la base real, ver
 * docs/PLAN-CHAT-CONSULTAS.md).
 */
jest.mock('../../../../src/compartido/config/appDatabase', () => ({ appSequelize: { query: jest.fn() } }));
jest.mock('../../../../src/modulos/sgd/config/database', () => ({ DB_SCHEMA: 'sgd', sequelize: { query: jest.fn() } }));
jest.mock('../../../../src/compartido/rag/configService', () => ({ leerNumero: jest.fn() }));

import {
  combinarCandidatos,
  etiquetaCoincidencia,
  terminosDeConsulta,
  terminosDelPlan,
} from '../../../../src/modulos/sgd/rag/busquedaExpedientesService';
import { planDeRespaldo } from '../../../../src/compartido/rag/planificadorService';

const P = { pesoAsunto: 3, pesoContenido: 1, topeDocsPorTermino: 5 };
const fila = (i: number, ann: string | null, sec: string | null, docs: number) => ({ i: String(i), ann, sec, docs });

describe('combinarCandidatos', () => {
  it('exige cada término POR EXPEDIENTE, en metadatos o contenido, y asigna el nivel', () => {
    const meta = [fila(1, '2026', 'A', 2), fila(2, '2026', 'A', 1), fila(2, '2026', 'B', 3)];
    const contenido = [fila(1, '2026', 'B', 4), fila(1, '2026', 'C', 1)];

    const { candidatos, modo } = combinarCandidatos(2, meta, contenido, null, null, P, null);

    expect(modo).toBe('todos');
    // A: ambos términos en metadatos → nivel 1. B: término 1 solo en contenido → nivel 2. C: falta el 2.
    expect(candidatos.map((c) => [c.s, c.n])).toEqual([['A', 1], ['B', 2]]);
  });

  it('sin ninguno que cumpla todos, cae a "alguno" ordenado por términos cumplidos', () => {
    const meta = [fila(1, '2026', 'A', 1), fila(2, '2026', 'B', 1)];
    const contenido = [fila(3, '2026', 'B', 1)];

    const { candidatos, modo } = combinarCandidatos(3, meta, contenido, null, null, P, null);

    expect(modo).toBe('alguno');
    expect(candidatos.map((c) => [c.s, c.t])).toEqual([['B', 2], ['A', 1]]);
  });

  it('con un solo término nunca usa "alguno" (no hay nada que relajar)', () => {
    const { modo, candidatos } = combinarCandidatos(1, [], [], null, null, P, null);
    expect(modo).toBe('todos');
    expect(candidatos).toEqual([]);
  });

  it('el término raro pesa más que el frecuente (IDF)', () => {
    // "raro" (índice 1) solo en X; "comun" (índice 2) en todos. Y tiene más hits del común.
    const meta = [fila(1, '2026', 'X', 1), fila(1, '2026', 'Y', 1)];
    const contenido = [
      fila(2, '2026', 'X', 1), fila(2, '2026', 'Y', 9),
      ...['M1', 'M2', 'M3', 'M4'].map((s) => fila(2, '2026', s, 1)),
    ];
    const contenidoRaro = [fila(1, '2026', 'X', 30)];

    const { candidatos } = combinarCandidatos(2, meta, [...contenido, ...contenidoRaro], null, null, P, null, 6000);
    expect(candidatos[0].s).toBe('X');
  });

  it('aplica filtros, dentroDe y marca el remitente', () => {
    const meta = [fila(1, '2026', 'A', 1), fila(1, '2026', 'B', 1), fila(1, '2026', 'C', 1)];
    const permitidos = new Set(['2026|A', '2026|B']);
    const remitentes = new Set(['2026|A']);
    const dentroDe = new Set(['2026|A']);

    const { candidatos } = combinarCandidatos(1, meta, [], permitidos, remitentes, P, dentroDe);
    expect(candidatos).toHaveLength(1);
    expect(candidatos[0]).toMatchObject({ s: 'A', r: true });
  });

  it('sin términos, los candidatos son los que cumplen los filtros', () => {
    const { candidatos, modo } = combinarCandidatos(0, [], [], new Set(['2025|X', '2026|Y']), null, P, null);
    expect(modo).toBe('sin_terminos');
    expect(candidatos.map((c) => c.a)).toEqual(['2026', '2025']);
  });

  it('cuenta los documentos sin expediente aparte, sin listarlos', () => {
    const { candidatos, sinExpediente } = combinarCandidatos(1, [fila(1, null, null, 4), fila(1, '2026', 'A', 1)], [], null, null, P, null);
    expect(sinExpediente).toBe(4);
    expect(candidatos).toHaveLength(1);
  });
});

describe('etiquetaCoincidencia', () => {
  it('dice qué término coincidió dónde, sin repetir en contenido lo que ya está en el asunto', () => {
    const c = { a: '2026', s: 'A', n: 2 as const, dm: 1, dc: 3, r: true, t: 2, bm: 0b01, bc: 0b11 };
    expect(etiquetaCoincidencia(c, ['Huancavelica', 'controversia'])).toBe(
      'remitente · asunto: Huancavelica · contenido: controversia',
    );
  });
});

describe('terminosDelPlan / terminosDeConsulta', () => {
  it('deduplica sin distinguir tildes ni mayúsculas', () => {
    const plan = { ...planDeRespaldo('x'), terminos: { obligatorios: ['Junín', 'junin', 'controversia'], opcionales: [] } };
    expect(terminosDelPlan(plan)).toEqual(['Junín', 'controversia']);
  });

  it('sin términos del modelo, usa las palabras con contenido de la consulta', () => {
    const plan = planDeRespaldo('dame todos los expedientes del alquiler de computadoras para el in house');
    expect(terminosDelPlan(plan)).toEqual(['alquiler', 'computadoras', 'house']);
    expect(terminosDeConsulta('¿Cuántos expedientes hay de Junín?')).toEqual(['junin']);
  });
});
