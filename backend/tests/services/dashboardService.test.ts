/**
 * `dashboardService.ts` consulta el espejo local (`dashboard.participacion`/`dashboard.emision`,
 * BD propia vía `appSequelize`) — no el SGD. Solo `tiposDocumento` sigue leyendo el SGD en vivo
 * (catálogo liviano, nunca fue el cuello de botella). Ver PLAN-DASHBOARD-DESEMPENO.md §5,
 * "hallazgo de rendimiento 2026-08-28", para el porqué del espejo.
 */
jest.mock('../../src/config/appDatabase', () => ({
  appSequelize: { query: jest.fn() },
}));
jest.mock('../../src/config/database', () => ({
  DB_SCHEMA: 'idosgd',
  sequelize: { query: jest.fn() },
}));

import { appSequelize } from '../../src/config/appDatabase';
import { sequelize } from '../../src/config/database';
import {
  desempenoPorEmpleado,
  desempenoPorOficina,
  pendientesAntiguosPorOficina,
  pendientesDetalleOficina,
  reiniciarCacheTiposDependenciaParaTests,
  tiposDocumento,
} from '../../src/services/dashboardService';

const mockAppQuery = appSequelize.query as jest.Mock;
const mockSgdQuery = sequelize.query as jest.Mock;

/** Cada función hace exactamente una consulta local, así que siempre es la primera del mock. */
function unicaLlamada(): [string, { bind: unknown[] }] {
  expect(mockAppQuery).toHaveBeenCalledTimes(1);
  return mockAppQuery.mock.calls[0];
}

/** Fase 6: `desempenoPorOficina`/`desempenoPorEmpleado` ahora también consultan (y cachean, ver
 *  `reiniciarCacheTiposDependenciaParaTests`) `esComite` contra el SGD — sin este reset y este
 *  valor por defecto, cada prueba heredaría la cache/el mock de la anterior. Vacío ⇒ todas las
 *  filas caen en `esComite: false` salvo que una prueba puntual configure otra cosa. */
beforeEach(() => {
  mockSgdQuery.mockReset().mockResolvedValue([]);
  reiniciarCacheTiposDependenciaParaTests();
});

/** Fila mínima que satisface `FilaKpi` — todo lo que `mapearFila` necesita convertir a número. */
function filaBase(extra: Record<string, unknown> = {}) {
  return {
    coDependencia: '00009', nombreDependencia: 'OGA-UL',
    recibidos: '0', recibidosExternos: '0', atendidos: '0',
    recibidosInformativos: '0', atendidosInformativos: '0',
    expedientesDistintos: '0', gruposEmpleadoExpediente: '0', gruposReprocesados: '0',
    emitidos: '0', anulados: '0',
    tiempoPromedioHoras: null, tiempoMedianoHoras: null, tiempoPromedioHabilHoras: null,
    productividadPonderada: '0', cargaPonderada: '0',
    ...extra,
  };
}

describe('desempeño — contra el espejo local (appSequelize), no el SGD', () => {
  beforeEach(() => mockAppQuery.mockReset().mockResolvedValue([]));

  it('desempenoPorOficina consulta dashboard.participacion, agrupado por oficina', async () => {
    await desempenoPorOficina({ desde: '2026-01-01', hasta: '2026-01-31' });

    const [sql] = unicaLlamada();
    expect(String(sql)).toContain('FROM dashboard.participacion');
    expect(String(sql)).toContain('GROUP BY p.co_dep_des');
    expect(String(sql)).not.toContain('"coEmpleado"');
  });

  it('desempenoPorEmpleado consulta dashboard.participacion, agrupado por empleado+oficina', async () => {
    await desempenoPorEmpleado({ desde: '2026-01-01', hasta: '2026-01-31' });

    const [sql] = unicaLlamada();
    expect(String(sql)).toContain('FROM dashboard.participacion');
    expect(String(sql)).toContain('"coEmpleado"');
    expect(String(sql)).toContain('GROUP BY p.co_emp_des, p.co_dep_des');
  });

  it('ambas tocan también el SGD (sequelize), para clasificar esComite vía rhtm_dependencia', async () => {
    await desempenoPorOficina({ desde: '2026-01-01', hasta: '2026-01-31' });
    await desempenoPorEmpleado({ desde: '2026-01-01', hasta: '2026-01-31' });

    expect(mockSgdQuery).toHaveBeenCalled();
    const [sql] = mockSgdQuery.mock.calls[0];
    expect(String(sql)).toContain('rhtm_dependencia');
  });
});

describe('desempeño — filtro y binds contra el espejo', () => {
  beforeEach(() => mockAppQuery.mockReset().mockResolvedValue([]));

  it('sin coDependencia ni tipoDocumento, solo bindea desde y hasta', async () => {
    await desempenoPorEmpleado({ desde: '2026-01-01', hasta: '2026-01-31' });

    const [sql, opts] = unicaLlamada();
    expect(opts.bind).toEqual(['2026-01-01', '2026-01-31']);
    expect(String(sql)).not.toContain('co_dep_des = $3');
    expect(String(sql)).not.toContain('co_tip_doc = $3');
  });

  it('con coDependencia, agrega la condición y la bindea en tercer lugar', async () => {
    await desempenoPorEmpleado({ desde: '2026-01-01', hasta: '2026-01-31', coDependencia: '00009' });

    const [sql, opts] = unicaLlamada();
    expect(opts.bind).toEqual(['2026-01-01', '2026-01-31', '00009']);
    expect(String(sql)).toContain('co_dep_des = $3');
  });

  it('con tipoDocumento, agrega la condición sobre co_tip_doc y la reutiliza en la anulación', async () => {
    await desempenoPorEmpleado({ desde: '2026-01-01', hasta: '2026-01-31', tipoDocumento: '232' });

    const [sql, opts] = unicaLlamada();
    expect(opts.bind).toEqual(['2026-01-01', '2026-01-31', '232']);
    const ocurrencias = String(sql).split('co_tip_doc = $3').length - 1;
    expect(ocurrencias).toBe(2); // una en `filtro`, otra en el CTE de anulación
  });

  it('la agregación por oficina recibe exactamente los mismos filtros y binds', async () => {
    await desempenoPorOficina({ desde: '2026-01-01', hasta: '2026-01-31', coDependencia: '00009' });

    const [sql, opts] = unicaLlamada();
    expect(opts.bind).toEqual(['2026-01-01', '2026-01-31', '00009']);
    expect(String(sql)).toContain('co_dep_des = $3');
  });
});

describe('Fase 9 — desde/hasta opcionales e independientes (sin fecha = todo el histórico)', () => {
  beforeEach(() => mockAppQuery.mockReset().mockResolvedValue([]));

  it('sin desde ni hasta, no bindea ninguna fecha y el WHERE cae a "true"', async () => {
    await desempenoPorOficina({});

    const [sql, opts] = unicaLlamada();
    expect(opts.bind).toEqual([]);
    expect(String(sql)).toContain('FROM dashboard.participacion WHERE true');
    expect(String(sql)).not.toContain('fe_envio');
  });

  it('solo con desde, el rango queda abierto hacia adelante (sin condición de hasta)', async () => {
    await desempenoPorOficina({ desde: '2026-01-01' });

    const [sql, opts] = unicaLlamada();
    expect(opts.bind).toEqual(['2026-01-01']);
    expect(String(sql)).toContain('fe_envio >= $1');
    expect(String(sql)).not.toContain('fe_envio <');
  });

  it('solo con hasta, el rango queda abierto hacia atrás (sin condición de desde)', async () => {
    await desempenoPorOficina({ hasta: '2026-01-31' });

    const [sql, opts] = unicaLlamada();
    expect(opts.bind).toEqual(['2026-01-31']);
    expect(String(sql)).toContain("fe_envio < $1::date + interval '1 day'");
    expect(String(sql)).not.toContain('fe_envio >=');
  });

  it('solo con hasta + coDependencia, coDependencia se bindea en segundo lugar (posición dinámica)', async () => {
    await desempenoPorEmpleado({ hasta: '2026-01-31', coDependencia: '00009' });

    const [sql, opts] = unicaLlamada();
    expect(opts.bind).toEqual(['2026-01-31', '00009']);
    expect(String(sql)).toContain('co_dep_des = $2');
  });

  it('el CTE de anulación reusa exactamente los mismos binds de fecha que el filtro principal, sin duplicarlos', async () => {
    await desempenoPorOficina({ desde: '2026-01-01', tipoDocumento: '232' });

    const [sql, opts] = unicaLlamada();
    // desde=$1, tipoDocumento=$2 — ambos reusados tal cual en el CTE de anulación.
    expect(opts.bind).toEqual(['2026-01-01', '232']);
    expect(String(sql)).toContain('fe_emi >= $1');
    expect(String(sql)).not.toContain('fe_emi <');
    const ocurrenciasTipoDoc = String(sql).split('co_tip_doc = $2').length - 1;
    expect(ocurrenciasTipoDoc).toBe(2); // una en `filtro`, otra en el CTE de anulación
  });

  it('sin ningún filtro puesto, el CTE de anulación no lleva WHERE', async () => {
    await desempenoPorOficina({});

    const [sql] = unicaLlamada();
    expect(String(sql)).toMatch(/FROM dashboard\.emision\s+GROUP BY/);
  });
});

describe('Fase 2 — reproceso y anulación siguen calculándose igual, ahora sobre el espejo', () => {
  beforeEach(() => mockAppQuery.mockReset().mockResolvedValue([]));

  it('la ventana de reproceso (visitas_asunto) se calcula sobre el conjunto ya filtrado, por asunto', async () => {
    await desempenoPorEmpleado({ desde: '2026-01-01', hasta: '2026-01-31' });

    const [sql] = unicaLlamada();
    expect(String(sql)).toContain(
      'count(*) OVER (PARTITION BY co_emp_des, nu_ann_exp, nu_sec_exp, asunto_norm) AS visitas_asunto',
    );
  });

  /** `PARTITION BY` agrupa todos los NULL en una sola partición: sin este guard, las recepciones
   *  sin asunto de un mismo empleado y expediente se marcarían como reproceso entre sí. */
  it('una recepción sin asunto nunca cuenta como reproceso', async () => {
    await desempenoPorEmpleado({});

    const [sql] = unicaLlamada();
    expect(String(sql)).toContain(
      'FILTER (WHERE p.visitas_asunto > 1 AND p.asunto_norm IS NOT NULL)::text AS "gruposReprocesados"',
    );
  });

  it('el denominador del reproceso sigue siendo el par (empleado, expediente), sin el asunto', async () => {
    await desempenoPorOficina({});

    const [sql] = unicaLlamada();
    expect(String(sql)).toContain(
      'count(DISTINCT (p.co_emp_des, p.nu_ann_exp, p.nu_sec_exp))::text AS "gruposEmpleadoExpediente"',
    );
  });

  it('la anulación por oficina agrupa dashboard.emision por co_dep_emi', async () => {
    await desempenoPorOficina({ desde: '2026-01-01', hasta: '2026-01-31' });

    const [sql] = unicaLlamada();
    expect(String(sql)).toContain('FROM dashboard.emision');
    expect(String(sql)).toContain('GROUP BY co_dep_emi');
    expect(String(sql)).toContain('anu.co_dep_emi = p.co_dep_des');
  });

  it('la anulación por empleado agrupa dashboard.emision por co_emp_emi', async () => {
    await desempenoPorEmpleado({ desde: '2026-01-01', hasta: '2026-01-31' });

    const [sql] = unicaLlamada();
    expect(String(sql)).toContain('GROUP BY co_emp_emi');
    expect(String(sql)).toContain('anu.co_emp_emi = p.co_emp_des');
  });
});

describe('Fase 3 — productividad y carga ponderadas por complejidad', () => {
  beforeEach(() => mockAppQuery.mockReset().mockResolvedValue([]));

  it('desempenoPorOficina hace LEFT JOIN con dashboard.tipo_documento_peso por co_tip_doc', async () => {
    await desempenoPorOficina({ desde: '2026-01-01', hasta: '2026-01-31' });

    const [sql] = unicaLlamada();
    expect(String(sql)).toContain('LEFT JOIN dashboard.tipo_documento_peso peso ON peso.co_tip_doc = p.co_tip_doc');
    expect(String(sql)).toContain(
      'COALESCE(SUM(COALESCE(peso.peso, 1)) FILTER (WHERE NOT p.es_informativo AND p.atendido), 0)::text AS "productividadPonderada"',
    );
    expect(String(sql)).toContain(
      'COALESCE(SUM(COALESCE(peso.peso, 1)) FILTER (WHERE NOT p.es_informativo), 0)::text AS "cargaPonderada"',
    );
  });

  it('desempenoPorEmpleado hace el mismo LEFT JOIN', async () => {
    await desempenoPorEmpleado({ desde: '2026-01-01', hasta: '2026-01-31' });

    const [sql] = unicaLlamada();
    expect(String(sql)).toContain('LEFT JOIN dashboard.tipo_documento_peso peso ON peso.co_tip_doc = p.co_tip_doc');
  });

  it('sin pesos configurados (COALESCE a 1), productividadPonderada/cargaPonderada coinciden con atendidos/recibidos', async () => {
    mockAppQuery.mockResolvedValue([filaBase({
      recibidos: '10', atendidos: '7',
      productividadPonderada: '7', cargaPonderada: '10',
    })]);

    const [oficina] = await desempenoPorOficina({ desde: '2026-01-01', hasta: '2026-01-31' });

    expect(oficina.productividadPonderada).toBe(7);
    expect(oficina.cargaPonderada).toBe(10);
  });

  it('con pesos distintos de 1, redondea la suma ponderada a 2 decimales', async () => {
    mockAppQuery.mockResolvedValue([filaBase({
      productividadPonderada: '12.3456', cargaPonderada: '18.999',
    })]);

    const [oficina] = await desempenoPorOficina({ desde: '2026-01-01', hasta: '2026-01-31' });

    expect(oficina.productividadPonderada).toBe(12.35);
    expect(oficina.cargaPonderada).toBe(19);
  });
});

describe('Fase 6 — esComite, clasificado contra RHTM_DEPENDENCIA.TI_DEPENDENCIA', () => {
  beforeEach(() => mockAppQuery.mockReset().mockResolvedValue([]));

  it('una dependencia presente con esComite=true en el catálogo del SGD sale esComite:true', async () => {
    mockAppQuery.mockResolvedValue([filaBase({ coDependencia: '00022' })]);
    mockSgdQuery.mockResolvedValue([{ coDependencia: '00022', esComite: true }]);

    const [oficina] = await desempenoPorOficina({ desde: '2026-01-01', hasta: '2026-01-31' });

    expect(oficina.esComite).toBe(true);
  });

  it('una dependencia con esComite=false en el catálogo sale esComite:false', async () => {
    mockAppQuery.mockResolvedValue([filaBase({ coDependencia: '00002' })]);
    mockSgdQuery.mockResolvedValue([{ coDependencia: '00002', esComite: false }]);

    const [oficina] = await desempenoPorOficina({ desde: '2026-01-01', hasta: '2026-01-31' });

    expect(oficina.esComite).toBe(false);
  });

  it('una dependencia ausente del catálogo (no debería pasar) degrada a esComite:false, no undefined/throw', async () => {
    mockAppQuery.mockResolvedValue([filaBase({ coDependencia: '99999' })]);
    mockSgdQuery.mockResolvedValue([]);

    const [oficina] = await desempenoPorOficina({ desde: '2026-01-01', hasta: '2026-01-31' });

    expect(oficina.esComite).toBe(false);
  });

  it('desempenoPorEmpleado clasifica esComite por la coDependencia del empleado', async () => {
    mockAppQuery.mockResolvedValue([filaBase({ coEmpleado: '00123', coDependencia: '00022' })]);
    mockSgdQuery.mockResolvedValue([{ coDependencia: '00022', esComite: true }]);

    const [empleado] = await desempenoPorEmpleado({ desde: '2026-01-01', hasta: '2026-01-31' });

    expect(empleado.esComite).toBe(true);
  });

  it('cachea el catálogo en memoria: dos llamadas seguidas consultan el SGD una sola vez', async () => {
    mockSgdQuery.mockResolvedValue([{ coDependencia: '00022', esComite: true }]);

    await desempenoPorOficina({ desde: '2026-01-01', hasta: '2026-01-31' });
    await desempenoPorOficina({ desde: '2026-02-01', hasta: '2026-02-28' });

    expect(mockSgdQuery).toHaveBeenCalledTimes(1);
  });
});

describe('Fase 8 — recibidosExternos: distingue lo recibido de otra oficina de lo recibido de la propia', () => {
  beforeEach(() => mockAppQuery.mockReset().mockResolvedValue([]));

  it('desempenoPorOficina filtra por co_dep_emi IS DISTINCT FROM co_dep_des, no solo por igualdad', async () => {
    await desempenoPorOficina({ desde: '2026-01-01', hasta: '2026-01-31' });

    const [sql] = unicaLlamada();
    expect(String(sql)).toContain('p.co_dep_emi IS DISTINCT FROM p.co_dep_des');
    expect(String(sql)).toContain('AS "recibidosExternos"');
  });

  it('desempenoPorEmpleado hace el mismo filtro', async () => {
    await desempenoPorEmpleado({ desde: '2026-01-01', hasta: '2026-01-31' });

    const [sql] = unicaLlamada();
    expect(String(sql)).toContain('p.co_dep_emi IS DISTINCT FROM p.co_dep_des');
  });

  it('recibidosMismaOficina se calcula por resta: recibidos - recibidosExternos', async () => {
    mockAppQuery.mockResolvedValue([filaBase({ recibidos: '24', recibidosExternos: '6' })]);

    const [empleado] = await desempenoPorEmpleado({ desde: '2026-01-01', hasta: '2026-01-31' });

    expect(empleado.recibidos).toBe(24);
    expect(empleado.recibidosExternos).toBe(6);
    expect(empleado.recibidosMismaOficina).toBe(18);
  });

  it('con todo lo recibido externo (co_dep_emi siempre distinto), recibidosMismaOficina queda en 0', async () => {
    mockAppQuery.mockResolvedValue([filaBase({ recibidos: '9', recibidosExternos: '9' })]);

    const [oficina] = await desempenoPorOficina({ desde: '2026-01-01', hasta: '2026-01-31' });

    expect(oficina.recibidosMismaOficina).toBe(0);
  });
});

describe('desempeño — mapeo de filas (sin cambios respecto a Fase 2)', () => {
  beforeEach(() => mockAppQuery.mockReset());

  it('convierte recibidos/atendidos a número, calcula pendientes y tasaAtencion, y redondea los tiempos a 2 decimales', async () => {
    mockAppQuery.mockResolvedValue([filaBase({
      coEmpleado: '00123', nombreCompleto: 'JUAN PEREZ',
      recibidos: '10', atendidos: '7',
      tiempoPromedioHoras: 5400.456, tiempoMedianoHoras: 3600, tiempoPromedioHabilHoras: 5000.999,
    })]);

    const empleados = await desempenoPorEmpleado({ desde: '2026-01-01', hasta: '2026-01-31' });

    expect(empleados).toEqual([{
      coEmpleado: '00123', nombreCompleto: 'JUAN PEREZ',
      coDependencia: '00009', nombreDependencia: 'OGA-UL', esComite: false,
      recibidos: 10, recibidosExternos: 0, recibidosMismaOficina: 10, atendidos: 7, pendientes: 3, tasaAtencion: 0.7,
      tiempoPromedioHoras: 1.5, tiempoMedianoHoras: 1, tiempoPromedioHabilHoras: 1.39,
      recibidosInformativos: 0, atendidosInformativos: 0, pendientesInformativos: 0, tasaAtencionInformativos: 0,
      expedientesDistintos: 0, movimientos: 10, movimientosPromedioPorExpediente: null,
      gruposEmpleadoExpediente: 0, gruposReprocesados: 0, tasaReproceso: null,
      emitidos: 0, anulados: 0, tasaAnulacion: null,
      productividadPonderada: 0, cargaPonderada: 0,
    }]);
  });

  it('la fila de oficina se mapea igual, sin coEmpleado ni nombreCompleto', async () => {
    mockAppQuery.mockResolvedValue([filaBase({
      recibidos: '10', atendidos: '7',
      tiempoPromedioHoras: 5400.456, tiempoMedianoHoras: 3600, tiempoPromedioHabilHoras: 5000.999,
    })]);

    const oficinas = await desempenoPorOficina({ desde: '2026-01-01', hasta: '2026-01-31' });

    expect(oficinas).toEqual([{
      coDependencia: '00009', nombreDependencia: 'OGA-UL', esComite: false,
      recibidos: 10, recibidosExternos: 0, recibidosMismaOficina: 10, atendidos: 7, pendientes: 3, tasaAtencion: 0.7,
      tiempoPromedioHoras: 1.5, tiempoMedianoHoras: 1, tiempoPromedioHabilHoras: 1.39,
      recibidosInformativos: 0, atendidosInformativos: 0, pendientesInformativos: 0, tasaAtencionInformativos: 0,
      expedientesDistintos: 0, movimientos: 10, movimientosPromedioPorExpediente: null,
      gruposEmpleadoExpediente: 0, gruposReprocesados: 0, tasaReproceso: null,
      emitidos: 0, anulados: 0, tasaAnulacion: null,
      productividadPonderada: 0, cargaPonderada: 0,
    }]);
  });

  it('con recibidos > 0 pero ningún atendido, los tiempos quedan null en vez de 0 — nadie respondió, no hay nada que promediar', async () => {
    mockAppQuery.mockResolvedValue([filaBase({ recibidos: '4', atendidos: '0' })]);

    const oficinas = await desempenoPorOficina({ desde: '2026-01-01', hasta: '2026-01-31' });

    expect(oficinas[0]).toMatchObject({
      pendientes: 4,
      tasaAtencion: 0,
      tiempoPromedioHoras: null,
      tiempoMedianoHoras: null,
      tiempoPromedioHabilHoras: null,
    });
  });

  it('recibidosInformativos/atendidosInformativos se mapean en su propio bloque, sin mezclarse con recibidos/atendidos', async () => {
    mockAppQuery.mockResolvedValue([filaBase({
      recibidos: '6', atendidos: '5',
      recibidosInformativos: '4', atendidosInformativos: '1',
    })]);

    const [oficina] = await desempenoPorOficina({ desde: '2026-01-01', hasta: '2026-01-31' });

    expect(oficina).toMatchObject({
      recibidos: 6, atendidos: 5, pendientes: 1, tasaAtencion: 0.8333,
      recibidosInformativos: 4, atendidosInformativos: 1, pendientesInformativos: 3, tasaAtencionInformativos: 0.25,
      movimientos: 10,
    });
  });

  it('movimientosPromedioPorExpediente y tasaReproceso se calculan sobre los conteos de grupos', async () => {
    mockAppQuery.mockResolvedValue([filaBase({
      recibidos: '6', atendidos: '5', recibidosInformativos: '2',
      expedientesDistintos: '4', gruposEmpleadoExpediente: '5', gruposReprocesados: '2',
    })]);

    const [oficina] = await desempenoPorOficina({ desde: '2026-01-01', hasta: '2026-01-31' });

    expect(oficina.movimientos).toBe(8);
    expect(oficina.movimientosPromedioPorExpediente).toBe(2);
    expect(oficina.tasaReproceso).toBe(0.4);
  });

  it('sin ningún expediente/grupo (agregación vacía), los promedios/tasas de Fase 2 quedan null, no 0 ni NaN', async () => {
    mockAppQuery.mockResolvedValue([filaBase()]);

    const [oficina] = await desempenoPorOficina({ desde: '2026-01-01', hasta: '2026-01-31' });

    expect(oficina.movimientosPromedioPorExpediente).toBeNull();
    expect(oficina.tasaReproceso).toBeNull();
    expect(oficina.tasaAnulacion).toBeNull();
  });

  it('tasaAnulacion se calcula sobre emitidos/anulados (dimensión de emisión, no de recepción)', async () => {
    mockAppQuery.mockResolvedValue([filaBase({ emitidos: '50', anulados: '5' })]);

    const [oficina] = await desempenoPorOficina({ desde: '2026-01-01', hasta: '2026-01-31' });

    expect(oficina.emitidos).toBe(50);
    expect(oficina.anulados).toBe(5);
    expect(oficina.tasaAnulacion).toBe(0.1);
  });
});

describe('tiposDocumento — sigue leyendo el SGD en vivo, no el espejo', () => {
  it('consulta el catálogo real del SGD (SI_MAE_TIPO_DOC), no una copia local', async () => {
    mockSgdQuery.mockReset().mockResolvedValue([{ codigo: '232', descripcion: 'PROVEÍDO' }]);

    const tipos = await tiposDocumento();

    expect(tipos).toEqual([{ codigo: '232', descripcion: 'PROVEÍDO' }]);
    const [sql] = mockSgdQuery.mock.calls[0];
    expect(String(sql)).toContain('si_mae_tipo_doc');
  });
});

describe('pendientesAntiguosPorOficina — carga laboral (Fase 2), sin acotar por desde/hasta', () => {
  beforeEach(() => mockAppQuery.mockReset().mockResolvedValue([]));

  it('no bindea ningún rango de fechas — solo oficina/tipo de documento si se piden', async () => {
    await pendientesAntiguosPorOficina({});

    const [sql, opts] = unicaLlamada();
    expect(opts.bind).toEqual([]);
    expect(String(sql)).not.toContain('fe_envio >=');
  });

  it('con coDependencia, la agrega como primer bind', async () => {
    await pendientesAntiguosPorOficina({ coDependencia: '00009' });

    const [sql, opts] = unicaLlamada();
    expect(opts.bind).toEqual(['00009']);
    expect(String(sql)).toContain('co_dep_des = $1');
  });

  it('usa el mismo `atendido` que desempenoPorOficina/Empleado — sin NOT EXISTS propio', async () => {
    await pendientesAntiguosPorOficina({});

    const [sql] = unicaLlamada();
    expect(String(sql)).toContain('WHERE NOT atendido');
    expect(String(sql)).not.toContain('NOT EXISTS');
  });

  it('mide antigüedad contra now()', async () => {
    await pendientesAntiguosPorOficina({});

    const [sql] = unicaLlamada();
    expect(String(sql)).toContain('(now() - fe_envio) AS antiguedad');
  });

  it('bucketiza en 0-7 / 8-30 / 31+ días y calcula la antigüedad máxima', async () => {
    await pendientesAntiguosPorOficina({});

    const [sql] = unicaLlamada();
    expect(String(sql)).toContain("antiguedad < interval '8 days'");
    expect(String(sql)).toContain("antiguedad >= interval '31 days'");
    expect(String(sql)).toContain('max(antiguedad)');
  });

  it('mapea los conteos a número y la antigüedad máxima a días', async () => {
    mockAppQuery.mockResolvedValue([{
      coDependencia: '00003', nombreDependencia: 'OFICINA DE ASESORÍA LEGAL',
      pendientes: '90', pendientes0a7: '0', pendientes8a30: '0', pendientes31mas: '90',
      diasPendienteMasAntiguo: '113',
    }]);

    const [oficina] = await pendientesAntiguosPorOficina({});

    expect(oficina).toEqual({
      coDependencia: '00003', nombreDependencia: 'OFICINA DE ASESORÍA LEGAL',
      pendientes: 90, pendientes0a7: 0, pendientes8a30: 0, pendientes31Mas: 90,
      diasPendienteMasAntiguo: 113,
    });
  });

  it('sin ningún pendiente, diasPendienteMasAntiguo es null, no 0', async () => {
    mockAppQuery.mockResolvedValue([{
      coDependencia: '00003', nombreDependencia: 'OFICINA DE ASESORÍA LEGAL',
      pendientes: '0', pendientes0a7: '0', pendientes8a30: '0', pendientes31mas: '0',
      diasPendienteMasAntiguo: null,
    }]);

    const [oficina] = await pendientesAntiguosPorOficina({});

    expect(oficina.diasPendienteMasAntiguo).toBeNull();
  });

  /** Migración 014 — "Pendientes: drill-down": el backlog ya no es solo `NOT atendido`, así que
   *  estos dos casos reemplazan al viejo "usa el mismo atendido, sin NOT EXISTS propio" de arriba
   *  en lo que a exclusiones se refiere (ese test sigue valiendo: `NOT atendido` sigue ahí). */
  it('excluye los documentos informativos del backlog', async () => {
    await pendientesAntiguosPorOficina({});

    const [sql] = unicaLlamada();
    expect(String(sql)).toContain('NOT es_informativo');
  });

  it('excluye los pendientes cuyo expediente ya se archivó después de que el documento llegara', async () => {
    await pendientesAntiguosPorOficina({});

    const [sql] = unicaLlamada();
    expect(String(sql)).toContain('fe_archivo_expediente IS NULL OR fe_archivo_expediente < fe_envio');
  });
});

describe('pendientesDetalleOficina — drill-down de un número de la pestaña Pendientes', () => {
  beforeEach(() => mockAppQuery.mockReset().mockResolvedValue([]));

  /** Hace dos consultas (los ítems y el total) — a diferencia del resto de este archivo, no puede
   *  usar `unicaLlamada()`. */
  function llamadas(): { sql: string; opts: { bind: unknown[] } }[] {
    return mockAppQuery.mock.calls.map(([sql, opts]) => ({ sql: String(sql), opts }));
  }

  it('bindea la oficina primero y comparte las mismas exclusiones del backlog que el agregado', async () => {
    await pendientesDetalleOficina('00009', 'todos');

    const [items, total] = llamadas();
    expect(items.opts.bind).toEqual(['00009']);
    for (const sql of [items.sql, total.sql]) {
      expect(sql).toContain('co_dep_des = $1');
      expect(sql).toContain('NOT atendido');
      expect(sql).toContain('NOT es_informativo');
      expect(sql).toContain('fe_archivo_expediente IS NULL OR fe_archivo_expediente < fe_envio');
    }
    // Mismos binds en las dos consultas: nunca pueden contar oficinas distintas.
    expect(total.opts.bind).toEqual(items.opts.bind);
  });

  it('con un bucket puntual, agrega su condición de antigüedad — "todos" no agrega ninguna', async () => {
    await pendientesDetalleOficina('00009', '31mas');
    const [conBucket] = llamadas();
    expect(conBucket.sql).toContain("antiguedad >= interval '31 days'");

    mockAppQuery.mockClear();
    await pendientesDetalleOficina('00009', 'todos');
    const [sinBucket] = llamadas();
    expect(sinBucket.sql).not.toContain('antiguedad >=');
    expect(sinBucket.sql).not.toContain('antiguedad <');
  });

  /** Bug real reportado en producción: `antiguedad` es un alias calculado en el SELECT del CTE
   *  (`(now() - fe_envio) AS antiguedad`) — Postgres lo rechaza con "column antiguedad does not
   *  exist" si el bucket se cuela en el WHERE de ESE MISMO CTE, porque ahí el alias todavía no
   *  existe. Tiene que filtrar la consulta EXTERIOR, que selecciona DESDE `pendientes`, donde
   *  `antiguedad` ya es una columna real de salida. */
  it('filtra el bucket DESPUÉS del CTE (consulta exterior), nunca dentro de su propio WHERE', async () => {
    await pendientesDetalleOficina('00009', '31mas');

    const [items, total] = llamadas();
    for (const sql of [items.sql, total.sql]) {
      const indiceCte = sql.indexOf('FROM dashboard.participacion');
      const indiceFromPendientes = sql.indexOf('FROM pendientes');
      const indiceBucket = sql.indexOf("antiguedad >= interval '31 days'");
      expect(indiceCte).toBeGreaterThanOrEqual(0);
      expect(indiceFromPendientes).toBeGreaterThan(indiceCte);
      expect(indiceBucket).toBeGreaterThan(indiceFromPendientes);
    }
  });

  it('con tipoDocumento, lo bindea en segundo lugar', async () => {
    await pendientesDetalleOficina('00009', 'todos', '232');

    const [items] = llamadas();
    expect(items.opts.bind).toEqual(['00009', '232']);
    expect(items.sql).toContain('co_tip_doc = $2');
  });

  it('ordena por antigüedad descendente — el más viejo primero', async () => {
    await pendientesDetalleOficina('00009', 'todos');

    const [items] = llamadas();
    expect(items.sql).toContain('ORDER BY antiguedad DESC');
  });

  it('acota los ítems devueltos, pero el total sale de una consulta aparte sin ese límite', async () => {
    mockAppQuery.mockImplementation((sql: string) => {
      if (String(sql).includes('ORDER BY antiguedad DESC')) {
        return Promise.resolve(Array.from({ length: 3 }, (_, i) => ({
          nuAnnExp: '2026', nuSecExp: '000058', numeroExpediente: null,
          nuAnn: '2026', nuEmi: String(i), nuDes: '1', numeroDocumento: null, coTipDoc: null,
          asunto: null, coEmpleado: '00061', nombreEmpleado: null, esDocRec: '1',
          fechaRecepcion: '2026-01-01 00:00:00', dias: '90',
        })));
      }
      return Promise.resolve([{ total: '231' }]);
    });

    const resultado = await pendientesDetalleOficina('00009', 'todos');

    expect(resultado.total).toBe(231);
    expect(resultado.items).toHaveLength(3);
    const [items] = llamadas();
    expect(items.sql).toContain('LIMIT 500');
  });
});
