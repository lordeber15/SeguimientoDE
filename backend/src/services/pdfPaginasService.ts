import { PDFDocument as PdfLib } from 'pdf-lib';

/**
 * Utilidades de PDF compartidas por `unirPdfService.ts` (fusión de expedientes) y
 * `conversionLargaService.ts` (troceo de documentos largos para la conversión a Markdown).
 *
 * Vive en `services/`, no en `rag/`: es genérico de PDF, sin ninguna noción de ingesta ni de
 * markitdown/mineru.
 */

/**
 * Carga un PDF con `pdf-lib`, tolerando basura antes de la cabecera `%PDF-` (frecuente en los
 * archivos del SGD) y PDFs cifrados sin contraseña real (`ignoreEncryption`).
 *
 * Extraída tal cual de la función homónima que tenía `unirPdfService.ts` — ese módulo ahora
 * importa esta.
 */
export async function cargarPdf(buffer: Buffer): Promise<PdfLib> {
  if (!buffer.subarray(0, 1024).includes('%PDF-')) {
    throw new Error('El archivo no es un PDF');
  }

  try {
    return await PdfLib.load(buffer, { ignoreEncryption: true });
  } catch {
    throw new Error('PDF corrupto o cifrado');
  }
}

/**
 * Número de páginas de un PDF, o `null` si el buffer no es un PDF válido (o no carga por
 * cualquier otro motivo). NUNCA lanza: es una utilidad "best effort" para decidir si un
 * documento necesita troceo — un fallo aquí no puede romper una conversión que hoy funciona,
 * simplemente cae al camino sin trocear.
 */
export async function contarPaginas(buffer: Buffer): Promise<number | null> {
  try {
    const pdf = await cargarPdf(buffer);
    return pdf.getPageCount();
  } catch {
    return null;
  }
}

export interface BloquePdf {
  buffer: Buffer;
  /** Página inicial del bloque, 1-indexada (para el texto de los marcadores al usuario). */
  desde: number;
  /** Página final del bloque, 1-indexada, inclusive. */
  hasta: number;
}

/**
 * Parte un PDF en bloques de `paginasPorBloque` páginas consecutivas, cada uno como un PDF
 * independiente. Generador perezoso: arma un bloque por iteración en vez de materializar todos
 * de una vez, para no tener N buffers completos en memoria a la vez con un PDF de 50 MB.
 */
export async function* partirEnBloques(
  buffer: Buffer,
  paginasPorBloque: number,
): AsyncGenerator<BloquePdf> {
  const origen = await cargarPdf(buffer);
  const total = origen.getPageCount();

  for (let inicio = 0; inicio < total; inicio += paginasPorBloque) {
    const fin = Math.min(inicio + paginasPorBloque, total);
    const indices = Array.from({ length: fin - inicio }, (_, i) => inicio + i);

    const bloque = await PdfLib.create();
    const paginas = await bloque.copyPages(origen, indices);
    for (const pagina of paginas) bloque.addPage(pagina);

    yield {
      buffer: Buffer.from(await bloque.save()),
      desde: inicio + 1,
      hasta: fin,
    };
  }
}
