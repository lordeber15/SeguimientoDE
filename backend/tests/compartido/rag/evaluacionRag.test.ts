/**
 * Métricas deterministas de la evaluación del RAG (docs/PLAN-RAG-AVANZADO.md, Fase 1). Son las que
 * frenan un cambio en CI, así que un error aquí aprobaría regresiones reales o bloquearía mejoras.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  agregarMetricas,
  calcularMetricasCaso,
  cargarCasos,
  detectarRegresiones,
  esRelevante,
  normalizar,
  seAbstuvo,
  type CasoRag,
  type EtiquetasResueltas,
} from '../../../src/compartido/rag/evaluacionRag';

const caso = (extra: Partial<CasoRag> = {}): CasoRag => ({
  id: 'c1',
  pregunta: '¿Cuál es el monto del contrato?',
  historial: [],
  ground_truth: 'S/ 120 000',
  relevantes: { documentos: [], evidencias: [] },
  sin_respuesta: false,
  tipo: 'factual',
  origen: 'manual',
  revisado: true,
  ...extra,
});

const et = (shas: string[], evidencias: string[] = []): EtiquetasResueltas => ({
  shas: new Set(shas),
  evidencias: evidencias.map(normalizar),
});

describe('normalizar', () => {
  it('quita tildes, mayúsculas, marcas de Markdown y espacios repetidos', () => {
    expect(normalizar('  **Monto  CONTRACTUAL**:\n S/ 120 000  ')).toBe('monto contractual : s/ 120 000');
    expect(normalizar('Resolución Jefatural')).toBe('resolucion jefatural');
  });
});

describe('esRelevante', () => {
  const f = { sha256: 'A', texto: 'El monto contractual asciende a S/ 120 000.' };

  it('sin etiquetas, nada es relevante', () => {
    expect(esRelevante(f, et([]))).toBe(false);
  });

  it('solo documento: cualquier fragmento de ese documento', () => {
    expect(esRelevante(f, et(['A']))).toBe(true);
    expect(esRelevante(f, et(['B']))).toBe(false);
  });

  it('documento + evidencia: exige ambas', () => {
    expect(esRelevante(f, et(['A'], ['MONTO contractual asciende']))).toBe(true);
    expect(esRelevante(f, et(['A'], ['plazo de ejecución']))).toBe(false);
    expect(esRelevante(f, et(['B'], ['monto contractual']))).toBe(false);
  });

  it('solo evidencia: vale desde cualquier documento (contenido duplicado entre documentos)', () => {
    expect(esRelevante(f, et([], ['s/ 120 000']))).toBe(true);
  });
});

describe('calcularMetricasCaso', () => {
  const rel = { sha256: 'A', texto: 'monto contractual de S/ 120 000' };
  const ruido = { sha256: 'Z', texto: 'otra cosa' };

  it('calcula hit@N, hit@K, MRR, precisión y recall de evidencias', () => {
    const m = calcularMetricasCaso({
      caso: caso({ relevantes: { documentos: [], evidencias: ['x'] } }),
      etiquetas: et(['A'], ['monto contractual', 'plazo de 90 días']),
      candidatos: [ruido, rel],
      contexto: [ruido, rel, ruido, ruido],
      respuesta: 'El monto es S/ 120 000 [D2].',
      marcadoresAlucinados: 0,
    });
    expect(m.etiquetado).toBe(true);
    expect(m.hitN).toBe(1);
    expect(m.hitK).toBe(1);
    expect(m.mrr).toBe(0.5);
    expect(m.precisionK).toBe(0.25);
    expect(m.recallEvidencias).toBe(0.5);
    expect(m.abstencionIndebida).toBe(0);
    expect(m.abstencionCorrecta).toBeNull();
  });

  it('relevante entre candidatos pero perdido por el rerank/presupuesto: hit@N=1, hit@K=0', () => {
    const m = calcularMetricasCaso({
      caso: caso(), etiquetas: et(['A']), candidatos: [ruido, rel], contexto: [ruido],
      respuesta: null, marcadoresAlucinados: 0,
    });
    expect([m.hitN, m.hitK, m.mrr, m.precisionK]).toEqual([1, 0, 0, 0]);
    expect(m.recallEvidencias).toBeNull();
    expect(m.abstencionIndebida).toBeNull(); // sin generación
  });

  it('sin etiquetas: las métricas de recuperación no aplican', () => {
    const m = calcularMetricasCaso({
      caso: caso(), etiquetas: et([]), candidatos: [rel], contexto: [rel], respuesta: 'x', marcadoresAlucinados: 0,
    });
    expect(m.etiquetado).toBe(false);
    expect(m.hitK).toBeNull();
  });

  it('sin_respuesta: mide la abstención, no la recuperación', () => {
    const base = { etiquetas: et(['A']), candidatos: [rel], contexto: [rel], marcadoresAlucinados: 0 };
    const ok = calcularMetricasCaso({
      ...base, caso: caso({ sin_respuesta: true }), respuesta: 'Ese dato no está en la base de conocimiento.',
    });
    expect(ok.etiquetado).toBe(false);
    expect(ok.abstencionCorrecta).toBe(1);
    const mal = calcularMetricasCaso({ ...base, caso: caso({ sin_respuesta: true }), respuesta: 'Son S/ 5.' });
    expect(mal.abstencionCorrecta).toBe(0);
  });
});

describe('seAbstuvo', () => {
  it('reconoce la frase del prompt y el mensaje fijo de sin resultados', () => {
    expect(seAbstuvo('Ese dato no está en la base de conocimiento. Sí encontré…')).toBe(true);
    expect(seAbstuvo('No encontré información sobre eso en la base de conocimiento.')).toBe(true);
    expect(seAbstuvo('El monto es S/ 120 000.')).toBe(false);
    expect(seAbstuvo(null)).toBe(false);
  });
});

describe('agregarMetricas', () => {
  it('promedia cada métrica solo sobre los casos donde aplica y cuenta errores', () => {
    const m = (hitK: number | null) => calcularMetricasCaso({
      caso: caso(), etiquetas: hitK === null ? et([]) : et(['A']),
      candidatos: [], contexto: hitK ? [{ sha256: 'A', texto: '' }] : [], respuesta: null, marcadoresAlucinados: 1,
    });
    const a = agregarMetricas([
      { metricas: m(1), ms: 100, error: null },
      { metricas: m(0), ms: 300, error: null },
      { metricas: m(null), ms: 200, error: null },
      { metricas: null, ms: 400, error: 'boom' },
    ]);
    expect(a.promedios.hitK).toBe(0.5);
    expect(a.n.hitK).toBe(2);
    expect(a.errores).toBe(1);
    expect(a.marcadoresAlucinados).toBe(3);
    expect(a.msPromedio).toBe(250);
  });
});

describe('detectarRegresiones', () => {
  it('marca caídas mayores a la tolerancia y respeta las métricas donde menos es mejor', () => {
    const r = detectarRegresiones(
      { hitK: 0.8, mrr: 0.6, abstencionIndebida: 0.1, faithfulness: 0.9 },
      { hitK: 0.7, mrr: 0.58, abstencionIndebida: 0.2, faithfulness: 0.95, nueva: 0.1 },
    );
    expect(r.map((x) => x.metrica).sort()).toEqual(['abstencionIndebida', 'hitK']);
  });
});

describe('cargarCasos', () => {
  const escribir = (contenido: unknown) => {
    const archivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eval-')), 'casos.json');
    fs.writeFileSync(archivo, JSON.stringify(contenido));
    return archivo;
  };

  it('aplica valores por defecto', () => {
    const { casos } = cargarCasos(escribir({ modulo: 'sgd', casos: [{ id: 'a', pregunta: 'p', ground_truth: 'g' }] }));
    expect(casos[0]).toMatchObject({ revisado: false, sin_respuesta: false, relevantes: { documentos: [], evidencias: [] } });
  });

  it('rechaza ids repetidos y archivos fuera de esquema', () => {
    const repetido = { id: 'a', pregunta: 'p', ground_truth: 'g' };
    expect(() => cargarCasos(escribir({ modulo: 'sgd', casos: [repetido, repetido] }))).toThrow(/repetido/);
    expect(() => cargarCasos(escribir({ modulo: 'otro', casos: [] }))).toThrow(/esquema/);
  });
});
