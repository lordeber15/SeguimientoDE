/**
 * Cliente HTTP de los proveedores de IA (docs/PLAN-RAG-AVANZADO.md, Fase 2): cuántas veces reintenta
 * (opción, contexto o variable), cuánto espera (Retry-After o exponencial con jitter), qué NO reintenta
 * y que el fallo final alerte y quede como evento en la traza.
 */

const alertar = jest.fn();
jest.mock('../../../src/compartido/observabilidad/alertas', () => ({ alertar: (...a: unknown[]) => alertar(...a) }));

import { esperaDeRetryAfter, esperaExponencial, postJson } from '../../../src/compartido/ai/http';
import { ErrorIA } from '../../../src/compartido/ai/types';
import { conReintentos, enTraza, type Traza } from '../../../src/compartido/observabilidad/traza';

let fetchOriginal: typeof fetch;
const fetchMock = jest.fn();

const respuesta = (status: number, cuerpo = '', cabeceras: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k: string) => cabeceras[k.toLowerCase()] ?? null },
  json: async () => JSON.parse(cuerpo || '{}'),
  text: async () => cuerpo,
});

const opciones = { url: 'https://api.x/v1', cuerpo: {}, cabeceras: {}, proveedor: 'openai' as const, timeoutMs: 1000 };

beforeEach(() => {
  fetchOriginal = global.fetch;
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  alertar.mockReset();
  jest.useFakeTimers();
});

afterEach(() => {
  global.fetch = fetchOriginal;
  jest.useRealTimers();
  delete process.env.IA_REINTENTOS;
});

/** Avanza los timers mientras la promesa no se resuelva (las esperas entre reintentos). */
async function correr<T>(p: Promise<T>): Promise<T> {
  let listo = false;
  const r = p.finally(() => { listo = true; });
  r.catch(() => undefined);
  while (!listo) await jest.advanceTimersByTimeAsync(1000);
  return r;
}

describe('postJson — reintentos', () => {
  it('reintenta un 503 y devuelve la respuesta buena', async () => {
    fetchMock.mockResolvedValueOnce(respuesta(503)).mockResolvedValueOnce(respuesta(200, '{"ok":1}'));
    await expect(correr(postJson(opciones))).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(alertar).not.toHaveBeenCalled();
  });

  it('agotados los reintentos, lanza ErrorIA y alerta una vez', async () => {
    fetchMock.mockResolvedValue(respuesta(503, 'down'));
    await expect(correr(postJson(opciones))).rejects.toMatchObject({ tipo: 'unavailable', status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + IA_REINTENTOS por defecto (2)
    expect(alertar).toHaveBeenCalledTimes(1);
    expect(alertar.mock.calls[0][0]).toBe('proveedor_ia');
  });

  it('el número de reintentos sale de la opción, luego del contexto, luego de IA_REINTENTOS', async () => {
    fetchMock.mockResolvedValue(respuesta(503));
    await correr(postJson({ ...opciones, reintentos: 0 })).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    await correr(conReintentos(1, () => postJson(opciones))).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockClear();
    process.env.IA_REINTENTOS = '3';
    await correr(postJson(opciones)).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('no reintenta auth, context_length ni quota; context_length no alerta', async () => {
    fetchMock.mockResolvedValue(respuesta(401));
    await expect(correr(postJson(opciones))).rejects.toMatchObject({ tipo: 'auth' });
    fetchMock.mockResolvedValue(respuesta(429, 'insufficient_quota'));
    await expect(correr(postJson(opciones))).rejects.toMatchObject({ tipo: 'quota' });
    fetchMock.mockResolvedValue(respuesta(413));
    await expect(correr(postJson(opciones))).rejects.toBeInstanceOf(ErrorIA);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(alertar).toHaveBeenCalledTimes(2);
  });

  it('cada reintento queda como evento WARNING en la traza en curso', async () => {
    fetchMock.mockResolvedValueOnce(respuesta(429, 'slow down', { 'retry-after': '2' })).mockResolvedValueOnce(respuesta(200, '{}'));
    let traza!: Traza;
    await correr(enTraza({ nombre: 't', modulo: 'sgd', db: {} as never, usuarioId: 'u' }, async (t) => {
      traza = t;
      await postJson(opciones);
    }));
    expect(traza.pasos).toHaveLength(1);
    expect(traza.pasos[0]).toMatchObject({
      nombre: 'reintento_ia', tipo: 'evento', nivel: 'WARNING',
      entrada: { proveedor: 'openai', intento: 1, tipo: 'rate_limit', status: 429, esperaMs: 2000 },
    });
  });
});

describe('esperas', () => {
  it('Retry-After en segundos o fecha HTTP, con tope de 30 s', () => {
    expect(esperaDeRetryAfter('3')).toBe(3000);
    expect(esperaDeRetryAfter('120')).toBe(30_000);
    expect(esperaDeRetryAfter(new Date(10_000).toUTCString(), 5_000)).toBe(5_000);
    expect(esperaDeRetryAfter(null)).toBeNull();
    expect(esperaDeRetryAfter('mañana')).toBeNull();
  });

  it('exponencial con jitter ×0,5–1,5', () => {
    expect(esperaExponencial(0, 0)).toBe(500);
    expect(esperaExponencial(0, 1)).toBe(1500);
    expect(esperaExponencial(2, 0.5)).toBe(4000);
    expect(esperaExponencial(10, 1)).toBe(30_000);
  });
});
