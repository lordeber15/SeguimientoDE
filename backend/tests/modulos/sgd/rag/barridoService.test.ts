/**
 * Qué documentos del SGD entran al corpus: los ANULADOS ('9') y EN PROYECTO ('5') no se indexan,
 * igual que los borrados (`es_eli='1'`). Se aísla con mocks que responden según el SQL, sin fijar
 * el orden de las consultas — lo que importa es qué se inserta y qué se da de baja.
 */

const sgdQuery = jest.fn();
const appQuery = jest.fn();

jest.mock('../../../../src/modulos/sgd/config/database', () => ({
  DB_SCHEMA: 'sgd',
  sequelize: { query: (...a: unknown[]) => sgdQuery(...a) },
}));

jest.mock('../../../../src/compartido/config/appDatabase', () => ({
  appSequelize: { query: (...a: unknown[]) => appQuery(...a) },
}));

jest.mock('../../../../src/compartido/rag/configService', () => ({
  leerBooleano: jest.fn(),
  leerNumero: jest.fn(),
}));

import { barrer } from '../../../../src/modulos/sgd/rag/barridoService';

type Bind = { bind?: unknown[] };

function doc(nu_emi: string, es_doc_emi: string, es_eli = '0') {
  return {
    nu_ann: '2024', nu_emi, nu_ann_exp: '2024', nu_sec_exp: '0001', numero_sgd: null,
    titulo: 'OFICIO', tipo_doc: 'OFICIO', co_tip_doc: '001', asunto: null, fe_emi: null,
    co_dep_emi: '10', de_dep_emi: 'OTI', es_eli, es_doc_emi,
  };
}

function montarMocks(documentos: ReturnType<typeof doc>[], noIndexablesSgd: { nu_ann: string; nu_emi: string }[] = []) {
  const insertados: string[][] = [];
  const bajas: string[][] = [];

  sgdQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('GROUP BY 1, 2')) {
      return [{ nu_ann_exp: '2024', nu_sec_exp: '0001', doc_count: String(documentos.length), watermark: 'w1' }];
    }
    if (sql.includes('unnest($1::text[]), unnest($2::text[])')) return documentos;
    if (sql.includes('ANY($1::text[])')) return noIndexablesSgd;
    throw new Error(`SQL SGD inesperado: ${sql}`);
  });

  appQuery.mockImplementation(async (sql: string, opts: Bind = {}) => {
    if (sql.includes('pg_try_advisory_lock')) return [{ ok: true }];
    if (sql.includes('INSERT INTO rag.barrido')) return [{ id: 1 }];
    if (sql.includes('FROM rag.expediente')) return [];
    if (sql.includes('INSERT INTO rag.documento')) {
      insertados.push(opts.bind?.[1] as string[]);
      return (opts.bind?.[1] as string[]).map(() => ({ inserted: true }));
    }
    if (sql.includes('UPDATE rag.documento SET vigente = false')) {
      bajas.push(opts.bind?.[1] as string[]);
      return (opts.bind?.[1] as string[]).map(() => ({ id: 1, nu_ann_exp: '2024', nu_sec_exp: '0001' }));
    }
    return [];
  });

  return { insertados, bajas };
}

describe('barrer — estados no indexables', () => {
  beforeEach(() => {
    sgdQuery.mockReset();
    appQuery.mockReset();
  });

  it('inserta solo los emitidos; anulados, en proyecto y borrados van a bajas', async () => {
    const { insertados, bajas } = montarMocks([
      doc('001', '4'),        // emitido → entra
      doc('002', '9'),        // anulado
      doc('003', '5'),        // en proyecto
      doc('004', '4', '1'),   // borrado lógico
    ]);

    const r = await barrer('watermark', 'manual');

    expect(insertados).toEqual([['001']]);
    expect(bajas[0]).toEqual(['002', '003', '004']);
    expect(r.documentosNuevos).toBe(1);
  });

  it('la reconciliación da de baja los ya inventariados aunque su expediente no cambió', async () => {
    const { bajas } = montarMocks([], [{ nu_ann: '2023', nu_emi: '777' }]);

    const r = await barrer('watermark', 'manual');

    expect(bajas).toEqual([['777']]);
    expect(r.documentosBaja).toBe(1);
  });
});
