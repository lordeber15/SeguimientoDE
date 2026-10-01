import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Resolución de los archivos físicos del STD (`tbl_adjunto`).
 *
 * Regla de ruta (ver la skill `std-database`, §4, tomada de `lib/Misc.php::getPath` y
 * `AdjuntoController::moveFile` de la app PHP legada):
 *
 *   {STD_STORAGE_PATH}/{adjunto[0:2]}/{adjunto[2:4]}/{adjunto[4:6]}/{adjunto}
 *
 * `adjunto` es `sha1(nombre_original + microtime())`: 40 caracteres hexadecimales, sin extensión
 * y sin relación con el contenido del archivo — no se puede recalcular, solo leer de
 * `tbl_adjunto.adjunto`. El montaje es de SOLO LECTURA (`:ro` en docker-compose), igual que el
 * del SGD: este servicio nunca escribe.
 */

const STORAGE_BASE = process.env.STD_STORAGE_PATH ?? '/mnt/std/uploads';
const MAX_FILE_SIZE = Number(process.env.STD_MAX_BYTES ?? 100 * 1024 * 1024);
const VERIFICAR_HASH = (process.env.STD_VERIFICAR_HASH ?? 'false').toLowerCase() === 'true';

export class ArchivoStdError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ArchivoStdError';
    this.status = status;
  }
}

/**
 * `adjunto` sale de `tbl_adjunto.adjunto` (BD de solo lectura), así que en la práctica siempre
 * tiene esta forma — pero se valida igual antes de tocar el filesystem: sin este chequeo, un
 * valor inesperado con `../` permitiría leer fuera de `uploads/`. Nunca lo escribe un usuario
 * directamente en este backend; es defensa en profundidad, no confianza en el origen.
 */
const ADJUNTO_VALIDO = /^[0-9a-f]{40}$/i;

export function validarAdjunto(adjunto: string): void {
  if (!ADJUNTO_VALIDO.test(adjunto)) {
    throw new ArchivoStdError('Identificador de adjunto del STD inválido', 400);
  }
}

/** Sharding de 3 niveles (2+2+2 caracteres) del PHP legado. */
export function rutaAdjunto(adjunto: string): string {
  validarAdjunto(adjunto);
  const a = adjunto.toLowerCase();
  return path.join(STORAGE_BASE, a.slice(0, 2), a.slice(2, 4), a.slice(4, 6), a);
}

/**
 * `tbl_adjunto.mime` trae a veces `application/pdf; charset=binary` (subida por chunks) y a
 * veces el tipo tal cual lo mandó el navegador (subida antigua, `insertarAdjunto1`) — ver la
 * skill `std-database`. Para una cabecera `Content-Type` interesa solo el tipo, sin el parámetro.
 */
export function limpiarMime(mime: string | null | undefined): string {
  const limpio = (mime ?? '').split(';')[0].trim();
  return limpio.length > 0 ? limpio : 'application/octet-stream';
}

export interface ArchivoStdResuelto {
  buffer: Buffer;
  /** `true` solo si `STD_VERIFICAR_HASH=true` y el sha1 del contenido coincidió con el esperado. */
  hashVerificado: boolean;
}

/**
 * Lee un archivo del STD por su `adjunto`. `hashEsperado` es `tbl_adjunto.hash` (sha1 del
 * CONTENIDO, no del nombre del archivo): si `STD_VERIFICAR_HASH=true` y no coincide, se rechaza
 * en vez de servir un archivo que podría estar corrupto o mal montado.
 */
export function leerArchivoStd(adjunto: string, hashEsperado?: string | null): ArchivoStdResuelto {
  const ruta = rutaAdjunto(adjunto);

  let size: number;
  try {
    size = fs.statSync(ruta).size;
  } catch {
    throw new ArchivoStdError('Archivo no encontrado en el almacenamiento del STD', 404);
  }

  if (size > MAX_FILE_SIZE) {
    throw new ArchivoStdError(
      `El archivo supera el límite de ${Math.round(MAX_FILE_SIZE / (1024 * 1024))} MB`,
      413,
    );
  }

  const buffer = fs.readFileSync(ruta);

  let hashVerificado = false;
  if (VERIFICAR_HASH && hashEsperado) {
    const real = crypto.createHash('sha1').update(buffer).digest('hex');
    if (real.toLowerCase() !== hashEsperado.trim().toLowerCase()) {
      throw new ArchivoStdError('El archivo no coincide con el hash registrado en el STD (posible corrupción)', 409);
    }
    hashVerificado = true;
  }

  return { buffer, hashVerificado };
}

/**
 * ¿Está el repositorio de archivos del STD realmente montado? Igual razón que
 * `almacenamientoDisponible()` del SGD: el punto de montaje existe siempre (volumen vacío o
 * carpeta destino), esté o no el repositorio real encima.
 */
export function almacenamientoStdDisponible(): boolean {
  try {
    return fs.readdirSync(STORAGE_BASE).length > 0;
  } catch {
    return false;
  }
}

export function estadoAlmacenamientoStd(): { ruta: string; montado: boolean } {
  return { ruta: STORAGE_BASE, montado: almacenamientoStdDisponible() };
}
