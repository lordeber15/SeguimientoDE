import type { MensajeChat } from '../ai/types';
import type { Intencion, PlanConsulta } from './planificadorService';
import casosJson from './casosPlanificador.json';

/**
 * Set de evaluación del planificador (docs/PLAN-CHAT-CONSULTAS.md, Fase 6): qué se espera de cada
 * pregunta de prueba y la comparación con el plan obtenido. Lo usan `src/scripts/evaluarPlanificador.ts`
 * (contra el modelo real, varias repeticiones: el planificador no es determinista) y los tests.
 */

export interface EsperadoPlan {
  intencion?: Intencion | Intencion[];
  /** Deben quedar entre los términos finales (tras quitar palabras genéricas). */
  terminos?: string[];
  /** No deben quedar entre los términos finales. */
  sinTerminos?: string[];
  remitente?: string;
  dependencia?: string;
  actual?: boolean;
  continua?: boolean;
}

export interface CasoPlanificador {
  id: string;
  pregunta: string;
  modo: 'general' | 'expediente';
  historial: MensajeChat[];
  esperado: EsperadoPlan;
}

interface CasoCrudo {
  id: string;
  pregunta: string;
  modo?: 'general' | 'expediente';
  historial?: string;
  esperado: EsperadoPlan;
}

export function casosPlanificador(): CasoPlanificador[] {
  const historiales = casosJson.historiales as Record<string, MensajeChat[]>;
  return (casosJson.casos as CasoCrudo[]).map((c) => ({
    id: c.id,
    pregunta: c.pregunta,
    modo: c.modo ?? 'general',
    historial: c.historial ? historiales[c.historial] : [],
    esperado: c.esperado,
  }));
}

const normal = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
/** "controversia" ≈ "controversias", "computadora" ≈ "computadoras": basta que uno contenga al otro. */
const parecido = (a: string, b: string) => normal(a).includes(normal(b)) || normal(b).includes(normal(a));

/**
 * Qué falla del plan respecto de lo esperado ([] = correcto). `terminosFinales` = los términos con
 * los que de verdad se busca (`terminosDelPlan`), que es lo que importa, no la salida cruda.
 */
export function compararPlan(plan: PlanConsulta, terminosFinales: string[], esperado: EsperadoPlan): string[] {
  const fallas: string[] = [];
  if (esperado.intencion) {
    const validas = Array.isArray(esperado.intencion) ? esperado.intencion : [esperado.intencion];
    if (!validas.includes(plan.intencion)) fallas.push(`intencion=${plan.intencion} (esperada ${validas.join('|')})`);
  }
  for (const t of esperado.terminos ?? []) {
    if (!terminosFinales.some((f) => parecido(f, t))) fallas.push(`falta término "${t}"`);
  }
  for (const t of esperado.sinTerminos ?? []) {
    if (terminosFinales.some((f) => normal(f).split(/\s+/).some((w) => parecido(w, t)))) fallas.push(`sobra término "${t}"`);
  }
  if (esperado.remitente && !(plan.filtros.remitente && parecido(plan.filtros.remitente, esperado.remitente))) {
    fallas.push(`remitente=${plan.filtros.remitente ?? 'null'} (esperado "${esperado.remitente}")`);
  }
  if (esperado.dependencia) {
    const enDependencia = plan.filtros.dependencia && parecido(plan.filtros.dependencia, esperado.dependencia);
    if (!enDependencia) fallas.push(`dependencia=${plan.filtros.dependencia ?? 'null'} (esperada "${esperado.dependencia}")`);
  }
  if (esperado.actual !== undefined && plan.filtros.actual !== esperado.actual) fallas.push(`actual=${plan.filtros.actual}`);
  if (esperado.continua !== undefined && plan.continuaAnterior !== esperado.continua) fallas.push(`continua=${plan.continuaAnterior}`);
  return fallas;
}
