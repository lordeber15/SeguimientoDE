/**
 * Alertas por webhook (docs/PLAN-RAG-AVANZADO.md, Fase 2): nunca deben lanzar, tienen que limitarse
 * por tipo para no inundar el canal, y deben contar lo que se omitió.
 */

import { alertar, reiniciarAlertas } from '../../../src/compartido/observabilidad/alertas';

let fetchOriginal: typeof fetch;
let envOriginal: NodeJS.ProcessEnv;
const fetchMock = jest.fn();

beforeEach(() => {
  fetchOriginal = global.fetch;
  envOriginal = { ...process.env };
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
  process.env.ALERTA_WEBHOOK_URL = 'https://hooks.example/abc';
  process.env.ALERTA_INTERVALO_MIN = '10';
  reiniciarAlertas();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  global.fetch = fetchOriginal;
  process.env = envOriginal;
  jest.restoreAllMocks();
});

const cuerpoDe = (i: number) => JSON.parse(fetchMock.mock.calls[i][1].body);

it('envía un POST JSON con text (Slack/Teams) y content (Discord) además de los campos', async () => {
  alertar('proveedor_ia', 'openai: HTTP 503', { proveedor: 'openai' });
  await new Promise((r) => setImmediate(r));

  expect(fetchMock).toHaveBeenCalledWith('https://hooks.example/abc', expect.objectContaining({ method: 'POST' }));
  expect(cuerpoDe(0)).toMatchObject({
    text: '[seguimiento] proveedor_ia: openai: HTTP 503',
    content: '[seguimiento] proveedor_ia: openai: HTTP 503',
    tipo: 'proveedor_ia',
    detalle: { proveedor: 'openai' },
  });
});

it('limita a una por tipo y clave en el intervalo, y la siguiente informa cuántas se omitieron', async () => {
  const ahora = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  alertar('vectorial_degradada', 'a', {}, 'sgd');
  alertar('vectorial_degradada', 'b', {}, 'sgd');
  alertar('vectorial_degradada', 'c', {}, 'sgd');
  alertar('vectorial_degradada', 'otro módulo', {}, 'std'); // otra clave: no se silencia
  expect(fetchMock).toHaveBeenCalledTimes(2);

  ahora.mockReturnValue(1_000_000 + 11 * 60_000);
  alertar('vectorial_degradada', 'd', {}, 'sgd');
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(cuerpoDe(2)).toMatchObject({ omitidas: 2 });
  expect(cuerpoDe(2).text).toContain('(+2 similares omitidas)');
});

it('sin ALERTA_WEBHOOK_URL no llama a nada (solo log)', () => {
  delete process.env.ALERTA_WEBHOOK_URL;
  alertar('chat_error', 'x');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('chat_error'));
});

it('un webhook caído no lanza', async () => {
  fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
  expect(() => alertar('chat_error', 'x')).not.toThrow();
  await new Promise((r) => setImmediate(r));
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
});
