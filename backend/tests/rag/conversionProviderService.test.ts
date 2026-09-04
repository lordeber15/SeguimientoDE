/**
 * El orquestador de conversores: markitdown primero, mineru si el primero falla.
 *
 * Los dos clientes van mockeados — lo que se prueba aquí es la política (a quién se llama, en qué
 * orden, qué se registra como método, y cómo se combina el fallo cuando ninguno lo consigue), no
 * el HTTP de cada uno, que ya tienen sus propios tests.
 *
 * `ConversionError` se toma del módulo REAL: el `reintentable` que lleva dentro es justo lo que
 * decide si un documento vuelve a `pendiente` o se quema a `error` terminal, así que la prueba no
 * puede usar un doble que se comporte distinto.
 */
jest.mock('../../src/rag/mdConvertService', () => {
  const real = jest.requireActual('../../src/rag/mdConvertService');
  return {
    ConversionError: real.ConversionError,
    convertirAMarkdown: jest.fn(),
    estadoCircuito: jest.fn(() => ({ abierto: false, segundosRestantes: 0 })),
  };
});
jest.mock('../../src/rag/mineruConvertService', () => ({
  convertirAMarkdownMinerU: jest.fn(),
  estadoCircuitoMinerU: jest.fn(() => ({ abierto: false, segundosRestantes: 0 })),
}));

import {
  conversionBloqueada,
  convertirAMarkdownActivo,
  proveedorRespaldo,
} from '../../src/rag/conversionProviderService';
import { ConversionError, convertirAMarkdown, estadoCircuito } from '../../src/rag/mdConvertService';
import { convertirAMarkdownMinerU, estadoCircuitoMinerU } from '../../src/rag/mineruConvertService';

const markitdown = convertirAMarkdown as jest.Mock;
const mineru = convertirAMarkdownMinerU as jest.Mock;
const circuitoMarkitdown = estadoCircuito as jest.Mock;
const circuitoMineru = estadoCircuitoMinerU as jest.Mock;

const CERRADO = { abierto: false, segundosRestantes: 0 };
const ABIERTO = { abierto: true, segundosRestantes: 42 };

beforeEach(() => {
  jest.clearAllMocks();
  circuitoMarkitdown.mockReturnValue(CERRADO);
  circuitoMineru.mockReturnValue(CERRADO);
  process.env.RAG_CONVERTER_PROVIDER = 'markitdown';
  delete process.env.RAG_CONVERTER_FALLBACK;
});

describe('convertirAMarkdownActivo — camino feliz y fallback', () => {
  it('si markitdown lo consigue, mineru ni se toca y el método es markitdown', async () => {
    markitdown.mockResolvedValue({ markdown: '# ok', ms: 10 });

    const resultado = await convertirAMarkdownActivo(Buffer.from('x'), 'doc.pdf');

    expect(resultado).toEqual({ markdown: '# ok', ms: 10, metodo: 'markitdown' });
    expect(mineru).not.toHaveBeenCalled();
  });

  it('si markitdown falla, reintenta el MISMO documento con mineru y registra ese método', async () => {
    markitdown.mockRejectedValue(new ConversionError('markitdown HTTP 400', false));
    mineru.mockResolvedValue({ markdown: '# rescatado', ms: 900 });

    const resultado = await convertirAMarkdownActivo(Buffer.from('x'), 'doc.pdf');

    expect(resultado).toEqual({ markdown: '# rescatado', ms: 900, metodo: 'mineru' });
    expect(mineru).toHaveBeenCalledWith(expect.any(Buffer), 'doc.pdf');
  });

  /** Fue decisión explícita: un servicio caído también dispara el respaldo, no solo un archivo
   *  que el primero rechace. */
  it('un fallo de servicio (timeout, red) también dispara el respaldo', async () => {
    markitdown.mockRejectedValue(new ConversionError('La conversión superó 180 s', true));
    mineru.mockResolvedValue({ markdown: 'texto', ms: 1000 });

    const resultado = await convertirAMarkdownActivo(Buffer.from('x'), 'doc.pdf');

    expect(resultado.metodo).toBe('mineru');
  });

  it('con el proveedor invertido, el respaldo es markitdown', async () => {
    process.env.RAG_CONVERTER_PROVIDER = 'mineru';
    mineru.mockRejectedValue(new ConversionError('mineru HTTP 400', false));
    markitdown.mockResolvedValue({ markdown: 'al revés', ms: 5 });

    const resultado = await convertirAMarkdownActivo(Buffer.from('x'), 'doc.pdf');

    expect(resultado.metodo).toBe('markitdown');
    expect(proveedorRespaldo()).toBe('markitdown');
  });
});

describe('convertirAMarkdownActivo — cuando el respaldo no puede ayudar', () => {
  it('sin respaldo configurado, relanza el error original sin llamar a nadie más', async () => {
    process.env.RAG_CONVERTER_FALLBACK = 'ninguno';
    markitdown.mockRejectedValue(new ConversionError('markitdown HTTP 400', false));

    await expect(convertirAMarkdownActivo(Buffer.from('x'), 'doc.pdf')).rejects.toThrow('markitdown HTTP 400');
    expect(mineru).not.toHaveBeenCalled();
    expect(proveedorRespaldo()).toBeNull();
  });

  /** El cliente del respaldo ESPERA bloqueando lo que le quede al circuito abierto. Como respaldo
   *  eso sería sumar hasta un minuto muerto por documento para acabar fallando igual. */
  it('con el circuito del respaldo abierto, no lo llama y devuelve el fallo del primero', async () => {
    circuitoMineru.mockReturnValue(ABIERTO);
    markitdown.mockRejectedValue(new ConversionError('markitdown HTTP 500', true));

    await expect(convertirAMarkdownActivo(Buffer.from('x'), 'doc.pdf')).rejects.toThrow('markitdown HTTP 500');
    expect(mineru).not.toHaveBeenCalled();
  });

  it('si ambos fallan, el motivo dice qué pasó en cada conversor', async () => {
    markitdown.mockRejectedValue(new ConversionError('markitdown HTTP 400', false));
    mineru.mockRejectedValue(new ConversionError('mineru no pudo procesar el archivo', false));

    const error = await convertirAMarkdownActivo(Buffer.from('x'), 'doc.pdf').catch((e) => e);

    expect(error.message).toBe(
      'markitdown: markitdown HTTP 400 | mineru: mineru no pudo procesar el archivo',
    );
  });
});

/**
 * `reintentable` decide el destino del documento: `false` lo quema a `error` terminal, del que
 * hoy solo se sale con la extracción por IA de pago. Por eso se combina con OR, no con AND — basta
 * con que UNO de los dos fallos haya podido ser transitorio para merecer otra pasada.
 */
describe('convertirAMarkdownActivo — reintentable es la disyunción de los dos fallos', () => {
  it.each([
    ['ambos definitivos', false, false, false],
    ['solo el respaldo transitorio', false, true, true],
    ['solo el primero transitorio', true, false, true],
    ['ambos transitorios', true, true, true],
  ])('%s ⇒ reintentable=%s||%s = %s', async (_caso, aRetry, bRetry, esperado) => {
    markitdown.mockRejectedValue(new ConversionError('fallo A', aRetry as boolean));
    mineru.mockRejectedValue(new ConversionError('fallo B', bRetry as boolean));

    const error = await convertirAMarkdownActivo(Buffer.from('x'), 'doc.pdf').catch((e) => e);

    expect(error).toBeInstanceOf(ConversionError);
    expect(error.reintentable).toBe(esperado);
  });
});

/**
 * `onFase` es lo que le dice a la barra de progreso del panel de trabajos en qué intento va y por
 * qué se cayó el anterior — el orquestador es la ÚNICA capa que conoce ese contexto, así que es la
 * única que debe poder añadirlo a lo que reporta cada conversor.
 */
describe('convertirAMarkdownActivo — onFase reporta el detalle del fallback', () => {
  it('sin onFase, ningún cliente recibe un tercer argumento', async () => {
    markitdown.mockResolvedValue({ markdown: 'x', ms: 1 });

    await convertirAMarkdownActivo(Buffer.from('x'), 'doc.pdf');

    expect(markitdown).toHaveBeenCalledWith(expect.any(Buffer), 'doc.pdf');
  });

  it('sin respaldo, el único intento se anota como 1 de 1', async () => {
    process.env.RAG_CONVERTER_FALLBACK = 'ninguno';
    markitdown.mockResolvedValue({ markdown: 'x', ms: 1 });
    const onFase = jest.fn();

    await convertirAMarkdownActivo(Buffer.from('x'), 'doc.pdf', onFase);

    const observadorPasado = markitdown.mock.calls[0][2] as (a: unknown) => void;
    observadorPasado({ fase: 'convirtiendo', proveedor: 'markitdown', limiteMs: 195_000 });
    expect(onFase).toHaveBeenCalledWith({
      fase: 'convirtiendo',
      proveedor: 'markitdown',
      limiteMs: 195_000,
      intento: 1,
      intentos: 1,
    });
  });

  it('con respaldo, el primer intento ya sabe que hay dos por delante', async () => {
    markitdown.mockResolvedValue({ markdown: 'x', ms: 1 });
    const onFase = jest.fn();

    await convertirAMarkdownActivo(Buffer.from('x'), 'doc.pdf', onFase);

    const observadorPasado = markitdown.mock.calls[0][2] as (a: unknown) => void;
    observadorPasado({ fase: 'en_cola_conversor', proveedor: 'markitdown', limiteMs: null });
    expect(onFase).toHaveBeenCalledWith(
      expect.objectContaining({ intento: 1, intentos: 2, proveedor: 'markitdown' }),
    );
  });

  it('al caer al respaldo, el segundo intento lleva el motivo del primer fallo', async () => {
    markitdown.mockRejectedValue(new ConversionError('markitdown HTTP 500', true));
    mineru.mockResolvedValue({ markdown: 'rescatado', ms: 900 });
    const onFase = jest.fn();

    await convertirAMarkdownActivo(Buffer.from('x'), 'doc.pdf', onFase);

    const observadorMineru = mineru.mock.calls[0][2] as (a: unknown) => void;
    observadorMineru({ fase: 'convirtiendo', proveedor: 'mineru', limiteMs: 315_000 });
    expect(onFase).toHaveBeenCalledWith({
      fase: 'convirtiendo',
      proveedor: 'mineru',
      limiteMs: 315_000,
      intento: 2,
      intentos: 2,
      motivoFallback: 'markitdown: markitdown HTTP 500',
    });
  });
});

describe('conversionBloqueada — solo si NINGUNA vía está disponible', () => {
  it('con el activo abierto pero el respaldo sano, no bloquea', () => {
    circuitoMarkitdown.mockReturnValue(ABIERTO);

    expect(conversionBloqueada().bloqueada).toBe(false);
  });

  it('con los dos circuitos abiertos, bloquea y espera al primero que vuelva', () => {
    circuitoMarkitdown.mockReturnValue({ abierto: true, segundosRestantes: 50 });
    circuitoMineru.mockReturnValue({ abierto: true, segundosRestantes: 12 });

    expect(conversionBloqueada()).toEqual({ bloqueada: true, segundosRestantes: 12 });
  });

  it('sin respaldo, depende solo del activo', () => {
    process.env.RAG_CONVERTER_FALLBACK = 'ninguno';
    circuitoMarkitdown.mockReturnValue(ABIERTO);

    expect(conversionBloqueada()).toEqual({ bloqueada: true, segundosRestantes: 42 });
  });
});
