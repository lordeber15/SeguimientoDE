import fs from 'fs';
import os from 'os';
import path from 'path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

type Union = typeof import('../../src/services/unirPdfService');

let union: Union;
let TMP: string;

/** Documentos falsos: el servicio nunca debe tocar la BD en estos tests. */
const documentos = jest.fn();
const anexos = jest.fn();
const archivoDoc = jest.fn();
const archivoAnexo = jest.fn();
const datosGenerado = jest.fn();
const resolverDoc = jest.fn();
const resolverAnx = jest.fn();

jest.mock('../../src/services/documentoService', () => ({
  getDocumentosExpediente: (...a: unknown[]) => documentos(...a),
  getAnexos: (...a: unknown[]) => anexos(...a),
  getArchivoDoc: (...a: unknown[]) => archivoDoc(...a),
  getArchivoAnexo: (...a: unknown[]) => archivoAnexo(...a),
  getDatosDocumentoGenerado: (...a: unknown[]) => datosGenerado(...a),
}));

jest.mock('../../src/services/storageService', () => ({
  resolverDocumento: (...a: unknown[]) => resolverDoc(...a),
  resolverAnexo: (...a: unknown[]) => resolverAnx(...a),
  resolverNombreAnexo: (_ann: string, _emi: string, _ane: number, fila: { de_rut_ori?: string }) =>
    fila?.de_rut_ori ?? null,
}));

async function pdfDePrueba(paginas = 1): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < paginas; i++) {
    doc.addPage([595, 842]).drawText(`contenido ${i + 1}`, { x: 60, y: 700, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

function doc(over: Partial<Record<string, unknown>> = {}) {
  return {
    nuAnn: '2026',
    nuEmi: '0000000001',
    numeroExpediente: 'OGAUL020260000058',
    coTipDoc: '003',
    tipoDocumento: 'INFORME',
    numeroDocumento: '000001-2026',
    titulo: 'INFORME N° 000001-2026',
    asunto: 'Asunto de prueba',
    fechaEmision: '13/05/2026 17:08',
    dependenciaEmisora: 'OGA-UL',
    dependenciaDestino: 'OGA',
    estado: 'RECIBIDO',
    tieneArchivo: true,
    numAnexos: 0,
    ...over,
  };
}

/** Espera a que el job termine y devuelve su estado final. */
async function esperar(jobId: string) {
  for (let i = 0; i < 200; i++) {
    const estado = union.getEstado(jobId)!;
    if (estado.estado !== 'procesando') return estado;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('El job no terminó a tiempo');
}

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sgd-union-test-'));
  process.env.UNION_TMP_PATH = TMP;

  // El servicio lee UNION_TMP_PATH al ejecutarse, pero el módulo mantiene el Map de jobs:
  // se importa aislado para no arrastrar estado de otras suites.
  jest.isolateModules(() => {
    union = require('../../src/services/unirPdfService');
  });
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  documentos.mockReset();
  anexos.mockReset();
  archivoDoc.mockReset();
  archivoAnexo.mockReset();
  datosGenerado.mockReset();
  resolverDoc.mockReset();
  resolverAnx.mockReset();
  archivoDoc.mockResolvedValue({ bl_doc: null, de_ruta_origen: 'x.pdf' });
});

describe('unirPdfService — unión del expediente', () => {
  it('une los documentos y antepone el índice', async () => {
    documentos.mockResolvedValue([doc(), doc({ nuEmi: '0000000002', titulo: 'OFICIO N° 2' })]);
    resolverDoc.mockImplementation(async () => ({ buffer: await pdfDePrueba(2) }));
    resolverDoc.mockReturnValue({ buffer: await pdfDePrueba(2), filename: 'a.pdf', origen: 'bd' });

    const { jobId } = union.iniciarJob({
      nuAnnExp: '2026',
      nuSecExp: '0000000010',
      incluirAnexos: true,
    });
    const estado = await esperar(jobId);

    expect(estado.estado).toBe('completado');
    expect(estado.errores).toHaveLength(0);

    const { filePath } = union.getDescarga(jobId);
    const pdf = await PDFDocument.load(fs.readFileSync(filePath));
    // 1 índice + por documento: 1 separadora + 2 páginas de contenido.
    expect(pdf.getPageCount()).toBe(1 + 2 * (1 + 2));
  });

  it('un PDF corrupto no aborta el job: se anota y el resto sigue', async () => {
    documentos.mockResolvedValue([
      doc({ nuEmi: '0000000001', titulo: 'BUENO' }),
      doc({ nuEmi: '0000000002', titulo: 'CORRUPTO' }),
      doc({ nuEmi: '0000000003', titulo: 'TAMBIEN BUENO' }),
    ]);
    const bueno = await pdfDePrueba(1);
    resolverDoc.mockImplementation((_a: string, emi: string) => ({
      buffer: emi === '0000000002' ? Buffer.from('esto no es un pdf') : bueno,
      filename: 'x.pdf',
      origen: 'bd' as const,
    }));

    const { jobId } = union.iniciarJob({
      nuAnnExp: '2026',
      nuSecExp: '0000000011',
      incluirAnexos: false,
    });
    const estado = await esperar(jobId);

    expect(estado.estado).toBe('completado');
    expect(estado.errores).toEqual([
      expect.objectContaining({ documento: 'CORRUPTO', motivo: 'El archivo no es un PDF' }),
    ]);
    // Los otros dos sí entraron: 1 índice + 2 × (separadora + 1 página).
    const { filePath } = union.getDescarga(jobId);
    const pdf = await PDFDocument.load(fs.readFileSync(filePath));
    expect(pdf.getPageCount()).toBe(1 + 2 * 2);
  });

  it('un documento sin archivo se marca "no incluido" en vez de romper', async () => {
    documentos.mockResolvedValue([doc({ tieneArchivo: false })]);

    const { jobId } = union.iniciarJob({
      nuAnnExp: '2026',
      nuSecExp: '0000000012',
      incluirAnexos: false,
    });
    const estado = await esperar(jobId);

    // El expediente entero queda sin páginas de contenido: 422, no un PDF vacío.
    expect(estado.estado).toBe('error');
    expect(estado.mensajeError).toMatch(/Ningún documento/);
    expect(estado.errores[0].motivo).toBe('Sin archivo digital');
  });

  it('los PROVEÍDOS se dibujan al vuelo aunque el SGD no guarde archivo', async () => {
    documentos.mockResolvedValue([
      doc({ coTipDoc: '232', titulo: 'PROVEIDO N° 5', tieneArchivo: false }),
    ]);
    datosGenerado.mockResolvedValue({
      coTipDoc: '232',
      tipoDocumento: 'PROVEIDO',
      numeroDocumento: '000005-2026',
      numeroExpediente: 'OGAUL02026000005',
      asunto: 'Proyección de gasto',
      fechaEmision: '14/05/2026',
      diasAtencion: 3,
      dependenciaEmisora: 'UNIDAD DE LOGÍSTICA',
      empleadoEmisor: 'PEREZ GOMEZ ANA',
      siglaInstitucion: 'UE118',
      destinos: [
        {
          nuDes: 1,
          dependencia: 'OFICINA GENERAL',
          persona: null,
          tramite: 'INFORMAR',
          prioridad: 'MUY URGENTE',
          indicaciones: null,
        },
      ],
      referencias: [{ documento: 'INFORME N° 1', asunto: 'Antecedente' }],
    });

    const { jobId } = union.iniciarJob({
      nuAnnExp: '2026',
      nuSecExp: '0000000013',
      incluirAnexos: false,
    });
    const estado = await esperar(jobId);

    expect(estado.estado).toBe('completado');
    expect(estado.errores).toHaveLength(0);
    expect(resolverDoc).not.toHaveBeenCalled(); // no se buscó archivo: se generó
    const { filePath } = union.getDescarga(jobId);
    const pdf = await PDFDocument.load(fs.readFileSync(filePath));
    expect(pdf.getPageCount()).toBe(1 + 1 + 1); // índice + separadora + proveído
  });

  it('agrupa los volúmenes de un comprimido partido en un solo anexo', async () => {
    documentos.mockResolvedValue([doc({ numAnexos: 3 })]);
    anexos.mockResolvedValue([
      { nuAne: 6, titulo: 'Respaldo', nombreArchivo: 'respaldo.7z.001', enBd: true },
      { nuAne: 7, titulo: 'Respaldo', nombreArchivo: 'respaldo.7z.002', enBd: true },
      { nuAne: 8, titulo: 'Otro', nombreArchivo: 'aparte.zip', enBd: true },
    ]);
    resolverDoc.mockReturnValue({ buffer: await pdfDePrueba(1), filename: 'a.pdf', origen: 'bd' });

    const { jobId } = union.iniciarJob({
      nuAnnExp: '2026',
      nuSecExp: '0000000014',
      incluirAnexos: true,
    });
    const estado = await esperar(jobId);

    expect(estado.estado).toBe('completado');
    // 3 archivos → 2 grupos (las dos partes cuentan como uno): 1 doc + 2 grupos.
    expect(estado.total).toBe(3);
    // Ninguno es fusionable: van como marcador y NO se descargan.
    expect(archivoAnexo).not.toHaveBeenCalled();
    const { filePath } = union.getDescarga(jobId);
    const pdf = await PDFDocument.load(fs.readFileSync(filePath));
    expect(pdf.getPageCount()).toBe(1 + 1 + 1 + 2); // índice + separadora + doc + 2 marcadores
  });

  it('un anexo PDF se fusiona entre marcadores INICIO y FIN', async () => {
    documentos.mockResolvedValue([doc({ numAnexos: 1 })]);
    anexos.mockResolvedValue([
      { nuAne: 1, titulo: 'Contrato', nombreArchivo: 'contrato.pdf', enBd: true },
    ]);
    resolverDoc.mockReturnValue({ buffer: await pdfDePrueba(1), filename: 'a.pdf', origen: 'bd' });
    resolverAnx.mockReturnValue({
      buffer: await pdfDePrueba(3),
      filename: 'contrato.pdf',
      origen: 'bd',
    });

    const { jobId } = union.iniciarJob({
      nuAnnExp: '2026',
      nuSecExp: '0000000015',
      incluirAnexos: true,
    });
    const estado = await esperar(jobId);

    expect(estado.estado).toBe('completado');
    const { filePath } = union.getDescarga(jobId);
    const pdf = await PDFDocument.load(fs.readFileSync(filePath));
    // índice + separadora + doc(1) + INICIO + anexo(3) + FIN
    expect(pdf.getPageCount()).toBe(1 + 1 + 1 + 1 + 3 + 1);
  });

  it('con anexos=false ni siquiera los consulta', async () => {
    documentos.mockResolvedValue([doc({ numAnexos: 5 })]);
    resolverDoc.mockReturnValue({ buffer: await pdfDePrueba(1), filename: 'a.pdf', origen: 'bd' });

    const { jobId } = union.iniciarJob({
      nuAnnExp: '2026',
      nuSecExp: '0000000016',
      incluirAnexos: false,
    });
    const estado = await esperar(jobId);

    expect(estado.estado).toBe('completado');
    expect(anexos).not.toHaveBeenCalled();
    expect(estado.total).toBe(1);
  });

  it('nombra el archivo con el nº de expediente del SGD, no con la clave interna', async () => {
    documentos.mockResolvedValue([doc({ numeroExpediente: 'OGAUL020260000058' })]);
    resolverDoc.mockReturnValue({ buffer: await pdfDePrueba(1), filename: 'a.pdf', origen: 'bd' });

    const { jobId } = union.iniciarJob({
      nuAnnExp: '2026',
      nuSecExp: '0000000058',
      incluirAnexos: false,
    });
    const estado = await esperar(jobId);

    // Es el identificador que el usuario ve en la tabla; con la clave interna (`2026-58`) no
    // podría relacionar el PDF descargado con la fila desde la que lo pidió.
    expect(estado.filename).toBe('Expediente_OGAUL020260000058_sin_anexos.pdf');
  });

  it('si el expediente no tiene nº del SGD cae a la clave interna', async () => {
    documentos.mockResolvedValue([doc({ numeroExpediente: null })]);
    resolverDoc.mockReturnValue({ buffer: await pdfDePrueba(1), filename: 'a.pdf', origen: 'bd' });

    const { jobId } = union.iniciarJob({
      nuAnnExp: '2026',
      nuSecExp: '0000000059',
      incluirAnexos: true,
    });
    const estado = await esperar(jobId);

    expect(estado.filename).toBe('Expediente_2026-59.pdf');
  });

  it('un expediente sin documentos responde 404 y no deja archivo', async () => {
    documentos.mockResolvedValue([]);

    const { jobId } = union.iniciarJob({
      nuAnnExp: '2026',
      nuSecExp: '0000000017',
      incluirAnexos: true,
    });
    const estado = await esperar(jobId);

    expect(estado.estado).toBe('error');
    expect(estado.mensajeError).toBe('El expediente no tiene documentos');
    // La descarga propaga el motivo real, no un "error" genérico: es lo que ve el usuario.
    expect(() => union.getDescarga(jobId)).toThrow('El expediente no tiene documentos');
    expect(fs.readdirSync(TMP).filter((f) => f.includes(jobId))).toHaveLength(0);
  });
});

describe('unirPdfService — índice', () => {
  it('reparte las filas en páginas y cuenta el total exacto', () => {
    const { asignaciones, totalPaginas } = union.planificarFilas(
      Array.from({ length: 121 }, (_, i) => ({ tipo: i < 90 ? 'doc' : ('anexo' as const) })),
    );

    expect(totalPaginas).toBe(3);
    expect(asignaciones).toHaveLength(121);
    expect(asignaciones[0].pagina).toBe(0);
    expect(asignaciones.at(-1)!.pagina).toBe(2);
    // Dentro de una página, la "y" solo crece.
    for (let i = 1; i < asignaciones.length; i++) {
      if (asignaciones[i].pagina === asignaciones[i - 1].pagina) {
        expect(asignaciones[i].y).toBeGreaterThan(asignaciones[i - 1].y);
      }
    }
  });

  it('un expediente de un solo documento cabe en una página de índice', () => {
    expect(union.planificarFilas([{ tipo: 'doc' }]).totalPaginas).toBe(1);
    expect(union.planificarFilas([]).totalPaginas).toBe(1);
  });
});

describe('unirPdfService — saneado de texto', () => {
  it('sustituye lo que no codifica WinAnsi en vez de lanzar', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);

    // Los asuntos del SGD traen ° – " y algún emoji suelto; Helvetica no los codifica todos.
    const salida = union.truncar('Acta 1 ° – "citada" ✅ фыв', font, 9, 500);
    expect(() => font.widthOfTextAtSize(salida, 9)).not.toThrow();
    expect(salida).toContain('°');
    expect(salida).not.toContain('✅');
  });

  it('trunca con puntos suspensivos si no cabe', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);

    const salida = union.truncar('X'.repeat(500), font, 9, 100);
    expect(salida.endsWith('…')).toBe(true);
    expect(font.widthOfTextAtSize(salida, 9)).toBeLessThanOrEqual(100);
  });
});
