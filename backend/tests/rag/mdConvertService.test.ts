/**
 * Regresión de un bug real observado en producción (2026-08-23): un documento de 9,2 MB dejó una
 * cola de 500 conversiones congelada 45 minutos. El `AbortController` del fetch debía cortar a
 * los `MARKITDOWN_TIMEOUT_MS`, pero en el proceso real no lo hizo y no se registró ningún error —
 * la promesa de conversión simplemente nunca se resolvió. Reproducciones aisladas del mismo
 * request SÍ abortaron correctamente, así que la causa exacta no se pudo aislar (posible
 * degradación de `fetch`/undici tras cientos de peticiones seguidas, o el propio markitdown
 * quedando sordo al socket).
 *
 * Ante eso, el fix no depende de entender la causa: es una segunda garantía independiente
 * (`Promise.race` contra un temporizador) que asegura que la conversión SIEMPRE se resuelve, pase
 * lo que pase con el fetch subyacente. Este test simula exactamente el peor caso — un fetch que no
 * se resuelve ni se rechaza NUNCA, ignorando incluso la señal de abort — y verifica que aun así el
 * límite duro libera la cola.
 */

process.env.MARKITDOWN_TIMEOUT_MS = '180000';
process.env.MARKITDOWN_URL = 'http://markitdown-de-prueba:8001';

type MdConvert = typeof import('../../src/rag/mdConvertService');

let md: MdConvert;
let fetchOriginal: typeof fetch;

beforeAll(() => {
  jest.isolateModules(() => {
    md = require('../../src/rag/mdConvertService');
  });
});

beforeEach(() => {
  fetchOriginal = global.fetch;
  jest.useFakeTimers();
});

afterEach(() => {
  global.fetch = fetchOriginal;
  jest.useRealTimers();
});

describe('convertirAMarkdown — límite duro contra un fetch que jamás se resuelve', () => {
  it('rechaza tras el límite duro aunque el fetch ignore la señal de abort', async () => {
    // El peor caso real: ni resuelve, ni rechaza, ni respeta `signal.aborted` — exactamente lo
    // que se observó en producción (el AbortController no logró liberar la petición).
    global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;

    const promesa = md.convertirAMarkdown(Buffer.from('contenido de prueba'), 'documento.pdf');
    // Sin esto Jest reporta "unhandled rejection" al avanzar los timers antes de que algo
    // observe la promesa.
    const captura = promesa.catch((e: unknown) => e);

    // 180s del timeout normal + 15s de margen del límite duro.
    await jest.advanceTimersByTimeAsync(196_000);

    const error = await captura;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/límite duro/);
    expect((error as { reintentable?: boolean }).reintentable).toBe(true);
  });

  it('no dispara el límite duro si el fetch responde a tiempo', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ markdown: '# Documento de prueba' }),
    }) as unknown as typeof fetch;

    const resultado = await md.convertirAMarkdown(Buffer.from('x'), 'doc.pdf');

    expect(resultado.markdown).toBe('# Documento de prueba');
  });

  it('libera la cola para el siguiente documento tras un límite duro', async () => {
    // Primer documento: fetch colgado para siempre.
    global.fetch = jest.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    const primero = md.convertirAMarkdown(Buffer.from('a'), 'a.pdf').catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(196_000);
    const errorPrimero = await primero;
    expect((errorPrimero as Error).message).toMatch(/límite duro/);

    // Segundo documento, en la misma cola serializada: debe poder procesarse con normalidad,
    // sin quedar bloqueado detrás del primero para siempre.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ markdown: 'segundo documento' }),
    }) as unknown as typeof fetch;
    const segundo = await md.convertirAMarkdown(Buffer.from('b'), 'b.pdf');
    expect(segundo.markdown).toBe('segundo documento');
  });
});

/**
 * El único consumidor de este cliente es el job de ingesta en background (nadie espera esto en
 * vivo). Antes, con el circuito abierto, cada llamada fallaba AL INSTANTE — en un job de cientos
 * de documentos en cola, eso podía tumbar a cientos de ellos como "error" en segundos sin que
 * ninguno llegara a intentarse de verdad. Ahora debe ESPERAR el resto del reposo y solo entonces
 * reintentar — el circuito sigue protegiendo a markitdown de que lo golpeen sin parar, pero ya no
 * infla el contador de errores del job con ítems que nunca se probaron.
 *
 * Aislado en su propio `jest.isolateModules`: el circuito es estado de módulo compartido por
 * todas las llamadas, y los otros tests de este archivo ya lo disparan (el límite duro también
 * cuenta como fallo) — una instancia propia evita depender del orden de ejecución.
 */
describe('convertirAMarkdown — espera al circuito en vez de rechazar de inmediato', () => {
  let mdAislado: MdConvert;
  let fetchOriginal2: typeof fetch;

  beforeAll(() => {
    jest.isolateModules(() => {
      mdAislado = require('../../src/rag/mdConvertService');
    });
  });

  beforeEach(() => {
    fetchOriginal2 = global.fetch;
    jest.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = fetchOriginal2;
    jest.useRealTimers();
  });

  it('tras abrir el circuito, la siguiente llamada espera el reposo y reintenta de verdad', async () => {
    // 3 fallos de red seguidos abren el circuito (FALLOS_PARA_ABRIR=3).
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    for (let i = 0; i < 3; i++) {
      await expect(mdAislado.convertirAMarkdown(Buffer.from('x'), 'doc.pdf')).rejects.toThrow();
    }

    // Con el circuito ya abierto: la próxima llamada NO debe fallar al instante.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ markdown: 'recuperado' }),
    }) as unknown as typeof fetch;

    const promesa = mdAislado.convertirAMarkdown(Buffer.from('y'), 'doc2.pdf');

    // Antes de que pase el reposo (60 s), no debió intentarse ningún fetch todavía.
    await jest.advanceTimersByTimeAsync(1000);
    expect(global.fetch).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(60_000);
    const resultado = await promesa;

    expect(resultado.markdown).toBe('recuperado');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * Regresión de un incidente real (2026-09): 359 documentos acabaron en `estado='error'` terminal
 * con `markitdown HTTP 404: {"detail":"Not Found"}` porque durante una ventana el puerto 8001 lo
 * servía otra imagen, sin ese endpoint. Eran archivos perfectos, pero al clasificarse como culpa
 * del archivo quedaron fuera de la reparación gratuita y su única salida era la IA de pago.
 *
 * Un 404/405 dice "aquí no existe ese endpoint" — problema de despliegue del servicio, no del
 * archivo — así que debe ser reintentable. El resto de 4xx (400, 413, 422) sí es culpa del archivo
 * y sigue sin reintentarse.
 *
 * Módulo aislado por el mismo motivo que el bloque anterior: el circuito es estado de módulo.
 */
describe('convertirAMarkdown — de quién es la culpa según el código HTTP', () => {
  let mdHttp: MdConvert;
  let fetchOriginal3: typeof fetch;

  beforeAll(() => {
    jest.isolateModules(() => {
      mdHttp = require('../../src/rag/mdConvertService');
    });
  });

  beforeEach(() => {
    fetchOriginal3 = global.fetch;
  });

  afterEach(() => {
    global.fetch = fetchOriginal3;
  });

  async function motivoDe(status: number): Promise<{ reintentable: boolean }> {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status,
      text: async () => '{"detail":"Not Found"}',
    }) as unknown as typeof fetch;

    return mdHttp
      .convertirAMarkdown(Buffer.from('x'), 'doc.pdf')
      .then(() => ({ reintentable: false }))
      .catch((e: { reintentable: boolean }) => e);
  }

  it.each([404, 405])('HTTP %i (servicio mal desplegado) es reintentable', async (status) => {
    expect((await motivoDe(status)).reintentable).toBe(true);
  });

  it.each([400, 413, 422])('HTTP %i (culpa del archivo) no es reintentable', async (status) => {
    expect((await motivoDe(status)).reintentable).toBe(false);
  });
});

/**
 * `onFase` es lo que alimenta la barra de progreso por documento del panel de trabajos: sin estos
 * avisos, el frontend no tiene forma de distinguir "convirtiendo" de "esperando al circuito" ni de
 * saber contra qué tope interpolar. Aislado por el mismo motivo que los bloques anteriores: el
 * circuito es estado de módulo compartido.
 */
describe('convertirAMarkdown — reporte de fases para la barra de progreso', () => {
  it('TOPE_CONVERSION_MS es el timeout más el margen del límite duro', () => {
    expect(md.TOPE_CONVERSION_MS).toBe(180_000 + 15_000);
  });

  it('con el circuito cerrado reporta "en_cola_conversor" y luego "convirtiendo" con su tope', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ markdown: 'x' }),
    }) as unknown as typeof fetch;

    const fases: unknown[] = [];
    await md.convertirAMarkdown(Buffer.from('x'), 'doc.pdf', (avance) => fases.push(avance));

    expect(fases).toEqual([
      { fase: 'en_cola_conversor', proveedor: 'markitdown', limiteMs: null },
      { fase: 'convirtiendo', proveedor: 'markitdown', limiteMs: md.TOPE_CONVERSION_MS },
    ]);
  });

  it('no reventar sin onFase: sigue funcionando igual que antes de que existiera', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ markdown: 'sin observador' }),
    }) as unknown as typeof fetch;

    const resultado = await md.convertirAMarkdown(Buffer.from('x'), 'doc.pdf');
    expect(resultado.markdown).toBe('sin observador');
  });

  describe('con el circuito abierto', () => {
    let mdCircuito: MdConvert;
    let fetchOriginal4: typeof fetch;

    beforeAll(() => {
      jest.isolateModules(() => {
        mdCircuito = require('../../src/rag/mdConvertService');
      });
    });

    beforeEach(() => {
      fetchOriginal4 = global.fetch;
      jest.useFakeTimers();
    });

    afterEach(() => {
      global.fetch = fetchOriginal4;
      jest.useRealTimers();
    });

    it('reporta "esperando_circuito" con lo que queda de reposo antes de reintentar', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
      for (let i = 0; i < 3; i++) {
        await expect(mdCircuito.convertirAMarkdown(Buffer.from('x'), 'doc.pdf')).rejects.toThrow();
      }

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ markdown: 'recuperado' }),
      }) as unknown as typeof fetch;

      const fases: unknown[] = [];
      const promesa = mdCircuito.convertirAMarkdown(Buffer.from('y'), 'doc2.pdf', (avance) => fases.push(avance));

      await jest.advanceTimersByTimeAsync(60_000);
      await promesa;

      expect(fases[0]).toEqual({
        fase: 'esperando_circuito',
        proveedor: 'markitdown',
        limiteMs: 60_000,
      });
      expect(fases[1]).toEqual({ fase: 'en_cola_conversor', proveedor: 'markitdown', limiteMs: null });
      expect(fases[2]).toEqual({ fase: 'convirtiendo', proveedor: 'markitdown', limiteMs: mdCircuito.TOPE_CONVERSION_MS });
    });
  });
});
