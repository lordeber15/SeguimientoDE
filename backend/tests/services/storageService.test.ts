import fs from 'fs';
import os from 'os';
import path from 'path';

type Storage = typeof import('../../src/services/storageService');

let storage: Storage;
let BASE: string;

/** Crea {BASE}/{ann}/documentos/{emi}/ y devuelve la ruta. */
function carpetaDoc(ann: string, emi: string): string {
  const dir = path.join(BASE, ann, 'documentos', emi);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function carpetaAnx(ann: string, emi: string, ane: string): string {
  const dir = path.join(BASE, ann, 'documentos', emi, 'anexos', ane);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

beforeAll(() => {
  BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'sgd-storage-test-'));
  process.env.STORAGE_PATH = BASE;

  // storageService lee process.env.STORAGE_PATH al importarse, así que hay que fijarlo antes.
  jest.isolateModules(() => {
    storage = require('../../src/services/storageService');
  });
});

afterAll(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
});

describe('padEmi', () => {
  it('rellena con ceros a la izquierda hasta 10 dígitos', () => {
    expect(storage.padEmi('1999')).toBe('0000001999');
    expect(storage.padEmi(1999)).toBe('0000001999');
  });

  it('recorta espacios antes de rellenar', () => {
    expect(storage.padEmi('  8001  ')).toBe('0000008001');
  });

  it('deja intacto un valor que ya viene con el padding de la BD', () => {
    expect(storage.padEmi('0000008001')).toBe('0000008001');
  });
});

describe('nombreArchivo', () => {
  // 104 filas de tdtv_archivo_doc traen una ruta absoluta del servidor Java filtrada a la BD.
  it('se queda con el nombre cuando la BD guardó una ruta absoluta de Unix', () => {
    expect(storage.nombreArchivo('/glassfish/tmppcm//2026000000199889237777.pdf')).toBe(
      '2026000000199889237777.pdf',
    );
  });

  it('también corta por separador de Windows', () => {
    expect(storage.nombreArchivo('C:\\temp\\INFORME.pdf')).toBe('INFORME.pdf');
  });

  it('devuelve null para vacío o solo espacios', () => {
    expect(storage.nombreArchivo('   ')).toBeNull();
    expect(storage.nombreArchivo(null)).toBeNull();
    expect(storage.nombreArchivo(undefined)).toBeNull();
  });
});

describe('resolverDocumento', () => {
  it('prioriza el BLOB de la BD sobre el disco', () => {
    const dir = carpetaDoc('2026', '0000000001');
    fs.writeFileSync(path.join(dir, 'del-disco.pdf'), 'contenido de disco');

    const resultado = storage.resolverDocumento('2026', '1', {
      bl_doc: Buffer.from('contenido de la BD'),
      de_ruta_origen: 'desde-bd.pdf',
    });

    expect(resultado.origen).toBe('bd');
    expect(resultado.filename).toBe('desde-bd.pdf');
    expect(resultado.buffer.toString()).toBe('contenido de la BD');
  });

  it('ignora un BLOB vacío y cae al disco', () => {
    const dir = carpetaDoc('2026', '0000000002');
    fs.writeFileSync(path.join(dir, 'real.pdf'), 'disco');

    const resultado = storage.resolverDocumento('2026', '2', {
      bl_doc: Buffer.alloc(0),
      de_ruta_origen: 'real.pdf',
    });

    expect(resultado.origen).toBe('disco');
    expect(resultado.buffer.toString()).toBe('disco');
  });

  it('usa el nombre exacto de la BD cuando existe en disco', () => {
    const dir = carpetaDoc('2026', '0000000003');
    fs.writeFileSync(path.join(dir, 'exacto.pdf'), 'ok');
    fs.writeFileSync(path.join(dir, 'aaa-primero.pdf'), 'otro');

    const resultado = storage.resolverDocumento('2026', '3', {
      bl_doc: null,
      de_ruta_origen: 'exacto.pdf',
    });

    expect(resultado.filename).toBe('exacto.pdf');
    expect(resultado.buffer.toString()).toBe('ok');
  });

  // El escritor del SGD sanitiza los acentos: la BD dice ADJUDICACIÓN y en disco está ADJUDICACION.
  it('cae al primer archivo cuando el nombre de la BD no existe (acentos sanitizados)', () => {
    const dir = carpetaDoc('2026', '0000000004');
    fs.writeFileSync(path.join(dir, 'ADJUDICACION_CARTA.pdf'), 'sin tilde');

    const resultado = storage.resolverDocumento('2026', '4', {
      bl_doc: null,
      de_ruta_origen: 'ADJUDICACIÓN_CARTA.pdf',
    });

    expect(resultado.filename).toBe('ADJUDICACION_CARTA.pdf');
    expect(resultado.buffer.toString()).toBe('sin tilde');
  });

  // En las carpetas reales conviven la versión editable y la firmada; alfabéticamente gana .docx.
  it('prefiere el PDF cuando la carpeta tiene .docx y .pdf', () => {
    const dir = carpetaDoc('2026', '0000000005');
    fs.writeFileSync(path.join(dir, 'INFORME-R53.docx'), 'editable');
    fs.writeFileSync(path.join(dir, 'INFORME-R53.pdf'), 'firmado');

    const resultado = storage.resolverDocumento('2026', '5', null);

    expect(resultado.filename).toBe('INFORME-R53.pdf');
    expect(resultado.buffer.toString()).toBe('firmado');
  });

  it('devuelve el único archivo aunque no sea PDF', () => {
    const dir = carpetaDoc('2026', '0000000006');
    fs.writeFileSync(path.join(dir, 'planilla.xlsx'), 'excel');

    expect(storage.resolverDocumento('2026', '6', null).filename).toBe('planilla.xlsx');
  });

  it('lanza 404 cuando la carpeta no existe', () => {
    expect(() => storage.resolverDocumento('2026', '9999999', null)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  it('lanza 404 cuando la carpeta existe pero está vacía', () => {
    carpetaDoc('2026', '0000000007');

    expect(() => storage.resolverDocumento('2026', '7', null)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  // El nombre viene de un campo de texto libre de la BD del SGD. La propiedad que importa es que
  // NUNCA se lea fuera de la carpeta del documento; cómo se consigue es secundario.
  //
  // En la práctica lo neutraliza `nombreArchivo()`, que se queda con el basename: '../../secreto'
  // se convierte en 'secreto', no existe en la carpeta, y cae al fallback normal. Por eso esto NO
  // lanza 400 — `resolverRutaSegura()` queda como segunda línea de defensa, inalcanzable mientras
  // todo nombre pase antes por el basename.
  it('no puede leer fuera de la carpeta del documento aunque la BD traiga ../..', () => {
    const dir = carpetaDoc('2026', '0000000008');
    fs.writeFileSync(path.join(dir, 'inocente.pdf'), 'contenido legitimo');
    fs.writeFileSync(path.join(BASE, 'secreto.txt'), 'NO DEBE LEERSE');

    const resultado = storage.resolverDocumento('2026', '8', {
      bl_doc: null,
      de_ruta_origen: '../../../secreto.txt',
    });

    expect(resultado.buffer.toString()).toBe('contenido legitimo');
    expect(resultado.buffer.toString()).not.toContain('NO DEBE LEERSE');
    expect(resultado.filename).toBe('inocente.pdf');
  });

  it('tampoco escapa con separadores de Windows', () => {
    const dir = carpetaDoc('2026', '0000000010');
    fs.writeFileSync(path.join(dir, 'valido.pdf'), 'contenido legitimo');

    const resultado = storage.resolverDocumento('2026', '10', {
      bl_doc: null,
      de_ruta_origen: '..\\..\\..\\secreto.txt',
    });

    expect(resultado.filename).toBe('valido.pdf');
  });

  it('lanza 413 cuando el archivo supera los 100 MB', () => {
    const dir = carpetaDoc('2026', '0000000009');
    const grande = path.join(dir, 'enorme.pdf');
    // Archivo disperso: ocupa 0 bytes reales pero declara 101 MB.
    fs.writeFileSync(grande, '');
    fs.truncateSync(grande, 101 * 1024 * 1024);

    expect(() => storage.resolverDocumento('2026', '9', null)).toThrow(
      expect.objectContaining({ status: 413 }),
    );
  });
});

describe('resolverAnexo', () => {
  it('usa nu_ane literal como carpeta, sin re-indexar', () => {
    // 223 documentos reales no empiezan en 1; este imita 2026/0000002250 (anexos 6..9).
    const dir = carpetaAnx('2026', '0000002250', '6');
    fs.writeFileSync(path.join(dir, 'Piura.pdf'), 'anexo seis');

    const resultado = storage.resolverAnexo('2026', '2250', 6, {
      bl_doc: null,
      de_rut_ori: 'Piura.pdf',
    });

    expect(resultado.filename).toBe('Piura.pdf');
    expect(resultado.buffer.toString()).toBe('anexo seis');
  });

  it('prioriza el BLOB del anexo sobre el disco', () => {
    const resultado = storage.resolverAnexo('2026', '2250', 7, {
      bl_doc: Buffer.from('desde bd'),
      de_rut_ori: 'Jaen.pdf',
    });

    expect(resultado.origen).toBe('bd');
    expect(resultado.buffer.toString()).toBe('desde bd');
  });

  it('lanza 404 cuando la carpeta del anexo existe pero está vacía', () => {
    carpetaAnx('2026', '0000002250', '8');

    expect(() => storage.resolverAnexo('2026', '2250', 8, { bl_doc: null, de_rut_ori: 'x.pdf' })).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
});

describe('resolverNombreAnexo', () => {
  it('devuelve el nombre de la BD sin tocar el disco cuando el anexo está en BD', () => {
    const nombre = storage.resolverNombreAnexo('2026', '9999999', 1, {
      de_rut_ori: 'respaldo.7z.001',
      en_bd: true,
    });

    expect(nombre).toBe('respaldo.7z.001');
  });

  it('resuelve desde el disco cuando no está en BD', () => {
    const dir = carpetaAnx('2026', '0000008004', '13');
    fs.writeFileSync(path.join(dir, 'EJECUCION.7z.001'), 'parte 1');

    expect(storage.resolverNombreAnexo('2026', '8004', 13, { de_rut_ori: null })).toBe(
      'EJECUCION.7z.001',
    );
  });

  it('devuelve null cuando no hay nada que resolver', () => {
    expect(storage.resolverNombreAnexo('2026', '7777777', 1, { de_rut_ori: null })).toBeNull();
  });
});

describe('estadoAlmacenamiento', () => {
  it('reporta la ruta configurada y que está montada', () => {
    expect(storage.estadoAlmacenamiento()).toEqual({ ruta: BASE, montado: true });
  });
});
