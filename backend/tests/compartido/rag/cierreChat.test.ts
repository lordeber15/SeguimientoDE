const leerConfig = jest.fn();
jest.mock('../../../src/compartido/rag/configService', () => ({
  leerConfig: (...a: unknown[]) => leerConfig(...a),
}));

import { filtroGratis, mensajeFijo, MENSAJES_FIJOS_POR_DEFECTO } from '../../../src/compartido/rag/cierreChat';

describe('filtroGratis', () => {
  it.each(['hola', '¡Hola!', 'Buenos días', 'gracias', 'Muchas gracias.', '¿Qué puedes hacer?', 'ok'])(
    '"%s" se contesta sin planificador', (m) => {
      expect(filtroGratis(m)).toBe('ayuda');
    },
  );

  it.each([
    'hola, dame los expedientes de Junín',
    'dame los expedientes de la obra Huancavelica',
    'gracias, ¿y cuántos son?',
    '',
  ])('"%s" NO es trivial: tiene que llegar al planificador', (m) => {
    expect(filtroGratis(m)).toBeNull();
  });
});

describe('mensajeFijo', () => {
  beforeEach(() => leerConfig.mockReset());

  it('usa el texto de app.config si existe', async () => {
    leerConfig.mockResolvedValue('Texto propio');
    expect(await mensajeFijo('sin_resultados')).toBe('Texto propio');
  });

  it('cae al texto por defecto si falta la fila o la BD falla', async () => {
    leerConfig.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('bd caída'));
    expect(await mensajeFijo('ayuda')).toBe(MENSAJES_FIJOS_POR_DEFECTO.ayuda);
    expect(await mensajeFijo('fuera_de_alcance')).toBe(MENSAJES_FIJOS_POR_DEFECTO.fuera_de_alcance);
  });
});
