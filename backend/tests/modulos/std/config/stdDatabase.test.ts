/**
 * `consultarStd` es el único punto de acceso a la BD del STD: debe rechazar en el propio proceso
 * cualquier sentencia que no sea SELECT/WITH, SIN necesidad de una conexión real (el rechazo pasa
 * antes de tocar la red) — y dejar pasar un SELECT hacia `stdSequelize.query`, que aquí se espía
 * en vez de conectarse de verdad.
 */

import {
  ConsultaStdNoPermitida,
  consultarStd,
  stdSequelize,
} from '../../../../src/modulos/std/config/stdDatabase';

describe('consultarStd — solo lectura', () => {
  const sentenciasProhibidas = [
    "INSERT INTO tbl_documento (documento) VALUES ('x')",
    "UPDATE tbl_documento SET asunto = 'x' WHERE id_documento = 1",
    'DELETE FROM tbl_documento WHERE id_documento = 1',
    'DROP TABLE tbl_documento',
    'TRUNCATE tbl_adjunto',
    'CALL sp_replace_adjunto(1, 2)',
    '  -- comentario\nDELETE FROM tbl_documento',
  ];

  it.each(sentenciasProhibidas)('rechaza "%s" sin llegar a la base de datos', async (sql) => {
    const espia = jest.spyOn(stdSequelize, 'query').mockImplementation(async () => {
      throw new Error('no debería llamarse a stdSequelize.query para una sentencia prohibida');
    });

    await expect(consultarStd(sql)).rejects.toBeInstanceOf(ConsultaStdNoPermitida);
    expect(espia).not.toHaveBeenCalled();

    espia.mockRestore();
  });

  it('deja pasar un SELECT hacia stdSequelize.query', async () => {
    const espia = jest.spyOn(stdSequelize, 'query').mockResolvedValue([{ id_documento: 1 }] as never);

    const filas = await consultarStd('SELECT id_documento FROM tbl_documento WHERE id_documento = :id', { id: 1 });

    expect(filas).toEqual([{ id_documento: 1 }]);
    expect(espia).toHaveBeenCalledWith(
      'SELECT id_documento FROM tbl_documento WHERE id_documento = :id',
      expect.objectContaining({ replacements: { id: 1 } }),
    );

    espia.mockRestore();
  });

  it('deja pasar un WITH (CTE) hacia stdSequelize.query', async () => {
    const espia = jest.spyOn(stdSequelize, 'query').mockResolvedValue([] as never);

    await consultarStd('WITH x AS (SELECT 1) SELECT * FROM x');

    expect(espia).toHaveBeenCalled();
    espia.mockRestore();
  });

  it('no distingue mayúsculas/minúsculas ni espacio inicial', async () => {
    const espia = jest.spyOn(stdSequelize, 'query').mockResolvedValue([] as never);

    await consultarStd('   select 1');

    expect(espia).toHaveBeenCalled();
    espia.mockRestore();
  });
});

describe('stdDisponible', () => {
  // `STD_HABILITADO` se lee UNA sola vez al importar el módulo (es una constante exportada, no
  // una función) — a propósito, igual que cualquier otra bandera de `.env`: no cambia a mitad de
  // proceso. Por eso cada caso necesita su propia instancia aislada del módulo, con el entorno ya
  // puesto ANTES del require — tocar `process.env` después de importar no tendría ningún efecto.
  const originales = { ...process.env };

  afterEach(() => {
    process.env = { ...originales };
  });

  function stdDisponibleCon(env: Record<string, string | undefined>) {
    let resultado!: ReturnType<typeof import('../../../../src/modulos/std/config/stdDatabase').stdDisponible>;
    jest.isolateModules(() => {
      for (const [clave, valor] of Object.entries(env)) {
        if (valor === undefined) delete process.env[clave];
        else process.env[clave] = valor;
      }
      const modulo = require('../../../../src/modulos/std/config/stdDatabase');
      resultado = modulo.stdDisponible();
    });
    return resultado;
  }

  it('no disponible cuando STD_HABILITADO no está en "true"', () => {
    const resultado = stdDisponibleCon({ STD_HABILITADO: undefined });
    expect(resultado).toEqual({ disponible: false, motivo: expect.stringContaining('STD_HABILITADO') });
  });

  it('no disponible cuando falta alguna credencial pese a estar habilitado', () => {
    const resultado = stdDisponibleCon({
      STD_HABILITADO: 'true',
      STD_DB_HOST: undefined,
      STD_DB_USER: 'lector',
      STD_DB_PASS: 'x',
    });
    expect(resultado).toEqual({ disponible: false, motivo: expect.stringContaining('STD_DB_HOST') });
  });

  it('disponible cuando está habilitado y tiene host, usuario y contraseña', () => {
    const resultado = stdDisponibleCon({
      STD_HABILITADO: 'true',
      STD_DB_HOST: '192.168.1.16',
      STD_DB_USER: 'lector',
      STD_DB_PASS: 'x',
    });
    expect(resultado).toEqual({ disponible: true, motivo: null });
  });
});
