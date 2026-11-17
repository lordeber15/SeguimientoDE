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

function doc(nu_emi: string, es_doc_emi: string, es_eli = '0', quien: Partial<Record<
  'ti_emi' | 'emisor_empleado' | 'remitente_externo' | 'remitente_doc' | 'registrado_por', string | null
>> = {}) {
  return {
    nu_ann: '2024', nu_emi, nu_ann_exp: '2024', nu_sec_exp: '0001', numero_sgd: null,
    titulo: 'OFICIO', tipo_doc: 'OFICIO', co_tip_doc: '001', asunto: null, fe_emi: null,
    co_dep_emi: '10', de_dep_emi: 'OTI',
    ti_emi: '01', emisor_empleado: 'PEREZ GOMEZ ANA', remitente_externo: null, remitente_doc: null,
    registrado_por: null,
    ...quien,
    es_eli, es_doc_emi,
  };
}

function montarMocks(documentos: ReturnType<typeof doc>[], noIndexablesSgd: { nu_ann: string; nu_emi: string }[] = []) {
  const insertados: string[][] = [];
  const bindsInsert: unknown[][] = [];
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
      bindsInsert.push(opts.bind ?? []);
      return (opts.bind?.[1] as string[]).map(() => ({ inserted: true }));
    }
    if (sql.includes('UPDATE rag.documento SET vigente = false')) {
      bajas.push(opts.bind?.[1] as string[]);
      return (opts.bind?.[1] as string[]).map(() => ({ id: 1, nu_ann_exp: '2024', nu_sec_exp: '0001' }));
    }
    return [];
  });

  return { insertados, bindsInsert, bajas };
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

describe('barrer — emisor y remitente externo', () => {
  beforeEach(() => {
    sgdQuery.mockReset();
    appQuery.mockReset();
  });

  it('persiste ti_emi, emisor, remitente, documento y registrador en el upsert', async () => {
    const { bindsInsert } = montarMocks([
      doc('001', '4'),
      doc('002', '4', '0', {
        ti_emi: '02', emisor_empleado: null, remitente_externo: 'CHINA CIVIL ENGINEERING',
        remitente_doc: '20604269009', registrado_por: 'CABREJOS PIO VLADIMIR',
      }),
    ]);

    await barrer('watermark', 'manual');

    const bind = bindsInsert[0];
    expect(bind[12]).toEqual(['01', '02']);                              // ti_emi
    expect(bind[13]).toEqual(['PEREZ GOMEZ ANA', null]);                 // emisor_empleado
    expect(bind[14]).toEqual([null, 'CHINA CIVIL ENGINEERING']);         // remitente_externo
    expect(bind[15]).toEqual([null, '20604269009']);                     // remitente_doc
    expect(bind[16]).toEqual([null, 'CABREJOS PIO VLADIMIR']);           // registrado_por
  });

  it('el upsert refresca los nuevos campos de un documento ya inventariado', async () => {
    montarMocks([doc('001', '4')]);
    await barrer('watermark', 'manual');

    const sqlInsert = appQuery.mock.calls.map((c) => c[0] as string).find((s) => s.includes('INSERT INTO rag.documento'))!;
    for (const col of ['ti_emi', 'emisor_empleado', 'remitente_externo', 'remitente_doc', 'registrado_por']) {
      expect(sqlInsert).toContain(`${col} = EXCLUDED.${col}`);
    }
  });
});
