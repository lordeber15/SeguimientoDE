// La resolución `node` de este tsconfig no lee el campo `exports`: los tipos se importan por ruta.
import type * as MuPdf from 'mupdf/dist/mupdf';

/**
 * Rasteriza las páginas de un PDF a PNG con MuPDF (WASM: sin binarios del sistema, funciona igual
 * en el contenedor alpine que en el host Windows). Lo necesita `OllamaVision`: los modelos de
 * visión de Ollama reciben IMÁGENES, no PDFs, a diferencia de la Responses API de OpenAI.
 *
 * `mupdf` es solo ESM y con top-level await, así que este proyecto CommonJS no puede `require`lo:
 * `import()` a secas lo reescribiría tsc a `require()`. El `Function` conserva el `import()` real.
 */

const importarEsm = new Function('especificador', 'return import(especificador)') as (
  especificador: string,
) => Promise<typeof MuPdf>;

let modulo: Promise<typeof MuPdf> | null = null;

function cargarMuPdf(): Promise<typeof MuPdf> {
  modulo ??= importarEsm('mupdf');
  return modulo;
}

/** 150 DPI: suficiente para que un modelo de visión lea un escaneo sin que cada PNG pese varios MB. */
const DPI_POR_DEFECTO = Number(process.env.RAG_VISION_DPI ?? 150);

export interface PaginaRasterizada {
  /** 1-indexada. */
  numero: number;
  png: Buffer;
}

/**
 * Generador perezoso: una página en memoria a la vez, como `partirEnBloques`. Lanza si el buffer no
 * es un PDF legible — quien llama lo traduce a su error de dominio.
 */
export async function* rasterizarPdf(
  buffer: Buffer,
  opciones: { dpi?: number; maxPaginas?: number } = {},
): AsyncGenerator<PaginaRasterizada> {
  const mupdf = await cargarMuPdf();
  const escala = (opciones.dpi ?? DPI_POR_DEFECTO) / 72;
  const documento = mupdf.Document.openDocument(buffer, 'application/pdf');

  try {
    const total = documento.countPages();
    const limite = Math.min(total, opciones.maxPaginas ?? total);

    for (let i = 0; i < limite; i++) {
      const pagina = documento.loadPage(i);
      const pixmap = pagina.toPixmap(mupdf.Matrix.scale(escala, escala), mupdf.ColorSpace.DeviceRGB, false, true);
      try {
        yield { numero: i + 1, png: Buffer.from(pixmap.asPNG()) };
      } finally {
        pixmap.destroy();
        pagina.destroy();
      }
    }
  } finally {
    documento.destroy();
  }
}
