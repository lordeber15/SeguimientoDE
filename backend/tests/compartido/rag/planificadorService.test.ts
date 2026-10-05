/**
 * El planificador decide el camino de cada pregunta, así que lo que se verifica es su tolerancia:
 * cualquier salida rara del modelo debe terminar en un plan utilizable (o en el respaldo
 * `contenido`), nunca en una excepción ni en un cierre indebido.
 */
import {
  extraerJson,
  interpretarPlan,
  planificar,
  planDeRespaldo,
} from '../../../src/compartido/rag/planificadorService';
import type { ChatProvider } from '../../../src/compartido/ai/types';

function proveedor(texto: string | Error): ChatProvider & { responder: jest.Mock } {
  return {
    nombre: 'openai',
    modelo: 'gpt-4o-mini',
    comprobar: jest.fn(),
    responder: jest.fn(() => (texto instanceof Error
      ? Promise.reject(texto)
      : Promise.resolve({ texto, uso: { tokensIn: 300, tokensOut: 50, estimado: false } }))),
  };
}

describe('extraerJson', () => {
  it('acepta el JSON envuelto en ```json y con texto alrededor', () => {
    expect(extraerJson('Claro:\n```json\n{"a":1}\n```\nlisto')).toEqual({ a: 1 });
  });

  it('no se confunde con llaves dentro de cadenas', () => {
    expect(extraerJson('{"consulta":"obra {Junín}","x":2} sobra')).toEqual({ consulta: 'obra {Junín}', x: 2 });
  });

  it('devuelve null sin objeto o con JSON roto', () => {
    expect(extraerJson('no hay nada')).toBeNull();
    expect(extraerJson('{"a":')).toBeNull();
  });
});

describe('interpretarPlan', () => {
  it('normaliza un plan completo', () => {
    const plan = interpretarPlan(JSON.stringify({
      intencion: 'listar',
      consulta: 'expedientes donde China Civil presentó documentos',
      terminos: { obligatorios: [' China Civil '], opcionales: [] },
      filtros: { remitente: 'China Civil', tipo_doc: null, actual: false },
      continua_anterior: false,
    }), 'x');

    expect(plan).toEqual({
      intencion: 'listar',
      consulta: 'expedientes donde China Civil presentó documentos',
      terminos: { obligatorios: ['China Civil'], opcionales: [], sinonimos: {} },
      filtros: { remitente: 'China Civil', emisor: null, dependencia: null, tipoDoc: null, desde: null, hasta: null, actual: false },
      continuaAnterior: false,
    });
  });

  it('con campos ausentes o en null usa valores neutros y la consulta original', () => {
    const plan = interpretarPlan('{"intencion":"contar","consulta":"  ","filtros":null}', '¿cuántos de Junín?');
    expect(plan?.intencion).toBe('contar');
    expect(plan?.consulta).toBe('¿cuántos de Junín?');
    expect(plan?.terminos).toEqual({ obligatorios: [], opcionales: [], sinonimos: {} });
    expect(plan?.filtros.actual).toBe(false);
  });

  it('sinónimos: conserva las listas de textos y descarta lo mal formado sin invalidar el plan', () => {
    const plan = interpretarPlan(JSON.stringify({
      intencion: 'listar',
      terminos: {
        obligatorios: ['alquiler'],
        sinonimos: { alquiler: ['arrendamiento', 3, ' '], computadoras: 'equipos', ' ': ['x'], vacio: [] },
      },
    }), 'x');
    expect(plan?.terminos.sinonimos).toEqual({ alquiler: ['arrendamiento'] });

    const raro = interpretarPlan('{"intencion":"listar","terminos":{"obligatorios":["a"],"sinonimos":"no"}}', 'x');
    expect(raro?.terminos).toEqual({ obligatorios: ['a'], opcionales: [], sinonimos: {} });
  });

  it('rechaza una intención desconocida', () => {
    expect(interpretarPlan('{"intencion":"resumir"}', 'x')).toBeNull();
  });
});

describe('planificar', () => {
  const ctx = { modo: 'general' as const, historial: [] };

  it('devuelve el plan del modelo y su uso de tokens', async () => {
    const prov = proveedor('{"intencion":"fuera_de_alcance","consulta":"capital de Francia"}');
    const r = await planificar(prov, '¿capital de Francia?', ctx);

    expect(r.respaldo).toBe(false);
    expect(r.plan.intencion).toBe('fuera_de_alcance');
    expect(r.uso?.tokensIn).toBe(300);
  });

  it('respuesta no interpretable → respaldo "contenido" con la pregunta tal cual', async () => {
    const r = await planificar(proveedor('Lo siento, no puedo.'), 'monto del contrato', ctx);
    expect(r.respaldo).toBe(true);
    expect(r.plan).toEqual(planDeRespaldo('monto del contrato'));
    expect(r.diagnostico).toContain('Lo siento, no puedo.');
  });

  it('proveedor caído → respaldo, sin lanzar', async () => {
    const r = await planificar(proveedor(new Error('timeout')), 'monto', ctx);
    expect(r.respaldo).toBe(true);
    expect(r.uso).toBeNull();
    expect(r.diagnostico).toContain('timeout');
  });

  it('envía el historial recortado y la nota de modo expediente', async () => {
    const prov = proveedor('{"intencion":"contenido"}');
    const largo = 'x'.repeat(1000);
    await planificar(prov, '¿y el último?', {
      modo: 'expediente',
      historial: [{ rol: 'user', contenido: 'expedientes de Huancavelica' }, { rol: 'assistant', contenido: largo }],
    });

    const [mensajes] = prov.responder.mock.calls[0];
    expect(mensajes[0].contenido).toMatch(/UN expediente o documento/);
    expect(mensajes[1].contenido).toContain('Usuario: expedientes de Huancavelica');
    expect(mensajes[1].contenido).toContain('Pregunta nueva: ¿y el último?');
    expect(mensajes[1].contenido.length).toBeLessThan(600); // el turno largo se recorta
  });
});
