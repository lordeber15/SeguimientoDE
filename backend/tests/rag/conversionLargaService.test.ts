/**
 * Troceo de documentos largos: valida la orquestación de bloques (conteo, nombrado, concatenación,
 * manejo de fallos parciales) SIN volver a probar el fallback markitdown/mineru — eso ya lo cubre
 * `conversionProviderService.test.ts`. `convertirAMarkdownActivo` va mockeado por completo; el
 * troceo real del PDF (`pdfPaginasService`, cubierto en su propio test) se deja SIN mockear porque
 * es justo lo que este archivo verifica.
 */

process.env.RAG_PAGINAS_POR_BLOQUE = '3';

const convertirAMarkdownActivo = jest.fn();

jest.mock('../../src/rag/conversionProviderService', () => ({
  convertirAMarkdownActivo: (...a: unknown[]) => convertirAMarkdownActivo(...a),
}));

import { PDFDocument } from 'pdf-lib';

type ConversionLarga = typeof import('../../src/rag/conversionLargaService');
let conversionLarga: ConversionLarga;
// `jest.isolateModules` da a `conversionLargaService.ts` su propio registro de módulos, así que la
// `ConversionError` que lanza por dentro (al fallar TODOS los bloques) NO es la misma clase que
// devolvería un `import` suelto en este archivo — hay que capturarla del MISMO registro aislado
// para que `instanceof`/`toBeInstanceOf` funcionen (mismo patrón que `ingestaService.test.ts`).
let ConversionError: typeof import('../../src/rag/mdConvertService').ConversionError;

beforeAll(() => {
  jest.isolateModules(() => {
    conversionLarga = require('../../src/rag/conversionLargaService');
    ConversionError = require('../../src/rag/mdConvertService').ConversionError;
  });
});

beforeEach(() => {
  convertirAMarkdownActivo.mockReset();
});

async function pdfDePrueba(paginas: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < paginas; i++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

describe('convertirPorBloques — orden y concatenación', () => {
  it('convierte cada bloque por separado y concatena el markdown en orden', async () => {
    const buffer = await pdfDePrueba(7); // con bloques de 3: [1-3] [4-6] [7-7]
    convertirAMarkdownActivo
      .mockResolvedValueOnce({ markdown: 'BLOQUE 1', ms: 100, metodo: 'markitdown' })
      .mockResolvedValueOnce({ markdown: 'BLOQUE 2', ms: 100, metodo: 'markitdown' })
      .mockResolvedValueOnce({ markdown: 'BLOQUE 3', ms: 100, metodo: 'markitdown' });

    const resultado = await conversionLarga.convertirPorBloques(buffer, 'informe.pdf');

    expect(resultado.markdown).toBe('BLOQUE 1\n\nBLOQUE 2\n\nBLOQUE 3');
    expect(resultado.metodo).toBe('markitdown-bloques');
    expect(resultado.ms).toBe(300);
    expect(convertirAMarkdownActivo).toHaveBeenCalledTimes(3);
  });

  /** markitdown detecta el tipo de archivo por la EXTENSIÓN del nombre: sin conservarla, cada
   *  bloque se rechazaría con 400 igual que un título humano sin extensión (ver el comentario en
   *  `ingestaService.convertirDocumento`). */
  it('nombra cada bloque conservando la extensión real, con el rango de páginas', async () => {
    const buffer = await pdfDePrueba(4); // bloques de 3: [1-3] [4-4]
    convertirAMarkdownActivo.mockResolvedValue({ markdown: 'x', ms: 1, metodo: 'markitdown' });

    await conversionLarga.convertirPorBloques(buffer, 'INFORME N 29.pdf');

    const nombres = convertirAMarkdownActivo.mock.calls.map((llamada) => llamada[1]);
    expect(nombres).toEqual(['INFORME N 29.p0001-0003.pdf', 'INFORME N 29.p0004-0004.pdf']);
  });

  it('reenvía onLatido una vez por bloque procesado, sin importar si tuvo éxito', async () => {
    const buffer = await pdfDePrueba(5); // bloques de 3: [1-3] [4-5]
    convertirAMarkdownActivo
      .mockResolvedValueOnce({ markdown: 'ok', ms: 1, metodo: 'markitdown' })
      .mockRejectedValueOnce(new ConversionError('falló este bloque', true));
    const onLatido = jest.fn().mockResolvedValue(undefined);

    await conversionLarga.convertirPorBloques(buffer, 'x.pdf', undefined, onLatido);

    expect(onLatido).toHaveBeenCalledTimes(2);
  });
});

describe('convertirPorBloques — un bloque fallido no tumba el documento', () => {
  it('deja un marcador explícito en su lugar y sigue con el resto', async () => {
    const buffer = await pdfDePrueba(6); // bloques de 3: [1-3] [4-6]
    convertirAMarkdownActivo
      .mockResolvedValueOnce({ markdown: 'BLOQUE OK', ms: 100, metodo: 'markitdown' })
      .mockRejectedValueOnce(new ConversionError('markitdown HTTP 500', true));

    const resultado = await conversionLarga.convertirPorBloques(buffer, 'x.pdf');

    expect(resultado.markdown).toContain('BLOQUE OK');
    expect(resultado.markdown).toMatch(/No se pudo extraer el texto de las páginas 4–6: markitdown HTTP 500/);
    expect(resultado.advertencia).toMatch(/1 de 2 bloques no se pudieron convertir/);
  });

  it('si TODOS los bloques fallan, lanza ConversionError reintentable en vez de "convertir" solo marcadores', async () => {
    const buffer = await pdfDePrueba(6);
    convertirAMarkdownActivo.mockRejectedValue(new ConversionError('circuito abierto', true));

    const promesa = conversionLarga.convertirPorBloques(buffer, 'x.pdf');

    await expect(promesa).rejects.toBeInstanceOf(ConversionError);
    await expect(promesa).rejects.toMatchObject({ reintentable: true });
  });
});

describe('convertirPorBloques — el "método" ganador es quien resolvió más bloques', () => {
  it('si el circuito cambia a mitad de camino, el método refleja la mayoría, no el primero', async () => {
    const buffer = await pdfDePrueba(9); // bloques de 3: tres bloques exactos
    convertirAMarkdownActivo
      .mockResolvedValueOnce({ markdown: 'a', ms: 1, metodo: 'mineru' })
      .mockResolvedValueOnce({ markdown: 'b', ms: 1, metodo: 'mineru' })
      .mockResolvedValueOnce({ markdown: 'c', ms: 1, metodo: 'markitdown' });

    const resultado = await conversionLarga.convertirPorBloques(buffer, 'x.pdf');

    expect(resultado.metodo).toBe('mineru-bloques');
  });
});
