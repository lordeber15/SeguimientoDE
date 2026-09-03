/**
 * `OpenAiVision` habla con la Responses API (`/v1/responses`), no `chat/completions` — la única
 * que acepta `input_file` con un PDF en base64. Dos trampas reales que este archivo existe para
 * atrapar: la Responses API usa `usage.input_tokens`/`output_tokens`, NO
 * `prompt_tokens`/`completion_tokens` (copiar el nombre de chat/completions compila igual y
 * registra 0 tokens en cada llamada, una factura invisible); y `output_text` no siempre viene, así
 * que hay que saber reconstruirlo desde `output[].content[]`.
 */

import { OpenAiVision } from '../../src/ai/providers/openaiVision';
import { ErrorIA } from '../../src/ai/types';

let fetchOriginal: typeof fetch;
let envOriginal: NodeJS.ProcessEnv;

beforeEach(() => {
  fetchOriginal = global.fetch;
  envOriginal = { ...process.env };
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_URL = 'https://api.openai.com/v1';
  process.env.OPENAI_VISION_MODEL = 'gpt-4o';
});

afterEach(() => {
  global.fetch = fetchOriginal;
  process.env = envOriginal;
});

function mockFetch(respuesta: { ok: boolean; status?: number; body?: unknown; texto?: string }) {
  const fn = jest.fn().mockResolvedValue({
    ok: respuesta.ok,
    status: respuesta.status ?? 200,
    json: async () => respuesta.body,
    text: async () => respuesta.texto ?? '',
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('OpenAiVision.transcribir', () => {
  it('llama a /responses con input_file en base64 antes que input_text', async () => {
    const fetchMock = mockFetch({
      ok: true,
      body: { output_text: 'texto transcrito', usage: { input_tokens: 1200, output_tokens: 300 } },
    });

    const provider = new OpenAiVision();
    const buffer = Buffer.from('%PDF-1.4 contenido de prueba');
    const resultado = await provider.transcribir(
      { nombre: 'doc.pdf', mime: 'application/pdf', datos: buffer },
      'transcribe esto',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opciones] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(opciones.headers.Authorization).toBe('Bearer sk-test');

    const cuerpo = JSON.parse(opciones.body);
    expect(cuerpo.model).toBe('gpt-4o');
    expect(cuerpo.input[0].content[0]).toEqual({
      type: 'input_file',
      filename: 'doc.pdf',
      file_data: `data:application/pdf;base64,${buffer.toString('base64')}`,
    });
    expect(cuerpo.input[0].content[1]).toEqual({ type: 'input_text', text: 'transcribe esto' });

    expect(resultado.texto).toBe('texto transcrito');
    expect(resultado.uso).toEqual({ tokensIn: 1200, tokensOut: 300, estimado: false });
  });

  it('lee usage.input_tokens/output_tokens — nombres de prompt_tokens/completion_tokens no cuentan', async () => {
    mockFetch({
      ok: true,
      // Forma de chat/completions, deliberadamente distinta: si el código leyera estos campos por
      // error, el test de arriba ya lo detectaría por comparar el objeto completo, pero este deja
      // explícito que ESTOS nombres se ignoran y el resultado es 0, no un valor leído por accidente.
      body: { output_text: 'x', prompt_tokens: 999, completion_tokens: 999 },
    });

    const provider = new OpenAiVision();
    const resultado = await provider.transcribir(
      { nombre: 'doc.pdf', mime: 'application/pdf', datos: Buffer.from('x') },
      'y',
    );

    expect(resultado.uso).toEqual({ tokensIn: 0, tokensOut: 0, estimado: true });
  });

  it('arma el texto desde output[].content[] cuando no hay output_text', async () => {
    mockFetch({
      ok: true,
      body: {
        output: [
          { type: 'reasoning', content: [] },
          { type: 'message', content: [{ type: 'output_text', text: 'primera parte ' }, { type: 'output_text', text: 'segunda parte' }] },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });

    const provider = new OpenAiVision();
    const resultado = await provider.transcribir(
      { nombre: 'doc.pdf', mime: 'application/pdf', datos: Buffer.from('x') },
      'y',
    );

    expect(resultado.texto).toBe('primera parte segunda parte');
  });

  it('un 401 se clasifica como auth y no reintenta', async () => {
    const fetchMock = mockFetch({ ok: false, status: 401, texto: 'invalid_api_key' });

    const provider = new OpenAiVision();
    await expect(
      provider.transcribir({ nombre: 'doc.pdf', mime: 'application/pdf', datos: Buffer.from('x') }, 'y'),
    ).rejects.toThrow(ErrorIA);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('una respuesta sin texto útil lanza ErrorIA en vez de guardar markdown vacío', async () => {
    mockFetch({ ok: true, body: { output_text: '   ' } });

    const provider = new OpenAiVision();
    await expect(
      provider.transcribir({ nombre: 'doc.pdf', mime: 'application/pdf', datos: Buffer.from('x') }, 'y'),
    ).rejects.toThrow(ErrorIA);
  });
});
