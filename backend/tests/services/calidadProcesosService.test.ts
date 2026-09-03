/**
 * `calidadProcesosService.ts` — las funciones de minería de procesos se prueban puras (sin mocks),
 * porque son la lógica que decide si la vista dice algo cierto. Lo que sí va con mock es el SQL,
 * mismo criterio que `dashboardService.test.ts`.
 *
 * El caso central está calcado de la BD real (verificado ✅ 2026-09-02, familia "PRESENTACIÓN DE
 * DOCUMENTACIÓN PARA PAGO DE CONSULTORÍA", 436 expedientes): la ruta exacta más repetida cubre el
 * 13%, pero la columna vertebral `OGA → Logística → Contabilidad → Tesorería` cubre el 91%. Si una
 * refactorización rompe esa distinción, este test lo detecta.
 */
const appQuery = jest.fn();

jest.mock('../../src/config/appDatabase', () => ({ appSequelize: { query: appQuery } }));

import {
  columnaVertebral,
  construirTrazas,
  contieneSubsecuencia,
  flujoProceso,
  percentil,
  renombrarProceso,
} from '../../src/services/calidadProcesosService';

beforeEach(() => appQuery.mockReset());

/** Fila de `dashboard.paso` con lo mínimo que necesitan las funciones bajo prueba. */
function paso(
  expediente: string,
  coDepDes: string,
  opciones: { coDepEmi?: string; esDocRec?: string; segundos?: number; coMot?: string } = {},
) {
  return {
    procesoClave: 'abc0000000000001',
    nuAnnExp: '2026',
    nuSecExp: expediente,
    coDepEmi: opciones.coDepEmi ?? null,
    coDepDes,
    nombreDependencia: coDepDes,
    coMot: opciones.coMot ?? '2',
    coTipDoc: '232',
    esDocRec: opciones.esDocRec ?? '3',
    segundosTotal: opciones.segundos === undefined ? null : String(opciones.segundos),
    segundosEspera: null,
    segundosTrabajo: null,
  };
}

describe('percentil', () => {
  it('interpola igual que PERCENTILE_CONT de Postgres', () => {
    expect(percentil([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentil([10, 20, 30], 0)).toBe(10);
    expect(percentil([10, 20, 30], 1)).toBe(30);
    expect(percentil([5], 0.5)).toBe(5);
  });

  it('devuelve null sin datos, en vez de 0 (que se leería como "instantáneo")', () => {
    expect(percentil([], 0.5)).toBeNull();
  });
});

describe('construirTrazas', () => {
  it('colapsa las visitas consecutivas a la misma oficina: los saltos internos viven DENTRO del nodo', () => {
    // OGA deriva a Logística; dentro de Logística el jefe se lo pasa a un especialista (segunda
    // fila con el mismo co_dep_des) y recién entonces sale a Contabilidad.
    const [traza] = construirTrazas([
      paso('001', 'LOGISTICA', { coDepEmi: 'OGA' }),
      paso('001', 'LOGISTICA'),
      paso('001', 'CONTABILIDAD'),
    ]);

    expect(traza.ruta).toEqual(['OGA', 'LOGISTICA', 'CONTABILIDAD']);
    expect(traza.pasos).toHaveLength(3); // los tiempos de las dos visitas sí se conservan
  });

  it('abre la traza con la oficina EMISORA del primer paso: por ahí entró el expediente', () => {
    const [traza] = construirTrazas([paso('001', 'USEI', { coDepEmi: 'OGA' })]);
    expect(traza.ruta[0]).toBe('OGA');
  });

  it('marca como cerrado solo si el ÚLTIMO paso quedó ARCHIVADO', () => {
    const [cerrado] = construirTrazas([paso('001', 'A', { esDocRec: '2' }), paso('001', 'B', { esDocRec: '3' })]);
    const [abierto] = construirTrazas([paso('002', 'A', { esDocRec: '3' }), paso('002', 'B', { esDocRec: '1' })]);
    expect(cerrado.cerrado).toBe(true);
    expect(abierto.cerrado).toBe(false);
  });
});

describe('contieneSubsecuencia', () => {
  it('acepta rodeos intermedios: lo que importa es pasar por las etapas troncales en orden', () => {
    expect(contieneSubsecuencia(['OGA', 'USEI', 'OGA', 'LOG', 'CTB'], ['OGA', 'LOG', 'CTB'])).toBe(true);
  });

  it('rechaza si falta una etapa o si el orden se invierte', () => {
    expect(contieneSubsecuencia(['OGA', 'LOG'], ['OGA', 'LOG', 'CTB'])).toBe(false);
    expect(contieneSubsecuencia(['OGA', 'CTB', 'LOG'], ['OGA', 'LOG', 'CTB'])).toBe(false);
  });
});

describe('columnaVertebral', () => {
  /**
   * Reproduce en pequeño lo medido contra la BD real: un tronco común y varios desvíos opcionales
   * de conformidad, cada uno minoritario. 20 expedientes: 4 sin desvío y 16 repartidos entre cuatro
   * oficinas técnicas distintas (4 cada una).
   */
  function familiaPagoConsultoria() {
    const filas = [];
    for (let i = 0; i < 4; i += 1) {
      const exp = `d${i}`;
      filas.push(paso(exp, 'LOGISTICA', { coDepEmi: 'OGA' }), paso(exp, 'CONTABILIDAD'), paso(exp, 'TESORERIA'));
    }
    for (const [j, tecnica] of ['OMSE', 'OGI', 'OPPMC', 'USEI'].entries()) {
      for (let i = 0; i < 4; i += 1) {
        const exp = `${tecnica}${i}`;
        filas.push(
          paso(exp, tecnica, { coDepEmi: 'OGA' }),
          paso(exp, 'OGA'),
          paso(exp, 'LOGISTICA'),
          paso(exp, 'CONTABILIDAD'),
          paso(exp, 'TESORERIA'),
        );
      }
      void j;
    }
    return construirTrazas(filas);
  }

  it('encuentra el tronco aunque NINGÚN expediente sea mayoría por su ruta exacta', () => {
    const trazas = familiaPagoConsultoria();

    // Ninguna ruta exacta llega al 25%: 4/20 la más repetida.
    const rutas = new Map<string, number>();
    for (const t of trazas) rutas.set(t.ruta.join('>'), (rutas.get(t.ruta.join('>')) ?? 0) + 1);
    expect(Math.max(...rutas.values()) / trazas.length).toBeLessThanOrEqual(0.25);

    const columna = columnaVertebral(trazas);
    expect(columna).toEqual(['OGA', 'LOGISTICA', 'CONTABILIDAD', 'TESORERIA']);

    // …y sin embargo la columna representa a TODOS los expedientes.
    const cubiertos = trazas.filter((t) => contieneSubsecuencia(t.ruta, columna)).length;
    expect(cubiertos / trazas.length).toBe(1);
  });

  it('deja fuera los desvíos opcionales: ninguna oficina técnica entra en el tronco', () => {
    const columna = columnaVertebral(familiaPagoConsultoria());
    for (const tecnica of ['OMSE', 'OGI', 'OPPMC', 'USEI']) {
      expect(columna).not.toContain(tecnica);
    }
  });

  it('no se queda en bucle cuando hay devoluciones frecuentes (A→B→A)', () => {
    const filas = [];
    for (let i = 0; i < 10; i += 1) {
      const exp = `r${i}`;
      filas.push(
        paso(exp, 'B', { coDepEmi: 'A' }),
        paso(exp, 'A'),
        paso(exp, 'B'),
        paso(exp, 'A'),
        paso(exp, 'C'),
      );
    }
    const columna = columnaVertebral(construirTrazas(filas));
    expect(new Set(columna).size).toBe(columna.length); // sin nodos repetidos
    expect(columna).toEqual(['A', 'B', 'C']);
  });

  it('corta el tronco donde el flujo se dispersa, en vez de seguir un rodeo de unos pocos casos', () => {
    const filas = [];
    for (let i = 0; i < 20; i += 1) {
      const exp = `x${i}`;
      filas.push(paso(exp, 'B', { coDepEmi: 'A' }));
      // Solo 2 de 20 (10%, por debajo del mínimo del 15%) siguen hacia una tercera oficina.
      if (i < 2) filas.push(paso(exp, 'C'));
    }
    expect(columnaVertebral(construirTrazas(filas))).toEqual(['A', 'B']);
  });

  it('devuelve una lista vacía sin trazas, en vez de explotar', () => {
    expect(columnaVertebral([])).toEqual([]);
  });
});

describe('flujoProceso — integración con SQL mockeado', () => {
  const CLAVE = 'abc0000000000001';

  function filaPasoSql(
    expediente: string,
    coDepDes: string,
    opciones: { coDepEmi?: string; esDocRec?: string; segundos?: number; coMot?: string } = {},
  ) {
    return {
      procesoClave: CLAVE,
      nuAnnExp: '2026',
      nuSecExp: expediente,
      coDepEmi: opciones.coDepEmi ?? null,
      coDepDes,
      nombreDependencia: coDepDes,
      coMot: opciones.coMot ?? '2',
      coTipDoc: '232',
      esDocRec: opciones.esDocRec ?? '3',
      segundosTotal: opciones.segundos === undefined ? null : String(opciones.segundos),
      segundosEspera: null,
      segundosTrabajo: null,
    };
  }

  function mockearConsultas(pasos: unknown[], participaciones: unknown[] = []) {
    appQuery.mockImplementation((sql: string) => {
      if (sql.includes('GROUP BY co_dep_des')) {
        return Promise.resolve([{ co: 'LOGISTICA', nombre: 'UNIDAD DE LOGÍSTICA' }]);
      }
      if (sql.includes('dashboard.proceso_alias')) return Promise.resolve([]);
      if (sql.includes('nombre_auto')) return Promise.resolve([{ clave: CLAVE, nombre: 'PAGO DE CONSULTORIA' }]);
      if (sql.includes('dashboard.participacion part')) return Promise.resolve(participaciones);
      if (sql.includes('dashboard.paso p')) return Promise.resolve(pasos);
      return Promise.resolve([]);
    });
  }

  it('arma la columna vertebral y adjunta el desglose por persona de cada nodo', async () => {
    mockearConsultas(
      [
        filaPasoSql('001', 'LOGISTICA', { coDepEmi: 'OGA' }),
        filaPasoSql('002', 'LOGISTICA', { coDepEmi: 'OGA' }),
      ],
      [
        {
          nuAnnExp: '2026', nuSecExp: '001', coDepDes: 'LOGISTICA',
          coEmpDes: '00061', nombreEmpleado: 'Juan Perez', segundosCorridos: '3600',
        },
        {
          nuAnnExp: '2026', nuSecExp: '002', coDepDes: 'LOGISTICA',
          coEmpDes: '00062', nombreEmpleado: 'Ana Diaz', segundosCorridos: '7200',
        },
      ],
    );

    const flujo = await flujoProceso(CLAVE, {});

    expect(flujo).not.toBeNull();
    expect(flujo!.columna.map((n) => n.coDependencia)).toEqual(['OGA', 'LOGISTICA']);

    const nodoLogistica = flujo!.columna.find((n) => n.coDependencia === 'LOGISTICA')!;
    expect(nodoLogistica.porEmpleado).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ coEmpleado: '00061', nombre: 'Juan Perez', visitas: 1 }),
        expect.objectContaining({ coEmpleado: '00062', nombre: 'Ana Diaz', visitas: 1 }),
      ]),
    );
  });

  it('descarta del desglose por persona los expedientes que "solo cerrados" excluyó', async () => {
    // 3 expedientes cerrados (para que el arco OGA→LOGISTICA supere el mínimo de muestra) y 1
    // abierto que debe desaparecer del todo al filtrar — de su participación no debe quedar rastro.
    mockearConsultas(
      [
        filaPasoSql('001', 'LOGISTICA', { coDepEmi: 'OGA', esDocRec: '3' }),
        filaPasoSql('002', 'LOGISTICA', { coDepEmi: 'OGA', esDocRec: '3' }),
        filaPasoSql('003', 'LOGISTICA', { coDepEmi: 'OGA', esDocRec: '3' }),
        filaPasoSql('004', 'LOGISTICA', { coDepEmi: 'OGA', esDocRec: '1' }), // abierto — se filtra
      ],
      [
        {
          nuAnnExp: '2026', nuSecExp: '001', coDepDes: 'LOGISTICA',
          coEmpDes: '00061', nombreEmpleado: 'Juan Perez', segundosCorridos: '3600',
        },
        {
          nuAnnExp: '2026', nuSecExp: '004', coDepDes: 'LOGISTICA',
          coEmpDes: '00099', nombreEmpleado: 'No Deberia Salir', segundosCorridos: '100',
        },
      ],
    );

    const flujo = await flujoProceso(CLAVE, { soloCerrados: true });

    expect(flujo!.expedientes).toBe(3); // el abierto queda fuera de la traza también
    const nodoLogistica = flujo!.columna.find((n) => n.coDependencia === 'LOGISTICA')!;
    expect(nodoLogistica.porEmpleado.map((e) => e.coEmpleado)).toEqual(['00061']);
  });

  it('devuelve null cuando no hay expedientes para ese proceso con esos filtros', async () => {
    mockearConsultas([]);
    expect(await flujoProceso(CLAVE, {})).toBeNull();
  });
});

describe('renombrarProceso', () => {
  it('hace upsert del alias y deja rastro en app.auditoria con el actor', async () => {
    appQuery.mockResolvedValue([]);

    await renombrarProceso('abc0000000000001', 'Pago de consultores', '08365245');

    expect(appQuery).toHaveBeenCalledTimes(2);
    const [sqlAlias, optsAlias] = appQuery.mock.calls[0];
    expect(String(sqlAlias)).toContain('dashboard.proceso_alias');
    expect(String(sqlAlias)).toContain('ON CONFLICT');
    expect(optsAlias.bind).toEqual(['abc0000000000001', 'Pago de consultores', '08365245']);

    const [sqlAuditoria, optsAuditoria] = appQuery.mock.calls[1];
    expect(String(sqlAuditoria)).toContain('app.auditoria');
    expect(optsAuditoria.bind[0]).toBe('08365245');
    expect(optsAuditoria.bind[1]).toBe('calidad.proceso.renombrar');
    expect(JSON.parse(optsAuditoria.bind[2])).toEqual({
      clave: 'abc0000000000001',
      nombre: 'Pago de consultores',
    });
  });
});
