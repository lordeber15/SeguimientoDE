/**
 * `dashboardResumenService.ts` aislado con mocks — mismo criterio que `rag/mantenimientoService.test.ts`:
 * lo que importa aislar aquí es la lógica de control (candado, transacción, qué se registra en
 * caso de error), no reimplementar el SQL crudo del SGD. El planificador (`iniciarPlanificadorResumen`)
 * no se prueba directamente, mismo criterio que `iniciarPlanificadorBarrido`/`iniciarMantenimientoPeriodico`
 * en el resto del proyecto — son un `setInterval` fino sobre funciones que sí se prueban.
 */
const appQuery = jest.fn();
const sgdQuery = jest.fn();
const transaction = jest.fn((cb: (tx: unknown) => unknown) => cb({}));

jest.mock('../../src/config/appDatabase', () => ({
  appSequelize: { query: appQuery, transaction },
}));
jest.mock('../../src/config/database', () => ({
  DB_SCHEMA: 'idosgd',
  sequelize: { query: sgdQuery },
}));

import {
  RefrescoOcupado,
  estadoResumen,
  normalizarAsunto,
  refrescarResumen,
} from '../../src/services/dashboardResumenService';

beforeEach(() => {
  appQuery.mockReset();
  sgdQuery.mockReset();
  transaction.mockClear();
  transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb({}));
});

/** Encadena las respuestas que `refrescarResumen` espera, en el orden en que las pide. */
function prepararRefrescoExitoso(
  participaciones: unknown[] = [],
  emisiones: unknown[] = [],
  pasos: unknown[] = [],
) {
  appQuery.mockImplementation((sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) return Promise.resolve([{ ok: true }]);
    if (sql.includes('INSERT INTO dashboard.resumen_refresco')) return Promise.resolve([{ id: 42 }]);
    // `app.config`: el umbral de similitud del agrupamiento de procesos. Vacío ⇒ el servicio cae a
    // su valor por defecto, que es justo lo que queremos ejercitar aquí.
    if (sql.includes('FROM app.config')) return Promise.resolve([]);
    return Promise.resolve(undefined); // DELETE / INSERT en lote / UPDATE / unlock
  });
  sgdQuery.mockImplementation((sql: string) => {
    // Los pasos a nivel oficina se distinguen por su emparejamiento por dependencia; las
    // participaciones, por el JOIN contra el catálogo de empleados que solo ellas hacen.
    if (sql.includes('em.co_dep_emi = r.co_dep_des')) return Promise.resolve(pasos);
    if (sql.includes('rhtm_per_empleados')) return Promise.resolve(participaciones);
    return Promise.resolve(emisiones);
  });
}

describe('refrescarResumen — candado', () => {
  it('si el candado ya está tomado, lanza RefrescoOcupado sin tocar el SGD ni insertar en resumen_refresco', async () => {
    appQuery.mockImplementation((sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return Promise.resolve([{ ok: false }]);
      return Promise.resolve(undefined);
    });

    await expect(refrescarResumen('manual')).rejects.toThrow(RefrescoOcupado);

    expect(sgdQuery).not.toHaveBeenCalled();
    expect(appQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO dashboard.resumen_refresco'))).toBe(false);
  });

  it('siempre libera el candado, incluso si el refresco falla', async () => {
    appQuery.mockImplementation((sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return Promise.resolve([{ ok: true }]);
      if (sql.includes('INSERT INTO dashboard.resumen_refresco')) return Promise.resolve([{ id: 1 }]);
      return Promise.resolve(undefined);
    });
    sgdQuery.mockRejectedValue(new Error('SGD caído'));

    await expect(refrescarResumen('manual')).rejects.toThrow('SGD caído');

    expect(appQuery.mock.calls.some(([sql]) => String(sql).includes('pg_advisory_unlock'))).toBe(true);
  });
});

describe('refrescarResumen — camino feliz', () => {
  it('trae participaciones y emisiones del SGD, y las inserta en el espejo dentro de una transacción', async () => {
    prepararRefrescoExitoso(
      [{ coEmpDes: '00061', coDepDes: '00012', feEnvio: '2026-01-01', atendido: true }],
      [{ coDepEmi: '00012', esDocEmi: '0', feEmi: '2026-01-01' }],
    );

    const resultado = await refrescarResumen('manual');

    expect(resultado).toMatchObject({ id: 42, participaciones: 1, emisiones: 1 });
    expect(transaction).toHaveBeenCalledTimes(1);

    const sqlsEnTransaccion = appQuery.mock.calls.map(([sql]) => String(sql));
    expect(sqlsEnTransaccion).toEqual(expect.arrayContaining([
      expect.stringContaining('DELETE FROM dashboard.participacion'),
      expect.stringContaining('INSERT INTO dashboard.participacion'),
      expect.stringContaining('DELETE FROM dashboard.emision'),
      expect.stringContaining('INSERT INTO dashboard.emision'),
    ]));
  });

  it('Fase 8: el insert de participación incluye co_dep_emi (oficina que emitió lo recibido)', async () => {
    prepararRefrescoExitoso(
      [{ coEmpDes: '00061', coDepDes: '00012', coDepEmi: '00003', feEnvio: '2026-01-01', atendido: true }],
      [],
    );

    await refrescarResumen('manual');

    const insercionParticipacion = appQuery.mock.calls.find(
      ([sql]) => String(sql).includes('INSERT INTO dashboard.participacion'),
    );
    expect(insercionParticipacion?.[0]).toContain('co_dep_emi');
    expect(insercionParticipacion?.[1]?.bind).toContain('00003');
  });

  it('el insert de participación guarda el asunto ya normalizado (base del reproceso por asunto)', async () => {
    prepararRefrescoExitoso(
      [{
        coEmpDes: '00061', coDepDes: '00012', feEnvio: '2026-01-01', atendido: true,
        asunto: '  Solicito informe   técnico. ',
      }],
      [],
    );

    await refrescarResumen('manual');

    const insercionParticipacion = appQuery.mock.calls.find(
      ([sql]) => String(sql).includes('INSERT INTO dashboard.participacion'),
    );
    expect(insercionParticipacion?.[0]).toContain('asunto_norm');
    expect(insercionParticipacion?.[1]?.bind).toContain('SOLICITO INFORME TECNICO');
  });

  it('registra fe_inicio al insertar y fe_fin/conteos al terminar, en la misma fila de resumen_refresco', async () => {
    prepararRefrescoExitoso([{ a: 1 }], []);

    await refrescarResumen('automatico');

    const insercion = appQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO dashboard.resumen_refresco'));
    expect(insercion?.[1]?.bind).toEqual(['automatico']);

    const actualizacion = appQuery.mock.calls.find(([sql]) => String(sql).includes('SET fe_fin = now(), participaciones'));
    expect(actualizacion).toBeDefined();
    expect(actualizacion?.[1]?.bind).toEqual([42, 1, 0, expect.any(Number), expect.any(Number)]);
  });

  it('inserta en lotes de 2000 filas — más de un lote si hay más de 2000 participaciones', async () => {
    const muchas = Array.from({ length: 2001 }, (_, i) => ({ coEmpDes: String(i), atendido: true }));
    prepararRefrescoExitoso(muchas, []);

    await refrescarResumen('manual');

    const insercionesParticipacion = appQuery.mock.calls.filter(
      ([sql]) => String(sql).includes('INSERT INTO dashboard.participacion'),
    );
    expect(insercionesParticipacion).toHaveLength(2);
  });

  it('llena también el espejo de la vista de calidad de procesos, en la MISMA transacción', async () => {
    prepararRefrescoExitoso([], [], [
      {
        nuAnnExp: '2026', nuSecExp: '000058', nuEmi: '000001', nuDes: '1',
        coDepEmi: '00002', coDepDes: '00012', esInformativo: false,
        feEnvio: '2026-01-01 09:00:00', asunto: 'PRESENTACION DE DOCUMENTACION PARA PAGO DE CONSULTORIA SCCP 169-2026',
      },
    ]);

    const resultado = await refrescarResumen('manual');

    expect(resultado).toMatchObject({ pasos: 1, procesos: 1 });
    const sqls = appQuery.mock.calls.map(([sql]) => String(sql));
    expect(sqls).toEqual(expect.arrayContaining([
      expect.stringContaining('DELETE FROM dashboard.paso'),
      expect.stringContaining('INSERT INTO dashboard.paso'),
      expect.stringContaining('DELETE FROM dashboard.proceso_expediente'),
      expect.stringContaining('INSERT INTO dashboard.proceso'),
      expect.stringContaining('INSERT INTO dashboard.proceso_expediente'),
    ]));
    // Una sola transacción para todo el espejo: nunca se ve un flujograma calculado sobre pasos de
    // un refresco y familias de otro.
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('agrupa por el asunto de ORIGEN: dos expedientes con el mismo trámite y distinto número caen en la misma familia', async () => {
    const paso = (sec: string, asunto: string) => ({
      nuAnnExp: '2026', nuSecExp: sec, nuEmi: '000001', nuDes: '1',
      coDepEmi: '00002', coDepDes: '00012', esInformativo: false,
      feEnvio: '2026-01-01 09:00:00', asunto,
    });
    prepararRefrescoExitoso([], [], [
      paso('000058', 'PRESENTACION DE DOCUMENTACION PARA PAGO DE CONSULTORIA SCCP 169-2026'),
      paso('000059', 'PRESENTACION DE DOCUMENTACION PARA PAGO DE CONSULTORIA SCCP 170-2026'),
      paso('000060', 'RENOVACION DE CARTA FIANZA'),
    ]);

    const resultado = await refrescarResumen('manual');

    // 3 expedientes, 2 familias: los dos pagos de consultoría se agrupan pese al número distinto.
    expect(resultado.procesos).toBe(2);
    const asignaciones = appQuery.mock.calls.find(
      ([sql]) => String(sql).includes('INSERT INTO dashboard.proceso_expediente'),
    );
    const binds = asignaciones?.[1]?.bind as unknown[];
    const claves = [binds[2], binds[6], binds[10]];
    expect(claves[0]).toBe(claves[1]);
    expect(claves[2]).not.toBe(claves[0]);
  });

  it('migración 014: el insert de participación incluye la identidad del documento y el cierre del expediente', async () => {
    prepararRefrescoExitoso(
      [{
        coEmpDes: '00061', coDepDes: '00012', feEnvio: '2026-01-01', atendido: false,
        nuAnn: '2026', nuEmi: '0000012345', nuDes: '1', esDocRec: '1',
        nuExpediente: 'OGAUL02026000058', nuDoc: '007-2026', feArchivoExpediente: null,
      }],
      [],
    );

    await refrescarResumen('manual');

    const insercionParticipacion = appQuery.mock.calls.find(
      ([sql]) => String(sql).includes('INSERT INTO dashboard.participacion'),
    );
    expect(insercionParticipacion?.[0]).toEqual(expect.stringContaining('nu_ann'));
    expect(insercionParticipacion?.[0]).toContain('fe_archivo_expediente');
    expect(insercionParticipacion?.[1]?.bind).toEqual(expect.arrayContaining([
      '0000012345', '1', 'OGAUL02026000058', '007-2026',
    ]));
  });

  it('migración 014: la consulta de participaciones arma un cierre de expediente (archivos) a partir de es_doc_rec = \'3\'', async () => {
    prepararRefrescoExitoso([], []);

    await refrescarResumen('manual');

    const consultaParticipaciones = sgdQuery.mock.calls.find(
      ([sql]) => String(sql).includes('rhtm_per_empleados'),
    );
    const sql = String(consultaParticipaciones?.[0]);
    expect(sql).toContain('archivos AS');
    expect(sql).toContain("d.es_doc_rec = '3'");
    expect(sql).toContain('"feArchivoExpediente"');
    // El expediente visible y el número de documento salen del mismo JOIN que ya usa
    // `seguimientoService.ts` — `tdtx_remitos_resumen`, no una tabla nueva.
    expect(sql).toContain('tdtx_remitos_resumen');
  });

  it('si el error ocurre a mitad de camino, lo registra en resumen_refresco y relanza en vez de tragárselo', async () => {
    appQuery.mockImplementation((sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return Promise.resolve([{ ok: true }]);
      if (sql.includes('INSERT INTO dashboard.resumen_refresco') && !sql.includes('SET')) return Promise.resolve([{ id: 7 }]);
      return Promise.resolve(undefined);
    });
    sgdQuery.mockRejectedValue(new Error('timeout de red'));

    await expect(refrescarResumen('manual')).rejects.toThrow('timeout de red');

    const registroError = appQuery.mock.calls.find(([sql]) => String(sql).includes("SET fe_fin = now(), error"));
    expect(registroError?.[1]?.bind).toEqual([7, 'timeout de red']);
  });
});

describe('estadoResumen', () => {
  it('devuelve el último refresco, hace cuánto fue, y cuántas participaciones hay en el espejo', async () => {
    appQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM dashboard.resumen_refresco')) {
        return Promise.resolve([{ feFin: '2026-08-28 10:00:00', minutos: 12.5, error: null }]);
      }
      if (sql.includes('count(*) AS n')) return Promise.resolve([{ n: '46000' }]);
      return Promise.resolve([]);
    });

    const estado = await estadoResumen();

    expect(estado).toEqual({
      ultimoRefresco: '2026-08-28 10:00:00',
      minutosDesde: 12.5,
      participaciones: 46000,
      ultimoError: null,
    });
  });

  it('sin ningún refresco todavía, devuelve nulos en vez de fallar', async () => {
    appQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM dashboard.resumen_refresco')) return Promise.resolve([]);
      if (sql.includes('count(*) AS n')) return Promise.resolve([{ n: '0' }]);
      return Promise.resolve([]);
    });

    const estado = await estadoResumen();

    expect(estado).toEqual({
      ultimoRefresco: null, minutosDesde: null, participaciones: 0, ultimoError: null,
    });
  });
});

describe('normalizarAsunto — criterio de "mismo asunto" del reproceso', () => {
  it('colapsa las diferencias cosméticas del mismo asunto escrito dos veces a mano', () => {
    const variantes = [
      'Solicito informe técnico',
      '  SOLICITO   INFORME TECNICO.  ',
      'solicito informe técnico...',
      '"Solicito Informe Técnico"',
    ];

    const normalizadas = variantes.map(normalizarAsunto);
    expect(new Set(normalizadas)).toEqual(new Set(['SOLICITO INFORME TECNICO']));
  });

  it('conserva las palabras y los números, que son lo que distingue un asunto de otro', () => {
    expect(normalizarAsunto('Remito Informe N° 007-2026-OGA')).toBe('REMITO INFORME N° 007-2026-OGA');
    expect(normalizarAsunto('Remito Informe N° 008-2026-OGA')).not.toBe(
      normalizarAsunto('Remito Informe N° 007-2026-OGA'),
    );
  });

  /** Sin asunto no hay forma de saber si es el mismo trámite: el `null` es lo que hace que la
   *  consulta (`asunto_norm IS NOT NULL`) nunca marque esas recepciones como reproceso. */
  it('devuelve null cuando no queda nada con lo que comparar', () => {
    expect(normalizarAsunto(null)).toBeNull();
    expect(normalizarAsunto('')).toBeNull();
    expect(normalizarAsunto('   ')).toBeNull();
    expect(normalizarAsunto(' -- ')).toBeNull();
  });
});
