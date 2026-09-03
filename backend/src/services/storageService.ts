import fs from 'fs';
import path from 'path';

/**
 * Resolución de los archivos físicos del SGD (documentos y anexos).
 *
 * Convención de rutas, verificada contra la BD y el disco real:
 *
 *   {STORAGE_PATH}/{nu_ann}/documentos/{nu_emi}/{nombre}
 *   {STORAGE_PATH}/{nu_ann}/documentos/{nu_emi}/anexos/{nu_ane}/{nombre}
 *
 * El SGD está migrando de guardar los archivos como BLOB en la BD a guardarlos en disco: en mayo
 * 2026 casi todo estaba en `bl_doc`, desde julio prácticamente todo va al filesystem. Por eso la
 * resolución es en cascada y hay que soportar ambos orígenes indefinidamente.
 */

const STORAGE_BASE = process.env.STORAGE_PATH ?? '/mnt/sgd/storage';

/** Un anexo real llega a pesar 20 MB, y los hay partidos en 10 volúmenes. Tope por archivo. */
const MAX_FILE_SIZE = 100 * 1024 * 1024;

export class ArchivoError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ArchivoError';
    this.status = status;
  }
}

/** `generado` = no había archivo y se dibujó al vuelo (PROVEÍDO / HOJA DE ENVÍO). */
export type OrigenArchivo = 'bd' | 'disco' | 'generado';

export interface ArchivoResuelto {
  buffer: Buffer;
  filename: string;
  origen: OrigenArchivo;
}

/** Fila de idosgd.tdtv_archivo_doc. */
export interface FilaArchivoDoc {
  bl_doc?: Buffer | null;
  de_ruta_origen?: string | null;
}

/** Fila de idosgd.tdtv_anexos. */
export interface FilaAnexo {
  bl_doc?: Buffer | null;
  de_rut_ori?: string | null;
  /** Viene del listado de anexos, que no trae el BLOB para no cargar 14 GB de bytea. */
  en_bd?: boolean;
}

/**
 * El nombre de la carpeta es `nu_emi` con ceros a la izquierda hasta 10 dígitos. Los valores que
 * vienen de la BD ya llegan así, pero `tdtv_anexos` los guarda con espacios sueltos, y un `nu_emi`
 * armado en código puede venir sin padding. Normalizar siempre.
 */
export function padEmi(valor: string | number): string {
  return String(valor).trim().padStart(10, '0');
}

/**
 * `de_ruta_origen` / `de_rut_ori` guardan solo el NOMBRE del archivo... salvo 104 filas que
 * traen una ruta absoluta del servidor Java que se filtró a la BD:
 * `/glassfish/tmppcm//2026000000199889237777.pdf`. Sin este basename, esas filas intentarían
 * resolverse fuera de la carpeta del documento.
 *
 * No se usa `path.basename` porque en Linux no corta por `\`, y la BD tiene ambos separadores.
 */
export function nombreArchivo(valor: string | null | undefined): string | null {
  if (!valor) return null;
  const limpio = String(valor).trim().replace(/^.*[/\\]/, '');
  return limpio.length > 0 ? limpio : null;
}

/**
 * Los archivos del SGD conservan el nombre original del usuario y las extensiones son variadas:
 * 30.437 pdf, 2.965 docx, 847 zip, 583 xlsx, 276 7z, 261 png, y volúmenes partidos .001/.002/…
 * Único mapa extensión→mime del proyecto — antes había dos copias (`documentoController.ts` e
 * `ingestaService.ts`) que podían divergir en silencio.
 */
const MIME_POR_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain; charset=utf-8',
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
};

export function mimePorNombre(nombre: string | null | undefined): string {
  const ext = (nombre ?? '').split('.').pop()?.toLowerCase() ?? '';
  return MIME_POR_EXTENSION[ext] ?? 'application/octet-stream';
}

export function carpetaDocumento(nuAnn: string | number, nuEmi: string | number): string {
  return path.join(STORAGE_BASE, String(nuAnn).trim(), 'documentos', padEmi(nuEmi));
}

/**
 * La carpeta del anexo es el valor literal de `nu_ane`, NO un índice 1..N: 223 documentos no
 * empiezan en 1 (ej. 2026/0000002250 tiene los anexos 6, 7, 8 y 9) y 130 tienen huecos.
 * Re-indexar rompería la correspondencia con el disco.
 */
export function carpetaAnexo(
  nuAnn: string | number,
  nuEmi: string | number,
  nuAne: string | number,
): string {
  return path.join(carpetaDocumento(nuAnn, nuEmi), 'anexos', String(nuAne).trim());
}

/**
 * Último recurso cuando el nombre de la BD no existe en disco. Hace falta porque el escritor del
 * SGD sanitiza los acentos al guardar: la BD dice `ADJUDICACIÓN_CARTA-...pdf` y en disco está
 * `ADJUDICACION_CARTA-...pdf`.
 *
 * Se prefiere el PDF: en las carpetas reales conviven la versión editable (`INFORME-R53.docx`) y
 * la firmada (`INFORME-R53.pdf`), y el orden alfabético devolvería el .docx — que no es lo que
 * se quiere ni para el visor ni para la unión de PDFs.
 */
function primerArchivo(dir: string): string | null {
  let entradas: string[];
  try {
    entradas = fs.readdirSync(dir);
  } catch {
    return null; // no existe la carpeta, o no hay permiso
  }

  const archivos = entradas.filter((nombre) => {
    try {
      return fs.statSync(path.join(dir, nombre)).isFile();
    } catch {
      return false;
    }
  });

  if (archivos.length === 0) return null;

  const pdfs = archivos.filter((nombre) => nombre.toLowerCase().endsWith('.pdf'));
  return [...(pdfs.length > 0 ? pdfs : archivos)].sort()[0];
}

/**
 * El nombre del archivo sale de un campo de texto libre de la BD del SGD. Sin esta comprobación,
 * un valor con `../` permitiría leer cualquier archivo del contenedor.
 */
function resolverRutaSegura(carpeta: string, nombre: string): string {
  const base = path.resolve(carpeta);
  const resuelta = path.resolve(carpeta, nombre);

  if (resuelta !== base && !resuelta.startsWith(base + path.sep)) {
    throw new ArchivoError('Ruta de archivo no permitida', 400);
  }

  return resuelta;
}

function leerArchivoSeguro(rutaCompleta: string): Buffer {
  const { size } = fs.statSync(rutaCompleta);

  if (size > MAX_FILE_SIZE) {
    throw new ArchivoError('El archivo supera el límite de 100 MB', 413);
  }

  return fs.readFileSync(rutaCompleta);
}

function tieneBlob(fila: { bl_doc?: Buffer | null } | null | undefined): fila is { bl_doc: Buffer } {
  return Boolean(fila?.bl_doc && fila.bl_doc.length > 0);
}

/**
 * Resuelve un archivo dentro de una carpeta aplicando la cascada disco:
 * nombre exacto de la BD → primer archivo de la carpeta.
 */
function resolverEnDisco(carpeta: string, nombreBd: string | null, queEs: string): ArchivoResuelto {
  let nombre = nombreBd;

  if (!nombre || !fs.existsSync(path.join(carpeta, nombre))) {
    nombre = primerArchivo(carpeta);
  }

  if (!nombre) {
    throw new ArchivoError(`${queEs} no encontrado en el almacenamiento`, 404);
  }

  const rutaCompleta = resolverRutaSegura(carpeta, nombre);
  return { buffer: leerArchivoSeguro(rutaCompleta), filename: nombre, origen: 'disco' };
}

/**
 * Documento principal de un remito.
 *
 * Cascada: BLOB en la BD → archivo en disco con el nombre de la BD → primer archivo de la carpeta.
 * `fila` es el resultado de consultar `tdtv_archivo_doc`; si es null se va directo al disco.
 */
export function resolverDocumento(
  nuAnn: string | number,
  nuEmi: string | number,
  fila?: FilaArchivoDoc | null,
): ArchivoResuelto {
  const nombreBd = nombreArchivo(fila?.de_ruta_origen);

  if (tieneBlob(fila)) {
    return {
      buffer: fila.bl_doc,
      filename: nombreBd ?? `documento_${nuAnn}_${padEmi(nuEmi)}.pdf`,
      origen: 'bd',
    };
  }

  return resolverEnDisco(carpetaDocumento(nuAnn, nuEmi), nombreBd, 'Documento');
}

/** Un anexo concreto. Misma cascada que el documento principal. */
export function resolverAnexo(
  nuAnn: string | number,
  nuEmi: string | number,
  nuAne: string | number,
  fila?: FilaAnexo | null,
): ArchivoResuelto {
  const nombreBd = nombreArchivo(fila?.de_rut_ori);

  if (tieneBlob(fila)) {
    return {
      buffer: fila.bl_doc,
      filename: nombreBd ?? `anexo_${nuAnn}_${padEmi(nuEmi)}_${nuAne}.pdf`,
      origen: 'bd',
    };
  }

  return resolverEnDisco(carpetaAnexo(nuAnn, nuEmi, nuAne), nombreBd, 'Anexo');
}

/**
 * Nombre del anexo SIN leerlo. Necesario para listar anexos y para que la unión de PDFs decida
 * por extensión si un archivo es fusionable: cargar en memoria un .7z de 20 MB solo para saber
 * cómo se llama tumbaría el proceso en un expediente con muchos anexos.
 */
export function resolverNombreAnexo(
  nuAnn: string | number,
  nuEmi: string | number,
  nuAne: string | number,
  fila?: FilaAnexo | null,
): string | null {
  const nombreBd = nombreArchivo(fila?.de_rut_ori);

  if (fila?.en_bd || tieneBlob(fila)) return nombreBd;

  const carpeta = carpetaAnexo(nuAnn, nuEmi, nuAne);
  if (nombreBd && fs.existsSync(path.join(carpeta, nombreBd))) return nombreBd;

  return primerArchivo(carpeta) ?? nombreBd;
}

/** Para diagnóstico: si el volumen no está montado, todo lo demás falla con 404 y no se sabe por qué. */
export function estadoAlmacenamiento(): { ruta: string; montado: boolean } {
  return { ruta: STORAGE_BASE, montado: fs.existsSync(STORAGE_BASE) };
}
