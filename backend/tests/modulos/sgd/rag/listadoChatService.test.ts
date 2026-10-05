jest.mock('../../../../src/compartido/config/appDatabase', () => ({ appSequelize: { query: jest.fn() } }));
jest.mock('../../../../src/modulos/sgd/config/database', () => ({ DB_SCHEMA: 'sgd', sequelize: { query: jest.fn() } }));
jest.mock('../../../../src/compartido/rag/configService', () => ({ leerNumero: jest.fn() }));

import { esMetaListado, resumenTabla, textoListado } from '../../../../src/modulos/sgd/rag/listadoChatService';
import { planDeRespaldo } from '../../../../src/compartido/rag/planificadorService';

const busqueda = (over = {}) => ({
  total: 58, nivel1: 3, nivel2: 55, modoTerminos: 'todos' as const,
  terminos: ['controversia', 'Huancavelica'], sinExpediente: 0, truncado: false, ...over,
});

describe('textoListado', () => {
  it('listar: total, criterio y los dos niveles', () => {
    const t = textoListado('listar', planDeRespaldo('x'), busqueda(), 3);
    expect(t).toContain('Encontré 58 expedientes relacionados con «controversia» + «Huancavelica».');
    expect(t).toContain('3 coinciden directamente');
    expect(t).toContain('55 lo mencionan solo dentro del contenido');
  });

  it('contar con filtros, "actual" y desglose de estados', () => {
    const plan = { ...planDeRespaldo('x'), filtros: { ...planDeRespaldo('x').filtros, remitente: 'China Civil', actual: true } };
    const t = textoListado('contar', plan, busqueda({ total: 1, nivel1: 1, nivel2: 0, terminos: [] }), 3,
      { enTramite: 1, archivados: 0, sinDato: 0 });
    expect(t).toContain('Hay 1 expediente con documentos remitidos por «China Civil» con movimiento en los últimos 3 meses.');
    expect(t).toContain('1 sigue en trámite y 0 están archivados');
    expect(t).not.toContain('coincide directamente'); // sin términos no hay niveles que explicar
  });

  it('avisa el modo "alguno", el truncado y los documentos sin expediente', () => {
    const t = textoListado('listar', planDeRespaldo('x'), busqueda({ modoTerminos: 'alguno', truncado: true, sinExpediente: 2 }), 3);
    expect(t).toMatch(/^Ningún expediente cumple todos los términos/);
    expect(t).toContain('precise la búsqueda');
    expect(t).toContain('2 documentos sin expediente mencionan');
  });
});

describe('meta del listado', () => {
  const meta = {
    version: 1 as const, plan: planDeRespaldo('x'), busqueda: busqueda(),
    expedientes: Array.from({ length: 12 }, (_, i) => ({ a: '2026', s: String(i), n: 1 as const, dm: 0, dc: 0, r: false, t: 1, bm: 1, bc: 0 })),
  };

  it('reconoce una meta válida y rechaza otras', () => {
    expect(esMetaListado(meta)).toBe(true);
    expect(esMetaListado({ motivo: 'sin_resultados' })).toBe(false);
    expect(esMetaListado(null)).toBe(false);
  });

  it('el resumen para el historial no trae filas y avisa que hay qué cargar', () => {
    expect(resumenTabla(meta)).toMatchObject({ filas: [], pagina: 0, total: 12, hayMas: true, porPagina: 10 });
  });
});
