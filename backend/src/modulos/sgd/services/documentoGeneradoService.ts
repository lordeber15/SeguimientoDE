import PDFDocument from 'pdfkit';
import type { DatosDocumentoGenerado } from './documentoService';

/**
 * Genera al vuelo el PDF de un PROVEÍDO (232) o una HOJA DE ENVÍO (304).
 *
 * El SGD legado no guarda archivo para estos tipos: los renderiza on-demand con JasperReports a
 * partir de los datos ya registrados. Aquí se reproduce ese documento con pdfkit para que el PDF
 * unificado no tenga huecos — son el 86 % de los documentos sin archivo (ver `getDatosDocumentoGenerado`).
 */

const MARGIN = 34;
const PAGE_W = 595; // A4 en puntos
const PAGE_H = 842;
const USABLE_W = PAGE_W - 2 * MARGIN;
/** Deja sitio al pie: la línea del pie va en PAGE_H - 55. */
const LIMITE_INFERIOR = PAGE_H - 59;

const TITULOS: Record<string, string> = { '232': 'PROVEÍDO', '304': 'HOJA DE ENVÍO' };

/** Los tipos que el SGD no almacena y hay que dibujar. */
export const TIPOS_GENERABLES = new Set(['232', '304']);

export function esGenerable(coTipDoc: string | null | undefined): boolean {
  return TIPOS_GENERABLES.has(String(coTipDoc ?? '').trim());
}

function titulacion(datos: DatosDocumentoGenerado): string {
  return TITULOS[String(datos.coTipDoc ?? '').trim()] ?? datos.tipoDocumento ?? 'DOCUMENTO';
}

/** Una celda de tabla markdown no admite `|` ni saltos de línea sin romper la fila. */
function celda(valor: string | null | undefined): string {
  const limpio = (valor ?? '').replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ').trim();
  return limpio || '—';
}

/**
 * El mismo documento, pero en markdown estructurado para la ingesta RAG.
 *
 * No se dibuja el PDF para volver a extraerle el texto: los datos ya llegan estructurados desde la
 * BD, así que el ida y vuelta solo perdería esa estructura (tabla de destinos, referencias) y
 * gastaría una conversión en markitdown, que va serializado y es el cuello de botella del pipeline.
 */
export function datosAMarkdown(datos: DatosDocumentoGenerado): string {
  const lineas: string[] = [`# ${titulacion(datos)} N° ${datos.numeroDocumento ?? '—'}`, ''];

  const generales = [
    ['Expediente', datos.numeroExpediente],
    ['Fecha de emisión', datos.fechaEmision],
    ['Dependencia emisora', datos.dependenciaEmisora],
    ['Emitido por', datos.empleadoEmisor],
    ['Plazo de atención', datos.diasAtencion ? `${datos.diasAtencion} días` : null],
  ].filter(([, valor]) => Boolean(valor));

  if (generales.length > 0) {
    lineas.push(...generales.map(([etiqueta, valor]) => `- **${etiqueta}:** ${valor}`), '');
  }

  if (datos.asunto?.trim()) {
    lineas.push('## Asunto', '', datos.asunto.trim(), '');
  }

  const referencias = datos.referencias
    .map((ref) => [ref.documento, ref.asunto].filter(Boolean).join(' — '))
    .filter(Boolean);
  if (referencias.length > 0) {
    lineas.push('## Referencias', '', ...referencias.map((r) => `- ${r}`), '');
  }

  if (datos.destinos.length > 0) {
    lineas.push(
      '## Destinos',
      '',
      '| Dependencia | Persona | Trámite | Prioridad | Indicaciones |',
      '| --- | --- | --- | --- | --- |',
      ...datos.destinos.map(
        (d) =>
          `| ${celda(d.dependencia)} | ${celda(d.persona)} | ${celda(d.tramite)} ` +
          `| ${celda(d.prioridad)} | ${celda(d.indicaciones)} |`,
      ),
      '',
    );
  }

  return `${lineas.join('\n').trim()}\n`;
}

export function generarDocumentoPdf(datos: DatosDocumentoGenerado): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [PAGE_W, PAGE_H], margin: MARGIN, bufferPages: true });
    const trozos: Buffer[] = [];
    doc.on('data', (c: Buffer) => trozos.push(c));
    doc.on('end', () => resolve(Buffer.concat(trozos)));
    doc.on('error', reject);

    // Páginas con contenido real. La 0 siempre lo tiene (cabecera); las demás solo si un bloque
    // desbordó hasta ellas. Sin esto, el pie se dibujaría en páginas que quedaron vacías.
    const paginasUsadas = new Set<number>([0]);

    const reservar = (alto: number) => {
      if (doc.y + alto > LIMITE_INFERIOR) doc.addPage();
      paginasUsadas.add(doc.bufferedPageRange().count - 1);
    };

    // ── Caja de FECHA, arriba a la derecha ──────────────────────────────────
    const cajaW = 127;
    const cajaX = PAGE_W - MARGIN - cajaW;
    doc.lineWidth(0.5).strokeColor('#000000').rect(cajaX, MARGIN, cajaW, 38).stroke();
    doc.moveTo(cajaX, MARGIN + 19).lineTo(cajaX + cajaW, MARGIN + 19).stroke();
    doc.font('Helvetica').fontSize(9).fillColor('#000000')
      .text('FECHA', cajaX, MARGIN + 4, { width: cajaW, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(12)
      .text(datos.fechaEmision ?? '—', cajaX, MARGIN + 22, { width: cajaW, align: 'center' });

    // ── Dependencia emisora y tipo de documento ─────────────────────────────
    doc.font('Helvetica-Bold').fontSize(13)
      .text(datos.dependenciaEmisora ?? '', MARGIN, MARGIN + 46, { width: USABLE_W, align: 'center' });

    doc.y += 6;
    const titulo = titulacion(datos);
    doc.font('Helvetica-Bold').fontSize(11)
      .text(`${titulo} N° ${datos.numeroDocumento ?? '—'}`, MARGIN, doc.y, {
        width: USABLE_W,
        align: 'center',
      });
    doc.moveDown(0.6);

    // ── Expediente ──────────────────────────────────────────────────────────
    doc.font('Helvetica').fontSize(9).fillColor('#000000');
    doc.text('EXPEDIENTE : ', MARGIN, doc.y, { continued: true })
      .font('Helvetica-Bold').text(datos.numeroExpediente ?? '—');
    doc.moveDown(0.4);

    // ── Asunto, en su recuadro ──────────────────────────────────────────────
    doc.font('Helvetica').fontSize(8).text('ASUNTO:', MARGIN, doc.y);
    const asuntoY = doc.y;
    doc.lineWidth(0.5).rect(MARGIN + 55, asuntoY - 11, USABLE_W - 55, 34).stroke();
    doc.font('Helvetica').fontSize(8).text(datos.asunto ?? '', MARGIN + 58, asuntoY - 8, {
      width: USABLE_W - 61,
      height: 30,
      ellipsis: true,
    });
    doc.y = asuntoY + 26;

    if (datos.diasAtencion) {
      doc.font('Helvetica-Bold').fontSize(9)
        .text(`Atender en ${datos.diasAtencion} días`, MARGIN, doc.y, {
          width: USABLE_W,
          align: 'right',
        });
    }
    doc.moveDown(0.6);

    // ── Referencias ─────────────────────────────────────────────────────────
    if (datos.referencias.length > 0) {
      doc.font('Helvetica').fontSize(8).text('REFERENCIA :', MARGIN, doc.y);
      doc.moveDown(0.2);
      for (const ref of datos.referencias) {
        reservar(14);
        const inicioY = doc.y;
        doc.font('Helvetica').fontSize(8)
          .text(ref.documento ?? '', MARGIN + 91, inicioY, { width: 140 });
        doc.font('Helvetica').fontSize(7)
          .text(ref.asunto ?? '', MARGIN + 235, inicioY, { width: USABLE_W - 235 });
        doc.y = Math.max(doc.y, inicioY + 12);
      }
      doc.moveDown(0.6);
    }

    // ── Tabla de destinos ───────────────────────────────────────────────────
    const colDep = MARGIN;
    const anchoDep = 212;
    const colTra = colDep + anchoDep;
    const anchoTra = 71;
    const colPri = colTra + anchoTra;
    const anchoPri = 72;
    const colInd = colPri + anchoPri;
    const anchoInd = USABLE_W - anchoDep - anchoTra - anchoPri;

    reservar(20);
    const cabeceraY = doc.y;
    doc.lineWidth(0.5).strokeColor('#000000').rect(MARGIN, cabeceraY, USABLE_W, 20).stroke();
    doc.font('Helvetica-Bold').fontSize(9);
    doc.text('DEPENDENCIA DESTINO', colDep, cabeceraY + 6, { width: anchoDep, align: 'center' });
    doc.text('TRÁMITE', colTra, cabeceraY + 6, { width: anchoTra, align: 'center' });
    doc.text('PRIORIDAD', colPri, cabeceraY + 6, { width: anchoPri, align: 'center' });
    doc.text('INDICACIONES', colInd, cabeceraY + 6, { width: anchoInd, align: 'center' });
    doc.y = cabeceraY + 20;

    doc.font('Helvetica').fontSize(8);
    for (const destino of datos.destinos) {
      const etiqueta = [destino.dependencia ?? '', destino.persona ?? '']
        .filter(Boolean)
        .join('\n');
      const alto = Math.max(
        20,
        doc.heightOfString(etiqueta, { width: anchoDep - 4 }) + 8,
        doc.heightOfString(destino.indicaciones ?? '', { width: anchoInd - 6 }) + 8,
      );
      reservar(alto);
      const filaY = doc.y;
      doc.rect(MARGIN, filaY, USABLE_W, alto).stroke();
      doc.text(etiqueta, colDep + 2, filaY + 3, { width: anchoDep - 4 });
      doc.text(destino.tramite ?? '—', colTra, filaY + 3, { width: anchoTra, align: 'center' });
      doc.text(destino.prioridad ?? '—', colPri, filaY + 3, { width: anchoPri, align: 'center' });
      doc.text(destino.indicaciones ?? '', colInd + 3, filaY + 3, { width: anchoInd - 6 });
      doc.y = filaY + alto;
    }

    // ── Pie, solo en las páginas que llevan contenido ───────────────────────
    const rango = doc.bufferedPageRange();
    for (let i = 0; i < rango.count; i++) {
      if (!paginasUsadas.has(i)) continue;
      doc.switchToPage(rango.start + i);
      dibujarPie(doc, datos);
    }

    doc.end();
  });
}

function dibujarPie(doc: PDFKit.PDFDocument, datos: DatosDocumentoGenerado) {
  // El nombre del emisor cae en y+16 ≈ 803 y, con 8 pt, su base supera el margen inferior
  // (PAGE_H - MARGIN = 808): pdfkit insertaría una página nueva y empujaría el texto a otra hoja.
  // Se anula el margen mientras se dibuja el pie y se restaura después.
  const margenPrevio = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;

  const y = PAGE_H - 55;
  doc.moveTo(MARGIN, y).lineTo(PAGE_W - MARGIN, y).lineWidth(0.5).strokeColor('#000000').stroke();
  doc.font('Helvetica-Bold').fontSize(7).fillColor('#000000')
    .text(datos.siglaInstitucion ?? '', MARGIN, y + 4, { width: USABLE_W / 2, lineBreak: false });
  doc.font('Helvetica').fontSize(8)
    .text('SISTEMA DE GESTIÓN DOCUMENTAL', MARGIN, y + 4, {
      width: USABLE_W,
      align: 'right',
      lineBreak: false,
    });
  if (datos.empleadoEmisor) {
    doc.font('Helvetica-Bold').fontSize(8)
      .text(datos.empleadoEmisor, MARGIN, y + 16, {
        width: USABLE_W,
        align: 'center',
        lineBreak: false,
      });
  }

  doc.page.margins.bottom = margenPrevio;
}
