/**
 * `OllamaVision` no puede mandar el PDF: Ollama solo acepta imágenes. Lo que este archivo fija es
 * el troceo página a página (una llamada por página, en orden, con la imagen en `images`), que las
 * páginas en blanco no rompan el documento y que el tope de páginas se aplique ANTES de rasterizar.
 */

jest.mock('../../../../src/compartido/services/pdfPaginasService', () => ({
  contarPaginas: jest.fn(),
}));
jest.mock('../../../../src/compartido/services/pdfRasterService', () => ({
  rasterizarPdf: jest.fn(),
}));

import { mismoModeloOllama, modelosOllamaVision, OllamaVision } from '../../../../src/compartido/ai/providers/ollamaVision';
import { ErrorIA } from '../../../../src/compartido/ai/types';
import { contarPaginas } from '../../../../src/compartido/services/pdfPaginasService';
import { rasterizarPdf } from '../../../../src/compartido/services/pdfRasterService';

const contarPaginasMock = contarPaginas as jest.MockedFunction<typeof contarPaginas>;
const rasterizarMock = rasterizarPdf as jest.MockedFunction<typeof rasterizarPdf>;

let fetchOriginal: typeof fetch;

beforeEach(() => {
  fetchOriginal = global.fetch;
  process.env.OLLAMA_URL = 'http://ollama:11434';
});

afterEach(() => {
  global.fetch = fetchOriginal;
});

function mockFetch(textos: string[]) {
  const fn = jest.fn();
  for (const texto of textos) {
    fn.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ message: { content: texto }, prompt_eval_count: 100, eval_count: 20 }),
      text: async () => '',
    });
  }
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

function paginas(n: number) {
  return (async function* () {
    for (let i = 1; i <= n; i++) yield { numero: i, png: Buffer.from(`png${i}`) };
  })();
}

const pdf = { nombre: 'doc.pdf', mime: 'application/pdf', datos: Buffer.from('%PDF-1.4') };

describe('OllamaVision.transcribir', () => {
  it('transcribe un PDF página a página, en orden, y suma el uso', async () => {
    contarPaginasMock.mockResolvedValue(2);
    rasterizarMock.mockReturnValue(paginas(2));
    const fetchMock = mockFetch(['Texto uno', 'Texto dos']);
    const onPagina = jest.fn();

    const r = await new OllamaVision('qwen2.5vl').transcribir(pdf, 'transcribe', { onPagina });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, opciones] = fetchMock.mock.calls[0];
    expect(url).toBe('http://ollama:11434/api/chat');
    const cuerpo = JSON.parse(opciones.body);
    expect(cuerpo.model).toBe('qwen2.5vl');
    expect(cuerpo.messages[0]).toEqual({
      role: 'user',
      content: 'transcribe',
      images: [Buffer.from('png1').toString('base64')],
    });
    expect(r.texto).toBe('Texto uno\n\nTexto dos');
    expect(r.uso).toEqual({ tokensIn: 200, tokensOut: 40, estimado: false });
    expect(onPagina.mock.calls).toEqual([[1, 2], [2, 2]]);
  });

  it('omite las páginas en blanco sin fallar el documento', async () => {
    contarPaginasMock.mockResolvedValue(2);
    rasterizarMock.mockReturnValue(paginas(2));
    mockFetch(['   ', 'Solo esta']);

    const r = await new OllamaVision('m').transcribir(pdf, 'x');
    expect(r.texto).toBe('Solo esta');
  });

  it('falla si ninguna página devolvió texto', async () => {
    contarPaginasMock.mockResolvedValue(1);
    rasterizarMock.mockReturnValue(paginas(1));
    mockFetch(['']);

    await expect(new OllamaVision('m').transcribir(pdf, 'x')).rejects.toBeInstanceOf(ErrorIA);
  });

  it('rechaza un PDF por encima del tope de páginas sin rasterizar nada', async () => {
    contarPaginasMock.mockResolvedValue(10_000);
    const fetchMock = mockFetch([]);

    await expect(new OllamaVision('m').transcribir(pdf, 'x')).rejects.toThrow(/límite/);
    expect(rasterizarMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('una imagen va en una sola llamada, sin rasterizar', async () => {
    const fetchMock = mockFetch(['texto de la imagen']);
    const r = await new OllamaVision('m').transcribir(
      { nombre: 'a.png', mime: 'image/png', datos: Buffer.from('img') },
      'x',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rasterizarMock).not.toHaveBeenCalled();
    expect(r.texto).toBe('texto de la imagen');
  });
});

describe('modelosOllamaVision', () => {
  it('deja solo los modelos con la capacidad "vision" de /api/show', async () => {
    const fn = jest.fn(async (url: string, opciones?: { body?: string }) => {
      if (url.endsWith('/api/tags')) {
        return { ok: true, json: async () => ({ models: [{ name: 'bge-m3:latest' }, { name: 'qwen2.5vl:3b' }] }) };
      }
      const { model } = JSON.parse(opciones?.body ?? '{}');
      const capabilities = model === 'qwen2.5vl:3b' ? ['completion', 'vision'] : ['embedding'];
      return { ok: true, json: async () => ({ capabilities }) };
    });
    global.fetch = fn as unknown as typeof fetch;

    await expect(modelosOllamaVision()).resolves.toEqual(['qwen2.5vl:3b']);
  });
});

describe('mismoModeloOllama', () => {
  it('sin etiqueta es :latest, no cualquier variante', () => {
    expect(mismoModeloOllama('qwen2.5vl', 'qwen2.5vl:latest')).toBe(true);
    expect(mismoModeloOllama('qwen2.5vl', 'qwen2.5vl:3b')).toBe(false);
  });
});
