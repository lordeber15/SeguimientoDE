import fs from 'fs';
import path from 'path';
import { z } from 'zod';

/**
 * Evaluación del RAG (docs/PLAN-RAG-AVANZADO.md, Fase 1): esquema del dataset y métricas
 * DETERMINISTAS de recuperación. Las métricas con LLM (faithfulness, answer relevancy, context
 * precision/recall) las calcula Ragas en el contenedor `rag-evals` sobre el JSON que exporta
 * `src/scripts/evaluarRag.ts`; aquí solo lo que se puede medir sin juez, que es rápido, gratis y
 * reproducible — lo que debe frenar un cambio en CI.
 *
 * "Relevante" se define por ETIQUETAS del caso, no por un LLM: un fragmento es relevante si sale de
 * uno de los documentos esperados (por sha256 de su contenido, resuelto al cargar) y, si el caso
 * trae `evidencias`, además contiene alguna de esas frases literales. Así un documento de 80 páginas
 * no cuenta como acierto con cualquier fragmento suyo.
 */

export const DIR_EVALS = path.resolve(__dirname, '../../../evals');

export const MODULOS = ['sgd', 'std'] as const;
export type ModuloEval = (typeof MODULOS)[number];

export const TIPOS_CASO = ['factual', 'jerga', 'compuesta', 'codigo', 'seguimiento', 'resumen', 'sin_respuesta'] as const;

const documentoSgd = z.object({
  nuAnn: z.string(),
  nuEmi: z.string(),
  /** Ausente = cualquier archivo de ese documento (principal o anexos). */
  nuAne: z.number().int().optional(),
});

const documentoStd = z.union([
  z.object({ idAdjunto: z.number().int() }),
  /** Todos los adjuntos de ese N° STD. */
  z.object({ idDocumento: z.number().int() }),
]);

const esquemaCaso = z.object({
  id: z.string().min(1),
  pregunta: z.string().min(1),
  /** Turnos previos (seguimiento de conversación): los recibe el planificador y la respuesta. */
  historial: z.array(z.object({ rol: z.enum(['user', 'assistant']), contenido: z.string() })).default([]),
  /** SGD: chat "por expediente". STD: chat "por documento". Ausente = búsqueda general. */
  expediente: z.object({ nuAnnExp: z.string(), nuSecExp: z.string() }).optional(),
  idDocumento: z.number().int().optional(),
  ground_truth: z.string().min(1),
  relevantes: z
    .object({
      documentos: z.array(z.union([documentoSgd, documentoStd])).default([]),
      evidencias: z.array(z.string().min(3)).default([]),
    })
    .default({ documentos: [], evidencias: [] }),
  /** La respuesta correcta es "no está en la base de conocimiento". */
  sin_respuesta: z.boolean().default(false),
  tipo: z.enum(TIPOS_CASO).default('factual'),
  origen: z.enum(['sintetico', 'historial', 'manual']).default('manual'),
  /** Solo los revisados por una persona entran a la corrida (salvo `--incluir-borradores`). */
  revisado: z.boolean().default(false),
  nota: z.string().optional(),
});

export type CasoRag = z.infer<typeof esquemaCaso>;
export type DocumentoEsperadoSgd = z.infer<typeof documentoSgd>;
export type DocumentoEsperadoStd = z.infer<typeof documentoStd>;

export const esquemaArchivoCasos = z.object({
  modulo: z.enum(MODULOS),
  casos: z.array(esquemaCaso),
});

export function rutaCasos(modulo: ModuloEval): string {
  return path.join(DIR_EVALS, `casos.${modulo}.json`);
}

export function cargarCasos(archivo: string): { modulo: ModuloEval; casos: CasoRag[] } {
  const crudo: unknown = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  const r = esquemaArchivoCasos.safeParse(crudo);
  if (!r.success) {
    const detalle = r.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`${archivo} no cumple el esquema de casos: ${detalle}`);
  }
  const ids = new Set<string>();
  for (const c of r.data.casos) {
    if (ids.has(c.id)) throw new Error(`${archivo}: id de caso repetido "${c.id}"`);
    ids.add(c.id);
  }
  return r.data;
}

/** Sin tildes, minúsculas y espacios colapsados: el OCR y el Markdown no respetan ni lo uno ni lo otro. */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[*_`#|>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface FragmentoEvaluado {
  sha256: string;
  texto: string;
}

export interface EtiquetasResueltas {
  /** sha256 de los documentos esperados; vacío = el caso no etiqueta documentos. */
  shas: Set<string>;
  /** Evidencias ya normalizadas. */
  evidencias: string[];
}

export function esRelevante(f: FragmentoEvaluado, et: EtiquetasResueltas): boolean {
  if (et.shas.size === 0 && et.evidencias.length === 0) return false;
  if (et.shas.size > 0 && !et.shas.has(f.sha256)) return false;
  if (et.evidencias.length === 0) return true;
  const t = normalizar(f.texto);
  return et.evidencias.some((e) => t.includes(e));
}

export interface MetricasCaso {
  /** Hay etiquetas de recuperación: si no, las métricas de recuperación no aplican al caso. */
  etiquetado: boolean;
  /** Algún relevante entre los candidatos fusionados por RRF (top-N, antes del rerank). */
  hitN: number | null;
  /** Algún relevante en el contexto final que ve el modelo (top-K, tras rerank y presupuesto). */
  hitK: number | null;
  /** 1 / posición del primer relevante en el contexto final; 0 si no hay. */
  mrr: number | null;
  /** Fracción del contexto final que es relevante. */
  precisionK: number | null;
  /** Fracción de las evidencias del caso presentes en el contexto final. */
  recallEvidencias: number | null;
  /** Casos `sin_respuesta`: 1 si se abstuvo. Casos normales: 1 si se abstuvo SIN deber (falso negativo). */
  abstencionCorrecta: number | null;
  abstencionIndebida: number | null;
  marcadoresAlucinados: number;
  contextos: number;
}

/** El mensaje que el prompt de sistema exige cuando el dato no está (y su versión fija sin resultados). */
const PATRON_ABSTENCION = /no (esta|se encuentra|figura) en la base de conocimiento|no encontre informacion/;

export function seAbstuvo(respuesta: string | null): boolean {
  return respuesta !== null && PATRON_ABSTENCION.test(normalizar(respuesta));
}

export function calcularMetricasCaso(datos: {
  caso: CasoRag;
  etiquetas: EtiquetasResueltas;
  candidatos: FragmentoEvaluado[];
  contexto: FragmentoEvaluado[];
  /** `null` = corrida sin generación (`--sin-generacion`). */
  respuesta: string | null;
  marcadoresAlucinados: number;
}): MetricasCaso {
  const { caso, etiquetas, candidatos, contexto, respuesta } = datos;
  const etiquetado = !caso.sin_respuesta && (etiquetas.shas.size > 0 || etiquetas.evidencias.length > 0);

  let hitN: number | null = null;
  let hitK: number | null = null;
  let mrr: number | null = null;
  let precisionK: number | null = null;
  let recallEvidencias: number | null = null;

  if (etiquetado) {
    hitN = candidatos.some((f) => esRelevante(f, etiquetas)) ? 1 : 0;
    const posicion = contexto.findIndex((f) => esRelevante(f, etiquetas));
    hitK = posicion >= 0 ? 1 : 0;
    mrr = posicion >= 0 ? 1 / (posicion + 1) : 0;
    precisionK = contexto.length > 0 ? contexto.filter((f) => esRelevante(f, etiquetas)).length / contexto.length : 0;
    if (etiquetas.evidencias.length > 0) {
      const textos = contexto.map((f) => normalizar(f.texto));
      const halladas = etiquetas.evidencias.filter((e) => textos.some((t) => t.includes(e))).length;
      recallEvidencias = halladas / etiquetas.evidencias.length;
    }
  }

  const abstuvo = respuesta === null ? null : seAbstuvo(respuesta);
  return {
    etiquetado,
    hitN,
    hitK,
    mrr,
    precisionK,
    recallEvidencias,
    abstencionCorrecta: abstuvo === null || !caso.sin_respuesta ? null : abstuvo ? 1 : 0,
    abstencionIndebida: abstuvo === null || caso.sin_respuesta ? null : abstuvo ? 1 : 0,
    marcadoresAlucinados: datos.marcadoresAlucinados,
    contextos: contexto.length,
  };
}

const CLAVES_PROMEDIO = [
  'hitN', 'hitK', 'mrr', 'precisionK', 'recallEvidencias', 'abstencionCorrecta', 'abstencionIndebida',
] as const;
export type MetricaAgregada = (typeof CLAVES_PROMEDIO)[number];

export interface MetricasAgregadas {
  promedios: Partial<Record<MetricaAgregada, number>>;
  /** Cuántos casos aportaron a cada promedio (una métrica con n=2 no dice mucho). */
  n: Partial<Record<MetricaAgregada, number>>;
  marcadoresAlucinados: number;
  errores: number;
  msPromedio: number;
}

export function agregarMetricas(
  resultados: { metricas: MetricasCaso | null; ms: number; error: string | null }[],
): MetricasAgregadas {
  const promedios: MetricasAgregadas['promedios'] = {};
  const n: MetricasAgregadas['n'] = {};
  const validos = resultados.filter((r) => r.metricas !== null).map((r) => r.metricas!);
  for (const clave of CLAVES_PROMEDIO) {
    const valores = validos.map((m) => m[clave]).filter((v): v is number => v !== null);
    if (valores.length > 0) {
      promedios[clave] = valores.reduce((a, b) => a + b, 0) / valores.length;
      n[clave] = valores.length;
    }
  }
  return {
    promedios,
    n,
    marcadoresAlucinados: validos.reduce((a, m) => a + m.marcadoresAlucinados, 0),
    errores: resultados.filter((r) => r.error !== null).length,
    msPromedio: Math.round(resultados.reduce((a, r) => a + r.ms, 0) / Math.max(resultados.length, 1)),
  };
}

/** Métricas en las que MÁS es mejor; `abstencionIndebida` es al revés. */
const MAS_ES_MEJOR: Record<MetricaAgregada, boolean> = {
  hitN: true, hitK: true, mrr: true, precisionK: true, recallEvidencias: true,
  abstencionCorrecta: true, abstencionIndebida: false,
};

export interface Regresion { metrica: string; base: number; actual: number }

/**
 * Métricas que empeoraron más de `tolerancia` (en puntos absolutos, 0,05 = 5 pts) respecto de la
 * línea base. Solo compara las que existen en ambas corridas. Sirve igual para las de Ragas
 * (todas "más es mejor").
 */
export function detectarRegresiones(
  base: Record<string, number>,
  actual: Record<string, number>,
  tolerancia = 0.05,
): Regresion[] {
  const regresiones: Regresion[] = [];
  for (const [metrica, valorBase] of Object.entries(base)) {
    const valorActual = actual[metrica];
    if (typeof valorBase !== 'number' || typeof valorActual !== 'number') continue;
    const masEsMejor = MAS_ES_MEJOR[metrica as MetricaAgregada] ?? true;
    const caida = masEsMejor ? valorBase - valorActual : valorActual - valorBase;
    if (caida > tolerancia) regresiones.push({ metrica, base: valorBase, actual: valorActual });
  }
  return regresiones;
}
