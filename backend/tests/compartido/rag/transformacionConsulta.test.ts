/**
 * Transformaciones de la consulta (docs/PLAN-RAG-AVANZADO.md, Fase 4): vocabulario de dominio antes de
 * embeber, HyDE con el modelo rápido, y la fusión RRF de las búsquedas de cada subconsulta.
 */

const leerBooleano = jest.fn();
jest.mock('../../../src/compartido/rag/configService', () => ({
  leerBooleano: (...a: unknown[]) => leerBooleano(...a),
}));
jest.mock('../../../src/compartido/config/appDatabase', () => ({ appSequelize: {} }));

import {
  combinarBusquedas,
  expandirConVocabulario,
  fusionarListas,
  generarHyde,
  transformacionesDelTurno,
  filtrosDocumentoDelPlan,
  hayFiltrosDocumento,
  sqlFiltrosDocumento,
} from '../../../src/compartido/rag/transformacionConsulta';
import { planDeRespaldo } from '../../../src/compartido/rag/planificadorService';
import type { ChatProvider } from '../../../src/compartido/ai/types';

const SINONIMOS = {
  alquiler: ['arrendamiento'],
  computadoras: ['equipos de cómputo', 'equipo de cómputo'],
  'equipos de computo': ['computadoras'],
  'in house': ['inhouse'],
};

describe('expandirConVocabulario', () => {
  it('añade las formas oficiales de la jerga, sin tildes ni mayúsculas en la coincidencia', () => {
    expect(expandirConVocabulario('Alquiler de COMPUTADORAS para el in house', SINONIMOS))
      // Claves más largas primero: "computadoras" (12) antes que "alquiler" (8) e "in house" (8).
      .toBe('Alquiler de COMPUTADORAS para el in house (equipos de cómputo; equipo de cómputo; arrendamiento; inhouse)');
  });

  it('solo palabras completas: "alquileres" no es "alquiler", "computadorasx" tampoco', () => {
    expect(expandirConVocabulario('alquileres de computadorasx', SINONIMOS)).toBe('alquileres de computadorasx');
  });

  it('no repite lo que la consulta ya dice', () => {
    expect(expandirConVocabulario('arrendamiento o alquiler de oficinas', SINONIMOS)).toBe('arrendamiento o alquiler de oficinas');
  });

  it('sin coincidencias devuelve la consulta intacta', () => {
    expect(expandirConVocabulario('monto del contrato', SINONIMOS)).toBe('monto del contrato');
    expect(expandirConVocabulario('monto del contrato', {})).toBe('monto del contrato');
  });

  it('acota las alternativas para no diluir el embedding', () => {
    const muchos = { plazo: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'] };
    expect(expandirConVocabulario('plazo', muchos)).toBe('plazo (a1; a2; a3; a4; a5; a6)');
  });
});

const chunk = (chunkId: number, sha256 = `s${chunkId}`) => ({ chunkId, sha256, score: 0 });

describe('fusionarListas', () => {
  it('lo que aparece en varias listas sube; a igual puntaje, el orden de aparición', () => {
    const r = fusionarListas([[chunk(1), chunk(2), chunk(3)], [chunk(3), chunk(4)]], { limite: 10, topePorDocumento: 3 });
    // 3: 1/63 + 1/61 · 1: 1/61 · 2 y 4: 1/62 (empate: gana 2, que apareció antes).
    expect(r.map((c) => c.chunkId)).toEqual([3, 1, 2, 4]);
    expect(r[0].score).toBeCloseTo(1 / 63 + 1 / 61);
  });

  it('respeta el límite y el tope por documento', () => {
    const lista = [chunk(1, 'a'), chunk(2, 'a'), chunk(3, 'a'), chunk(4, 'a'), chunk(5, 'b'), chunk(6, 'c')];
    const r = fusionarListas([lista], { limite: 4, topePorDocumento: 2 });
    expect(r.map((c) => c.chunkId)).toEqual([1, 2, 5, 6]);
  });
});

describe('combinarBusquedas', () => {
  const busqueda = (ids: number[], extra: object = {}) => ({
    chunks: ids.map((id) => chunk(id)), candidatosVec: 10, candidatosFts: 5, escaneoExacto: false,
    degradacionVectorial: null as string | null, ...extra,
  });

  it('con una sola búsqueda la devuelve tal cual', () => {
    const b = busqueda([1, 2]);
    expect(combinarBusquedas([b], { limite: 20, topePorDocumento: 3 })).toEqual({ ...b, subconsultas: 0 });
  });

  it('con subconsultas fusiona por RRF, suma cifras y arrastra degradación y escaneo exacto', () => {
    const r = combinarBusquedas(
      [busqueda([1, 2]), busqueda([3], { escaneoExacto: true }), busqueda([2], { degradacionVectorial: 'sin modelo' })],
      { limite: 20, topePorDocumento: 3 },
    );
    expect(r.chunks[0].chunkId).toBe(2);
    expect(r.chunks.map((c) => c.chunkId).sort()).toEqual([1, 2, 3]);
    expect(r).toMatchObject({ candidatosVec: 30, candidatosFts: 15, escaneoExacto: true, degradacionVectorial: 'sin modelo', subconsultas: 2 });
  });
});

function proveedor(responder: ChatProvider['responder']): ChatProvider {
  return { nombre: 'ollama', modelo: 'qwen-mini', responder, comprobar: jest.fn() };
}

describe('generarHyde', () => {
  it('devuelve el párrafo y su uso', async () => {
    const parrafo = 'Mediante el presente se aplica una penalidad de S/ 12 500,00 por 10 días calendario de atraso.';
    const responder = jest.fn().mockResolvedValue({ texto: `  ${parrafo}\n`, uso: { tokensIn: 50, tokensOut: 40, estimado: false } });

    const r = await generarHyde(proveedor(responder), '¿qué penalidad se aplicó?');

    expect(r).toEqual({ texto: parrafo, uso: { tokensIn: 50, tokensOut: 40, estimado: false } });
    expect(responder.mock.calls[0][0][1]).toEqual({ rol: 'user', contenido: '¿qué penalidad se aplicó?' });
  });

  it('null si el modelo falla o devuelve casi nada: HyDE nunca rompe el retrieval', async () => {
    expect(await generarHyde(proveedor(jest.fn().mockRejectedValue(new Error('caído'))), 'q')).toBeNull();
    expect(await generarHyde(proveedor(jest.fn().mockResolvedValue({ texto: 'No sé.', uso: { tokensIn: 1, tokensOut: 1, estimado: false } })), 'q')).toBeNull();
  });
});

describe('transformacionesDelTurno', () => {
  const rapido = proveedor(jest.fn());
  const plan = { ...planDeRespaldo('x'), subconsultas: ['a', 'b'] };

  beforeEach(() => leerBooleano.mockReset());

  it('con los interruptores encendidos: subconsultas del plan, HyDE con el modelo rápido y vocabulario', async () => {
    leerBooleano.mockResolvedValue(true);
    expect(await transformacionesDelTurno(plan, rapido, SINONIMOS)).toEqual({ sinonimos: SINONIMOS, subconsultas: ['a', 'b'], hyde: rapido, filtrosDoc: null });
  });

  it('apagados: solo vocabulario', async () => {
    leerBooleano.mockResolvedValue(false);
    expect(await transformacionesDelTurno(plan, rapido, SINONIMOS)).toEqual({ sinonimos: SINONIMOS, subconsultas: [], hyde: null, filtrosDoc: null });
  });

  it('sin plan confiable no hay subconsultas ni HyDE aunque estén encendidos', async () => {
    leerBooleano.mockResolvedValue(true);
    expect(await transformacionesDelTurno(null, rapido, SINONIMOS)).toEqual({ sinonimos: SINONIMOS, subconsultas: [], hyde: null, filtrosDoc: null });
  });

  it('lee los interruptores con sus valores por defecto: HyDE apagado, descomposición encendida', async () => {
    leerBooleano.mockImplementation((_c: string, porDefecto: boolean) => Promise.resolve(porDefecto));
    expect(await transformacionesDelTurno(plan, rapido, {})).toEqual({ sinonimos: {}, subconsultas: ['a', 'b'], hyde: null, filtrosDoc: null });
  });
});

describe('filtros del plan en la búsqueda de contenido', () => {
  const conFiltros = (filtros: Partial<ReturnType<typeof planDeRespaldo>['filtros']>) => {
    const plan = planDeRespaldo('x');
    return { ...plan, filtros: { ...plan.filtros, ...filtros } };
  };

  it('sin plan o sin filtros: null', () => {
    expect(filtrosDocumentoDelPlan(null)).toBeNull();
    expect(filtrosDocumentoDelPlan(planDeRespaldo('x'))).toBeNull();
  });

  it('"actual" no es un filtro de documento y las fechas mal formadas se descartan', () => {
    expect(filtrosDocumentoDelPlan(conFiltros({ actual: true, desde: 'marzo' }))).toBeNull();
  });

  it('copia tipo, fechas y quién', () => {
    expect(filtrosDocumentoDelPlan(conFiltros({ tipoDoc: 'INFORME', desde: '2026-03-01', hasta: '2026-03-31' })))
      .toEqual({ remitente: null, emisor: null, dependencia: null, tipoDoc: 'INFORME', desde: '2026-03-01', hasta: '2026-03-31' });
  });

  it('arma las condiciones en orden, con binds desde el índice pedido', () => {
    const f = filtrosDocumentoDelPlan(conFiltros({ tipoDoc: 'INFORME', hasta: '2026-03-31' }));
    const r = sqlFiltrosDocumento(f, 8, {
      remitente: (n) => `r = $${n}`,
      emisor: (n) => `e = $${n}`,
      dependencia: (n) => `d = $${n}`,
      tipoDoc: (n) => `t = $${n}`,
      desde: (n) => `f >= $${n}`,
      hasta: (n) => `f <= $${n}`,
    });
    expect(r).toEqual({ sql: 'AND (t = $8) AND (f <= $9)', binds: ['INFORME', '2026-03-31'] });
    expect(hayFiltrosDocumento(f)).toBe(true);
  });

  it('sin filtros no añade nada', () => {
    expect(sqlFiltrosDocumento(null, 3, {} as never)).toEqual({ sql: '', binds: [] });
    expect(hayFiltrosDocumento(null)).toBe(false);
  });

  it('transformacionesDelTurno pasa los filtros del plan', async () => {
    leerBooleano.mockResolvedValue(false);
    const t = await transformacionesDelTurno(conFiltros({ tipoDoc: 'OFICIO' }), proveedor(jest.fn()), {});
    expect(t.filtrosDoc?.tipoDoc).toBe('OFICIO');
  });
});
