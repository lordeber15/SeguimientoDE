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
  limpiarTermino,
  prepararTerminos,
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

  it('en el nivel 2, los que tienen los términos juntos en un fragmento van antes aunque puntúen menos', () => {
    // X: muchos fragmentos de cada término por separado (un informe que repasa diez obras).
    // Y: pocos, pero en un mismo fragmento.
    const contenido = [fila(1, '2026', 'X', 40), fila(2, '2026', 'X', 40), fila(1, '2026', 'Y', 1), fila(2, '2026', 'Y', 1)];
    const juntos = new Map([['2026|Y', 1]]);

    const { candidatos } = combinarCandidatos(2, [], contenido, null, null, P, null, 0, juntos);

    expect(candidatos.map((c) => [c.s, c.j])).toEqual([['Y', 1], ['X', undefined]]);
  });

  it('"juntos" no altera el nivel 1', () => {
    const meta = [fila(1, '2026', 'A', 1), fila(2, '2026', 'A', 1)];
    const contenido = [fila(1, '2026', 'B', 1), fila(2, '2026', 'B', 1)];
    const { candidatos } = combinarCandidatos(2, meta, contenido, null, null, P, null, 0, new Map([['2026|B', 3]]));
    expect(candidatos.map((c) => [c.s, c.n])).toEqual([['A', 1], ['B', 2]]);
  });
});

describe('etiquetaCoincidencia', () => {
  it('dice qué término coincidió dónde, sin repetir en contenido lo que ya está en el asunto', () => {
    const c = { a: '2026', s: 'A', n: 2 as const, dm: 1, dc: 3, r: true, t: 2, bm: 0b01, bc: 0b11 };
    expect(etiquetaCoincidencia(c, ['Huancavelica', 'controversia'])).toBe(
      'remitente · asunto: Huancavelica · contenido: controversia',
    );
  });

  it('dice en cuántos fragmentos aparecen juntos', () => {
    const c = { a: '2026', s: 'A', n: 2 as const, dm: 0, dc: 3, r: false, t: 2, bm: 0, bc: 0b11, j: 2 };
    expect(etiquetaCoincidencia(c, ['controversia', 'Junín'])).toBe('contenido: controversia, Junín · juntos en 2 fragmentos');
  });
});

describe('limpiarTermino', () => {
  it('quita las palabras genéricas de los extremos y conserva las del medio', () => {
    expect(limpiarTermino('proyectos in house')).toBe('in house');
    expect(limpiarTermino('obra Junín')).toBe('Junín');
    expect(limpiarTermino('alquiler de computadoras')).toBe('alquiler de computadoras');
    expect(limpiarTermino('  China Civil ')).toBe('China Civil');
  });

  it('null si no queda nada con contenido', () => {
    expect(limpiarTermino('proyectos')).toBeNull();
    expect(limpiarTermino('los expedientes')).toBeNull();
  });
});

describe('prepararTerminos', () => {
  const p = {
    sinonimos: { alquiler: ['arrendamiento'], computadoras: ['equipos de cómputo', 'computadora'] },
    frasesEstandar: ['solución de controversias', 'no existe controversia', 'cláusula de penalidades'],
  };

  it('une el término con sus sinónimos (config y planificador), sin repetir ni pasarse del tope', () => {
    const plan = {
      ...planDeRespaldo('x'),
      terminos: { obligatorios: [], opcionales: [], sinonimos: { Alquiler: ['ALQUILER', 'renta'] } },
    };
    const r = prepararTerminos(['alquiler', 'Computadoras', 'Junín'], plan, p);
    expect(r.etiquetas).toEqual(['alquiler', 'Computadoras', 'Junín']);
    expect(r.consultas).toEqual(['alquiler|arrendamiento|renta', 'Computadoras|equipos de cómputo|computadora', 'Junín']);
  });

  it('asigna a cada término solo las frases estándar que lo contienen', () => {
    const r = prepararTerminos(['controversia', 'Huancavelica', 'penalidad'], null, p);
    expect(r.exclusiones).toEqual(['solución de controversias|no existe controversia', '', 'cláusula de penalidades']);
  });

  it('un "|" dentro de un término no puede romper las alternativas', () => {
    expect(prepararTerminos(['a|b'], null, { sinonimos: {}, frasesEstandar: [] }).consultas).toEqual(['a b']);
  });
});

describe('terminosDelPlan / terminosDeConsulta', () => {
  it('quita palabras genéricas que el planificador dejó y, si no queda nada, cae a la consulta', () => {
    const conGenerico = { ...planDeRespaldo('x'), terminos: { obligatorios: ['proyectos', 'in house'], opcionales: [] } };
    expect(terminosDelPlan(conGenerico)).toEqual(['in house']);

    const soloGenerico = { ...planDeRespaldo('expedientes de Puno'), terminos: { obligatorios: ['expedientes'], opcionales: [] } };
    expect(terminosDelPlan(soloGenerico)).toEqual(['puno']);
  });

  it('la consulta de respaldo no arrastra verbos como "presentó"', () => {
    expect(terminosDelPlan(planDeRespaldo('cual es el ultimo documento que presento china civil'))).toEqual(['china', 'civil']);
  });

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
