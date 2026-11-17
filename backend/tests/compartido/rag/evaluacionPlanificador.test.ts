/**
 * El set de evaluación del planificador se corre contra el modelo real con
 * `npm run eval:planificador`; aquí se prueba lo determinista: que el set sea válido y que la
 * comparación juzgue bien.
 */
import { casosPlanificador, compararPlan } from '../../../src/compartido/rag/evaluacionPlanificador';
import { INTENCIONES, planDeRespaldo, type PlanConsulta } from '../../../src/compartido/rag/planificadorService';

const plan = (over: Partial<PlanConsulta> = {}, filtros: Partial<PlanConsulta['filtros']> = {}): PlanConsulta => ({
  ...planDeRespaldo('x'),
  ...over,
  filtros: { ...planDeRespaldo('x').filtros, ...filtros },
});

describe('casosPlanificador', () => {
  it('ids únicos, intenciones válidas e historiales resueltos', () => {
    const casos = casosPlanificador();
    expect(casos.length).toBeGreaterThanOrEqual(20);
    expect(new Set(casos.map((c) => c.id)).size).toBe(casos.length);
    for (const c of casos) {
      const intenciones = [c.esperado.intencion ?? []].flat();
      for (const i of intenciones) expect(INTENCIONES).toContain(i);
      expect(Array.isArray(c.historial)).toBe(true);
    }
    expect(casos.find((c) => c.id === 'cambio_tema')?.historial.length).toBeGreaterThan(0);
  });
});

describe('compararPlan', () => {
  it('acepta términos parecidos (plural, tildes) y lista solo lo que falla', () => {
    const p = plan({ intencion: 'listar' });
    expect(compararPlan(p, ['controversias', 'Junín'], { intencion: 'listar', terminos: ['controversia', 'junin'] })).toEqual([]);
    expect(compararPlan(p, ['Junín'], { intencion: 'contar', terminos: ['controversia'] })).toEqual([
      'intencion=listar (esperada contar)',
      'falta término "controversia"',
    ]);
  });

  it('detecta términos que sobran, por palabra', () => {
    expect(compararPlan(plan(), ['proyectos in house'], { sinTerminos: ['proyecto'] })).toEqual(['sobra término "proyecto"']);
    expect(compararPlan(plan(), ['in house'], { sinTerminos: ['proyecto'] })).toEqual([]);
  });

  it('filtros, actual y continuación', () => {
    const p = plan({ continuaAnterior: true }, { remitente: 'CHINA CIVIL ENGINEERING', actual: true });
    expect(compararPlan(p, [], { remitente: 'china civil', actual: true, continua: true })).toEqual([]);
    expect(compararPlan(p, [], { dependencia: 'asesoria legal', continua: false })).toEqual([
      'dependencia=null (esperada "asesoria legal")',
      'continua=true',
    ]);
  });

  it('una lista de intenciones admite cualquiera de ellas', () => {
    expect(compararPlan(plan({ intencion: 'contenido' }), [], { intencion: ['participantes', 'contenido'] })).toEqual([]);
  });
});
