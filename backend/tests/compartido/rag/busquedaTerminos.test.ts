/**
 * Partes de la búsqueda por términos compartidas por el SGD y el STD que se agregaron en la
 * Fase 7 (el resto se prueba desde `busquedaExpedientesService.test.ts`, que las reexporta).
 */
jest.mock('../../../src/compartido/config/appDatabase', () => ({ appSequelize: { query: jest.fn() } }));
jest.mock('../../../src/compartido/rag/configService', () => ({ leerNumero: jest.fn(), leerConfig: jest.fn() }));

import { planConFiltros, terminosDelPlan, terminosExplicitos } from '../../../src/compartido/rag/busquedaTerminos';
import { planDeRespaldo, type PlanConsulta } from '../../../src/compartido/rag/planificadorService';
import { textoListado, UNIDAD_DOCUMENTO_STD } from '../../../src/compartido/rag/textosListado';

const plan = (obligatorios: string[], opcionales: string[] = [], consulta = 'x'): PlanConsulta =>
  ({ ...planDeRespaldo(consulta), terminos: { obligatorios, opcionales } });

describe('terminosExplicitos', () => {
  it('no cae a las palabras de la consulta (a diferencia de terminosDelPlan)', () => {
    const p = plan([], [], 'consulta sobre el último documento del contrato');
    expect(terminosExplicitos(p)).toEqual([]);
    expect(terminosDelPlan(p).length).toBeGreaterThan(0);
  });

  it('usa los opcionales si no hay obligatorios, sin genéricos', () => {
    expect(terminosExplicitos(plan(['proyectos'], ['in house']))).toEqual(['in house']);
  });
});

describe('palabra "contrato" junto a un número de contrato', () => {
  it('se descarta: el número ya lo identifica', () => {
    expect(terminosDelPlan(plan(['contrato', '227-2022-MCEBS']))).toEqual(['227-2022-MCEBS']);
    expect(terminosExplicitos(plan(['Contratos', '0227 - 2022 - MCEBS']))).toEqual(['0227 - 2022 - MCEBS']);
  });

  it('sin número, "contrato" es un término como cualquiera', () => {
    expect(terminosDelPlan(plan(['monto', 'contrato', 'Junín']))).toEqual(['monto', 'contrato', 'Junín']);
  });
});

describe('planConFiltros', () => {
  it('cualquier filtro cuenta; "actual" no (no acota por sí solo qué documentos son)', () => {
    const base = planDeRespaldo('x');
    expect(planConFiltros(base)).toBe(false);
    expect(planConFiltros({ ...base, filtros: { ...base.filtros, remitente: 'China Civil' } })).toBe(true);
    expect(planConFiltros({ ...base, filtros: { ...base.filtros, actual: true } })).toBe(false);
  });
});

describe('textoListado con la unidad del STD', () => {
  it('habla de documentos y de sus archivos', () => {
    const t = textoListado('contar', planDeRespaldo('x'), {
      total: 742, nivel1: 484, nivel2: 258, modoTerminos: 'todos', terminos: ['Junín'], sinExpediente: 0, truncado: false,
    }, 3, { enTramite: 135, archivados: 607, sinDato: 0 }, undefined, undefined, UNIDAD_DOCUMENTO_STD);
    expect(t).toBe('Hay 742 documentos relacionados con «Junín». 484 coinciden con todos los términos en sus datos '
      + '(asunto, remitente, tipo o contrato) y 258 lo mencionan solo dentro del contenido de sus archivos. '
      + '135 siguen en trámite y 607 están archivados.');
  });
});
