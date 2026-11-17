import fs from 'fs';
import os from 'os';
import path from 'path';

type StdStorage = typeof import('../../../../src/modulos/std/services/stdStorageService');

let storage: StdStorage;
let BASE: string;

const ADJUNTO = 'f7e0ad8f8445d7777024abc0d43c9918902cb635'; // 40 hex, ejemplo real de la skill std-database

function escribirAdjunto(adjunto: string, contenido: string): void {
  const carpeta = path.join(BASE, adjunto.slice(0, 2), adjunto.slice(2, 4), adjunto.slice(4, 6));
  fs.mkdirSync(carpeta, { recursive: true });
  fs.writeFileSync(path.join(carpeta, adjunto), contenido);
}

beforeAll(() => {
  BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'std-storage-test-'));
  process.env.STD_STORAGE_PATH = BASE;

  // stdStorageService lee process.env.STD_STORAGE_PATH al importarse.
  jest.isolateModules(() => {
    storage = require('../../../../src/modulos/std/services/stdStorageService');
  });
});

afterAll(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
});

describe('rutaAdjunto', () => {
  it('aplica el sharding de 3 niveles (2+2+2) del PHP legado', () => {
    const ruta = storage.rutaAdjunto(ADJUNTO);
    expect(ruta).toBe(path.join(BASE, 'f7', 'e0', 'ad', ADJUNTO));
  });

  it('normaliza a minúsculas', () => {
    const ruta = storage.rutaAdjunto(ADJUNTO.toUpperCase());
    expect(ruta).toBe(path.join(BASE, 'f7', 'e0', 'ad', ADJUNTO));
  });

  it.each([
    '../../../etc/passwd',
    'f7e0ad8f8445d7777024abc0d43c9918902cb63', // 39 caracteres, uno de menos
    'f7e0ad8f8445d7777024abc0d43c9918902cb6355', // 41, uno de más
    'f7e0ad8f8445d7777024abc0d43c9918902cb6g', // contiene 'g', no es hex
    '',
    '../adjunto',
  ])('rechaza un adjunto inválido: %s', (valor) => {
    expect(() => storage.rutaAdjunto(valor)).toThrow(storage.ArchivoStdError);
  });
});

describe('leerArchivoStd', () => {
  it('lee el archivo cuando existe', () => {
    escribirAdjunto(ADJUNTO, 'contenido de prueba');
    const resultado = storage.leerArchivoStd(ADJUNTO);
    expect(resultado.buffer.toString()).toBe('contenido de prueba');
    expect(resultado.hashVerificado).toBe(false);
  });

  it('lanza 404 si el archivo no existe en el disco', () => {
    const otro = 'a1b2c3d4e5f60718293a4b5c6d7e8f9011121314';
    expect(() => storage.leerArchivoStd(otro)).toThrow(storage.ArchivoStdError);
    try {
      storage.leerArchivoStd(otro);
    } catch (error) {
      expect((error as InstanceType<typeof storage.ArchivoStdError>).status).toBe(404);
    }
  });

  it('rechaza un archivo que supera STD_MAX_BYTES', () => {
    const grande = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    escribirAdjunto(grande, 'x'.repeat(50));

    jest.isolateModules(() => {
      process.env.STD_MAX_BYTES = '10';
      const otraInstancia: StdStorage = require('../../../../src/modulos/std/services/stdStorageService');
      expect(() => otraInstancia.leerArchivoStd(grande)).toThrow(/límite/i);
      delete process.env.STD_MAX_BYTES;
    });
  });
});

describe('limpiarMime', () => {
  it('quita el parámetro charset de la subida por chunks', () => {
    expect(storage.limpiarMime('application/pdf; charset=binary')).toBe('application/pdf');
  });

  it('deja intacto un mime sin parámetros (subida antigua)', () => {
    expect(storage.limpiarMime('application/pdf')).toBe('application/pdf');
  });

  it('devuelve octet-stream para vacío o nulo', () => {
    expect(storage.limpiarMime(null)).toBe('application/octet-stream');
    expect(storage.limpiarMime(undefined)).toBe('application/octet-stream');
    expect(storage.limpiarMime('')).toBe('application/octet-stream');
  });
});

describe('almacenamientoStdDisponible', () => {
  it('true cuando el punto de montaje tiene contenido', () => {
    expect(storage.almacenamientoStdDisponible()).toBe(true);
  });

  it('false cuando el punto de montaje no existe', () => {
    jest.isolateModules(() => {
      process.env.STD_STORAGE_PATH = path.join(BASE, 'no-existe');
      const otraInstancia: StdStorage = require('../../../../src/modulos/std/services/stdStorageService');
      expect(otraInstancia.almacenamientoStdDisponible()).toBe(false);
      process.env.STD_STORAGE_PATH = BASE;
    });
  });
});
