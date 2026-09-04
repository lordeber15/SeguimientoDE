/**
 * Utilidades de PDF compartidas por `conversionLargaService.ts` (troceo de documentos largos) y
 * `unirPdfService.ts` (fusión de expedientes, que ahora importa `cargarPdf` de aquí en vez de
 * tener su propia copia).
 */

import { PDFDocument } from 'pdf-lib';
import { cargarPdf, contarPaginas, partirEnBloques } from '../../src/services/pdfPaginasService';

async function pdfDePrueba(paginas: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < paginas; i++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

describe('contarPaginas — nunca lanza, cae a null ante cualquier duda', () => {
  it('cuenta las páginas de un PDF real', async () => {
    const buffer = await pdfDePrueba(7);
    expect(await contarPaginas(buffer)).toBe(7);
  });

  it('devuelve null para un buffer que no es PDF, sin lanzar', async () => {
    await expect(contarPaginas(Buffer.from('esto no es un PDF'))).resolves.toBeNull();
  });

  it('devuelve null para un PDF truncado/corrupto', async () => {
    const buffer = await pdfDePrueba(3);
    const truncado = buffer.subarray(0, Math.floor(buffer.length / 2));
    await expect(contarPaginas(truncado)).resolves.toBeNull();
  });
});

describe('cargarPdf — misma tolerancia que tenía la copia original en unirPdfService', () => {
  it('tolera basura antes de la cabecera %PDF- (frecuente en archivos del SGD)', async () => {
    const real = await pdfDePrueba(2);
    const conBasuraDelante = Buffer.concat([Buffer.from('BASURA-DEL-ESCANER-'), real]);

    const cargado = await cargarPdf(conBasuraDelante);

    expect(cargado.getPageCount()).toBe(2);
  });

  it('rechaza un buffer sin cabecera %PDF- en los primeros 1024 bytes', async () => {
    await expect(cargarPdf(Buffer.from('esto no es un PDF'))).rejects.toThrow('no es un PDF');
  });
});

describe('partirEnBloques — troceo perezoso, un bloque por iteración', () => {
  it('parte un PDF en bloques consecutivos con el rango de páginas correcto', async () => {
    const buffer = await pdfDePrueba(7);

    const bloques = [];
    for await (const bloque of partirEnBloques(buffer, 3)) bloques.push(bloque);

    expect(bloques.map((b) => [b.desde, b.hasta])).toEqual([[1, 3], [4, 6], [7, 7]]);
  });

  it('cada bloque es un PDF independiente y válido, con el número de páginas de su rango', async () => {
    const buffer = await pdfDePrueba(7);

    for await (const bloque of partirEnBloques(buffer, 3)) {
      expect(await contarPaginas(bloque.buffer)).toBe(bloque.hasta - bloque.desde + 1);
    }
  });

  it('un PDF de una sola página produce un único bloque', async () => {
    const buffer = await pdfDePrueba(1);

    const bloques = [];
    for await (const bloque of partirEnBloques(buffer, 15)) bloques.push(bloque);

    expect(bloques).toHaveLength(1);
    expect(bloques[0]).toMatchObject({ desde: 1, hasta: 1 });
  });
});
