jest.mock('../../src/config/database', () => ({
  DB_SCHEMA: 'idosgd',
  sequelize: { query: jest.fn() },
}));

import { sequelize } from '../../src/config/database';
import { getExpedientesPorUsuario, getUsuariosPorDependencia } from '../../src/services/seguimientoService';

const mockQuery = sequelize.query as jest.Mock;

function sqlEjecutado(): string {
  return mockQuery.mock.calls[0][0] as string;
}

function bindsEjecutados(): unknown[] {
  return (mockQuery.mock.calls[0][1] as { bind: unknown[] }).bind;
}

describe('getExpedientesPorUsuario', () => {
  beforeEach(() => mockQuery.mockResolvedValue([]));

  // El servicio recibe (dependencia, empleado) pero el SQL usa $1=empleado y $2=dependencia.
  // Invertirlos no rompe nada visiblemente: devuelve cero filas. Por eso se fija aquí.
  it('vincula $1 al empleado y $2 a la dependencia', async () => {
    await getExpedientesPorUsuario('00009', '00003');

    expect(bindsEjecutados()).toEqual(['00003', '00009']);
  });

  it('filtra por el empleado destinatario y por la dependencia del destino', async () => {
    await getExpedientesPorUsuario('00009', '00003');
    const sql = sqlEjecutado();

    expect(sql).toContain('d.co_emp_des = $1');
    expect(sql).toContain('d.co_dep_des = $2');
  });

  it('excluye documentos eliminados y estados que no circularon', async () => {
    await getExpedientesPorUsuario('00009', '00003');
    const sql = sqlEjecutado();

    expect(sql).toContain("d.es_eli = '0'");
    expect(sql).toContain("a.es_eli = '0'");
    expect(sql).toContain("a.es_doc_emi NOT IN ('5','7','8','9')");
  });

  it('deja una sola fila por expediente, quedándose con la participación más reciente', async () => {
    await getExpedientesPorUsuario('00009', '00003');
    const sql = sqlEjecutado();

    expect(sql).toContain('PARTITION BY p.nu_ann_exp, p.nu_sec_exp');
    expect(sql).toContain('ORDER BY p.fe_envio DESC');
    expect(sql).toContain('WHERE rn = 1');
  });

  it('empareja cada recepción con la primera emisión posterior del mismo expediente', async () => {
    await getExpedientesPorUsuario('00009', '00003');
    const sql = sqlEjecutado();

    expect(sql).toContain('e.nu_ann_exp = r.nu_ann_exp');
    expect(sql).toContain('e.fe_emi >= r.fe_envio');
    expect(sql).toContain('ORDER BY e.fe_emi\n        LIMIT 1');
  });

  // El cronómetro arranca cuando se lo enviaron (A.FE_EMI), no cuando lo abrió (D.FE_REC_DOC).
  it('mide el tiempo desde fe_envio y devuelve las dos variantes de duración', async () => {
    await getExpedientesPorUsuario('00009', '00003');
    const sql = sqlEjecutado();

    expect(sql).toContain('a.fe_emi      AS fe_envio');
    expect(sql).toContain('EXTRACT(EPOCH FROM (u.fe_respuesta - u.fe_envio))::int');
    expect(sql).toContain('"segundosCorridos"');
    expect(sql).toContain('"segundosHabiles"');
    expect(sql).toContain('EXTRACT(ISODOW FROM g.dia) IN (6, 7)');
  });

  it('devuelve las fechas como texto sin zona horaria', async () => {
    await getExpedientesPorUsuario('00009', '00003');
    const sql = sqlEjecutado();

    expect(sql).toContain(`to_char(u.fe_envio,     'YYYY-MM-DD HH24:MI:SS')`);
    expect(sql).toContain(`to_char(u.fe_respuesta, 'YYYY-MM-DD HH24:MI:SS')`);
  });
});

describe('getUsuariosPorDependencia', () => {
  beforeEach(() => mockQuery.mockResolvedValue([]));

  it('une destinatarios y emisores de la dependencia, sin códigos vacíos', async () => {
    await getUsuariosPorDependencia('00009');
    const sql = sqlEjecutado();

    expect(bindsEjecutados()).toEqual(['00009']);
    expect(sql).toContain('d.co_dep_des = $1');
    expect(sql).toContain('a.co_dep_emi = $1');
    expect(sql).toContain("COALESCE(d.co_emp_des, '') <> ''");
    expect(sql).toContain('UNION');
  });
});
