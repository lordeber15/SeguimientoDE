import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import PDFDocument from 'pdfkit';
import { PDFDocument as PdfLib, StandardFonts, rgb } from 'pdf-lib';
import type { PDFFont, PDFImage } from 'pdf-lib';
import {
  getAnexos,
  getArchivoAnexo,
  getArchivoDoc,
  getDatosDocumentoGenerado,
  getDocumentosExpediente,
  type AnexoListado,
  type DocumentoExpediente,
} from './documentoService';
import { esGenerable, generarDocumentoPdf } from './documentoGeneradoService';
import { cargarPdf } from './pdfPaginasService';
import { resolverAnexo, resolverDocumento, resolverNombreAnexo } from './storageService';

/**
 * PDF unificado de un expediente: todos sus documentos, en orden cronológico, cada uno precedido
 * de una separadora, con sus anexos entre marcadores y un índice paginado al frente.
 *
 * Es un job asíncrono en memoria con polling. Un merge de 90 documentos tarda minutos: una
 * request síncrona moriría por timeout, y la fusión es CPU-bound, así que sin ceder el event loop
 * bloquearía Express para todos los demás usuarios.
 *
 * Los originales se abren SIEMPRE en lectura: la fusión copia páginas a un PDF nuevo.
 */

const MAX_JOBS_ACTIVOS = 2;
/** Guard de memoria por job. Medido: hay expedientes reales de 664 MB, 379 MB y 360 MB. */
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;
const JOB_RETENCION_MS = 30 * 60 * 1000;
const JOB_ABANDONO_MS = 60 * 60 * 1000;
const LIMPIEZA_INTERVALO_MS = 10 * 60 * 1000;
const RE_ARCHIVO_UNION = /^Union_.*\.pdf$/i;

const MARGIN = 34;
const PAGE_W = 595;
const PAGE_H = 842;
const USABLE_W = PAGE_W - 2 * MARGIN;

/**
 * Partes de un comprimido dividido. Se agrupan en un solo marcador porque por separado no son
 * archivos abribles: `respaldo.7z.001` + `.002` son un único anexo.
 */
const RE_PARTES: { re: RegExp; sufijo: string }[] = [
  { re: /^(.*\.(?:7z|zip|rar|tar|gz))\.\d{2,3}$/i, sufijo: '' },
  { re: /^(.*)\.z\d{2}$/i, sufijo: '.zip' },
  { re: /^(.*)\.part\d+\.rar$/i, sufijo: '.rar' },
];

const EXT_IMAGEN = new Set(['jpg', 'jpeg', 'png']);

const NOTA_NO_FUSIONABLE = 'Este anexo no es un PDF ni una imagen: no puede incorporarse al documento unido.';
const NOTA_MULTIPARTE = 'Anexo comprimido en varias partes: no puede incorporarse al documento unido.';
const NOTA_LIMITE = 'Omitido: la unión alcanzó el límite de 300 MB.';

export interface ErrorUnion {
  nuEmi: string;
  documento: string;
  nuAne?: number;
  anexo?: string;
  motivo: string;
}

type EstadoJob = 'procesando' | 'completado' | 'error';
type FaseJob = 'consultando' | 'procesando' | 'ensamblando';

interface Job {
  id: string;
  nuAnnExp: string;
  nuSecExp: string;
  etiqueta: string;
  incluirAnexos: boolean;
  estado: EstadoJob;
  fase: FaseJob;
  total: number;
  procesados: number;
  errores: ErrorUnion[];
  mensajeError: string | null;
  filePath: string | null;
  filename: string;
  createdAt: number;
  finishedAt: number | null;
}

const jobs = new Map<string, Job>();

export class UnionError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'UnionError';
    this.status = status;
  }
}

// ── Directorio temporal ──────────────────────────────────────────────────────

/**
 * `UNION_TMP_PATH` es la ruta DENTRO del contenedor; `UNION_TMP_DIR` del `.env` es la del host y
 * docker-compose la monta ahí. Fuera de Docker (`npm run dev`) cae al temporal del sistema.
 */
function tmpDir(): string {
  return process.env.UNION_TMP_PATH ?? path.join(os.tmpdir(), 'seguimiento-union');
}

function ttlMs(): number {
  const horas = Number(process.env.UNION_TTL_HORAS ?? 6);
  return (Number.isFinite(horas) && horas > 0 ? horas : 6) * 60 * 60 * 1000;
}

/**
 * Borra solo los `Union_*.pdf` caducados por `mtime`. El filtro por patrón importa: el directorio
 * puede estar compartido y no se debe tocar nada ajeno.
 */
function limpiarArchivosExpirados() {
  let entradas: fs.Dirent[];
  try {
    entradas = fs.readdirSync(tmpDir(), { withFileTypes: true });
  } catch {
    return; // el directorio aún no existe
  }

  const ahora = Date.now();
  const limite = ttlMs();

  for (const entrada of entradas) {
    if (!entrada.isFile() || !RE_ARCHIVO_UNION.test(entrada.name)) continue;
    const ruta = path.join(tmpDir(), entrada.name);
    try {
      if (ahora - fs.statSync(ruta).mtimeMs > limite) fs.unlinkSync(ruta);
    } catch {
      // Un temporal que no se puede borrar no debe tumbar la limpieza del resto.
    }
  }
}

function limpiarJobsExpirados() {
  const ahora = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && ahora - job.finishedAt > JOB_RETENCION_MS) {
      jobs.delete(id);
    } else if (!job.finishedAt && ahora - job.createdAt > JOB_ABANDONO_MS) {
      job.estado = 'error';
      job.mensajeError = 'El trabajo excedió el tiempo máximo de procesamiento';
      job.finishedAt = ahora;
    }
  }
}

export function iniciarLimpiezaPeriodica() {
  limpiarArchivosExpirados(); // barrido de huérfanos de ejecuciones anteriores
  const timer = setInterval(() => {
    limpiarJobsExpirados();
    limpiarArchivosExpirados();
  }, LIMPIEZA_INTERVALO_MS);
  timer.unref(); // no impide que el proceso termine
  return timer;
}

// ── API pública ──────────────────────────────────────────────────────────────

export function iniciarJob(opciones: {
  nuAnnExp: string;
  nuSecExp: string;
  incluirAnexos: boolean;
}): { jobId: string } {
  const activos = [...jobs.values()].filter((j) => j.estado === 'procesando').length;
  if (activos >= MAX_JOBS_ACTIVOS) {
    throw new UnionError('Ya hay uniones de PDF en curso; inténtelo en unos minutos', 429);
  }

  const etiqueta = `${opciones.nuAnnExp}-${opciones.nuSecExp.replace(/^0+/, '') || '0'}`;
  const job: Job = {
    id: crypto.randomUUID(),
    nuAnnExp: opciones.nuAnnExp,
    nuSecExp: opciones.nuSecExp,
    etiqueta,
    incluirAnexos: opciones.incluirAnexos,
    estado: 'procesando',
    fase: 'consultando',
    total: 0,
    procesados: 0,
    errores: [],
    mensajeError: null,
    filePath: null,
    // Ambos se reemplazan en cuanto se conoce el `nu_expediente` real (ver ejecutarJob).
    filename: `Expediente_${etiqueta}${opciones.incluirAnexos ? '' : '_sin_anexos'}.pdf`,
    createdAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(job.id, job);

  ejecutarJob(job).catch((error: unknown) => {
    job.estado = 'error';
    job.mensajeError =
      error instanceof UnionError ? error.message : 'Error interno al unir los PDFs';
    job.finishedAt = Date.now();
    if (!(error instanceof UnionError)) {
      console.error(`unirPdf: job ${job.id} falló:`, error);
    }
  });

  return { jobId: job.id };
}

export function getEstado(jobId: string) {
  const job = jobs.get(jobId);
  if (!job) return null;

  return {
    jobId: job.id,
    estado: job.estado,
    fase: job.fase,
    total: job.total,
    procesados: job.procesados,
    errores: job.errores,
    mensajeError: job.mensajeError,
    filename: job.filename,
  };
}

/** No borra el archivo: dentro de la ventana TTL se puede volver a descargar. */
export function getDescarga(jobId: string): { filePath: string; filename: string } {
  const job = jobs.get(jobId);
  if (!job) throw new UnionError('El trabajo no existe o ya caducó', 404);
  if (job.estado === 'procesando') throw new UnionError('El trabajo aún no ha terminado', 409);
  if (job.estado === 'error') {
    throw new UnionError(job.mensajeError ?? 'El trabajo terminó con error', 409);
  }
  if (!job.filePath || !fs.existsSync(job.filePath)) {
    throw new UnionError('El archivo generado ya no está disponible', 410);
  }

  return { filePath: job.filePath, filename: job.filename };
}

// ── Runner ───────────────────────────────────────────────────────────────────

const cederEventLoop = () => new Promise((resolve) => setImmediate(resolve));

interface GrupoAnexo {
  numero: number;
  titulo: string;
  archivos: { nuAne: number; filename: string | null }[];
  multiparte: boolean;
  tipo: 'pdf' | 'imagen' | 'otro';
  /** 1-based dentro del cuerpo; null si no llegó a incluirse. */
  pagRel: number | null;
}

interface EntradaIndice {
  titulo: string;
  fecha: string;
  pagRel: number | null;
  grupos: GrupoAnexo[];
}

interface Contexto {
  cuerpo: PdfLib;
  fuentes: { normal: PDFFont; bold: PDFFont; italic: PDFFont };
  job: Job;
  bytes: number;
}

async function ejecutarJob(job: Job) {
  job.fase = 'consultando';

  const docs = await getDocumentosExpediente(job.nuAnnExp, job.nuSecExp);
  if (docs.length === 0) {
    throw new UnionError('El expediente no tiene documentos', 404);
  }

  // El expediente se identifica en la interfaz por `nu_expediente` (`OGAUL020260000058`), no por
  // la clave `nu_ann_exp/nu_sec_exp`. Si el PDF llevara la clave, el usuario no podría casarlo con
  // la fila desde la que lo pidió. Se toma del primer documento que lo traiga.
  const numeroSgd = docs.find((d) => d.numeroExpediente)?.numeroExpediente;
  if (numeroSgd) {
    job.etiqueta = numeroSgd;
    job.filename = `Expediente_${numeroSgd}${job.incluirAnexos ? '' : '_sin_anexos'}.pdf`;
  }

  // Los anexos se consultan y agrupan ANTES de fusionar nada: el grupo es la unidad de
  // numeración "anexo N" que comparten cuerpo, separadoras e índice, y la unidad de progreso.
  const gruposPorDoc = new Map<string, GrupoAnexo[]>();
  if (job.incluirAnexos) {
    for (const doc of docs) {
      if (doc.numAnexos === 0) continue;
      try {
        const anexos = await getAnexos(doc.nuAnn, doc.nuEmi);
        gruposPorDoc.set(clave(doc), agruparAnexos(doc.nuAnn, doc.nuEmi, anexos));
      } catch (error) {
        console.error(`unirPdf: no se pudieron listar los anexos de ${doc.nuEmi}:`, error);
      }
      await cederEventLoop();
    }
  }

  const totalGrupos = [...gruposPorDoc.values()].reduce((n, g) => n + g.length, 0);
  job.total = docs.length + totalGrupos;
  job.fase = 'procesando';

  const separadoras = await PdfLib.load(await renderSeparadoras(docs, job, gruposPorDoc));
  const cuerpo = await PdfLib.create();
  const ctx: Contexto = {
    cuerpo,
    fuentes: {
      normal: await cuerpo.embedFont(StandardFonts.Helvetica),
      bold: await cuerpo.embedFont(StandardFonts.HelveticaBold),
      italic: await cuerpo.embedFont(StandardFonts.HelveticaOblique),
    },
    job,
    bytes: 0,
  };

  const entradas: EntradaIndice[] = [];

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const entrada: EntradaIndice = {
      titulo: doc.titulo || 'DOCUMENTO',
      fecha: doc.fechaEmision ?? '',
      pagRel: null,
      grupos: gruposPorDoc.get(clave(doc)) ?? [],
    };
    entradas.push(entrada);

    try {
      const buffer = await obtenerBufferPdf(doc);
      ctx.bytes += buffer.length;
      if (ctx.bytes > MAX_TOTAL_BYTES) {
        throw new UnionError(
          'La unión supera el límite de 300 MB. Genere el PDF sin anexos: en los expedientes '
            + 'pesados los anexos son casi todo el volumen.',
          413,
        );
      }

      const pdf = await cargarPdf(buffer);

      // Separadora del documento i seguida de sus páginas. Son copias: el original no se toca.
      entrada.pagRel = cuerpo.getPageCount() + 1;
      const [separadora] = await cuerpo.copyPages(separadoras, [i]);
      cuerpo.addPage(separadora);
      const paginas = await cuerpo.copyPages(pdf, pdf.getPageIndices());
      for (const pagina of paginas) cuerpo.addPage(pagina);
    } catch (error) {
      // Solo el límite global es fatal: un PDF corrupto, cifrado o ausente no aborta el job.
      if (error instanceof UnionError) throw error;
      entrada.pagRel = null;
      job.errores.push({
        nuEmi: doc.nuEmi,
        documento: doc.titulo,
        motivo: motivoDe(error),
      });
    }

    job.procesados++;
    await cederEventLoop(); // la fusión es CPU-bound: no bloquear otras requests

    for (const grupo of entrada.grupos) {
      await anexarGrupo(ctx, grupo, doc);
      job.procesados++;
      await cederEventLoop();
    }
  }

  if (cuerpo.getPageCount() === 0) {
    throw new UnionError('Ningún documento del expediente pudo incluirse en la unión', 422);
  }

  job.fase = 'ensamblando';

  const indice = await PdfLib.load(await renderIndice(job, entradas));
  const paginasIndice = await cuerpo.copyPages(indice, indice.getPageIndices());
  paginasIndice.forEach((pagina, i) => cuerpo.insertPage(i, pagina));

  estamparPiePagina(cuerpo, ctx.fuentes.normal);

  const bytes = await cuerpo.save();
  fs.mkdirSync(tmpDir(), { recursive: true });
  // La etiqueta viene de la BD: se sanea antes de usarla como nombre de archivo.
  const seguro = job.etiqueta.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
  const filePath = path.join(tmpDir(), `Union_${seguro}_${job.id}.pdf`);
  fs.writeFileSync(filePath, bytes);

  job.filePath = filePath;
  job.estado = 'completado';
  job.finishedAt = Date.now();
}

const clave = (doc: DocumentoExpediente) => `${doc.nuAnn}|${doc.nuEmi}`;

function motivoDe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Error desconocido';
}

// ── Obtención del PDF de cada documento ──────────────────────────────────────

async function obtenerBufferPdf(doc: DocumentoExpediente): Promise<Buffer> {
  // Los PROVEÍDOS y HOJAS DE ENVÍO se dibujan al vuelo aunque exista archivo: el SGD nunca los
  // guardó, y cuando hay fila en tdtv_archivo_doc suele ser un adjunto distinto.
  if (esGenerable(doc.coTipDoc)) {
    const datos = await getDatosDocumentoGenerado(doc.nuAnn, doc.nuEmi);
    if (!datos) throw new Error('Sin datos para generar el documento');
    return generarDocumentoPdf(datos);
  }

  if (!doc.tieneArchivo) throw new Error('Sin archivo digital');

  const fila = await getArchivoDoc(doc.nuAnn, doc.nuEmi);
  return resolverDocumento(doc.nuAnn, doc.nuEmi, fila).buffer;
}

// ── Anexos ───────────────────────────────────────────────────────────────────

function agruparAnexos(nuAnn: string, nuEmi: string, anexos: AnexoListado[]): GrupoAnexo[] {
  const items = anexos.map((anexo) => {
    let filename: string | null = null;
    try {
      filename = resolverNombreAnexo(nuAnn, nuEmi, anexo.nuAne, {
        de_rut_ori: anexo.nombreArchivo,
        en_bd: anexo.enBd,
      });
    } catch {
      // Nombre irresoluble: el grupo cae a 'otro' por extensión vacía.
    }
    return { anexo, filename, clave: filename ? claveMultiparte(filename) : null };
  });

  // Un split de WinZip nombra la última parte `x.zip` y el resto `x.z01…`. Ese archivo sin sufijo
  // numérico solo se reconoce como parte cuando ya sabemos que existen hermanos que lo apuntan,
  // de ahí esta segunda pasada.
  const clavesParte = new Set(items.map((i) => i.clave).filter(Boolean));
  for (const item of items) {
    if (!item.clave && item.filename && clavesParte.has(item.filename.toLowerCase())) {
      item.clave = item.filename.toLowerCase();
    }
  }

  const grupos: GrupoAnexo[] = [];
  const porClave = new Map<string, GrupoAnexo>();

  for (const { anexo, filename, clave: claveParte } of items) {
    const archivo = { nuAne: anexo.nuAne, filename };
    if (claveParte && porClave.has(claveParte)) {
      porClave.get(claveParte)!.archivos.push(archivo);
      continue;
    }

    const grupo: GrupoAnexo = {
      numero: grupos.length + 1,
      titulo: anexo.titulo ?? 'Sin nombre',
      archivos: [archivo],
      multiparte: Boolean(claveParte),
      tipo: claveParte ? 'otro' : tipoPorExtension(filename),
      pagRel: null,
    };
    grupos.push(grupo);
    if (claveParte) porClave.set(claveParte, grupo);
  }

  return grupos;
}

function claveMultiparte(filename: string): string | null {
  for (const { re, sufijo } of RE_PARTES) {
    const m = re.exec(filename);
    if (m) return `${m[1]}${sufijo}`.toLowerCase();
  }
  return null;
}

function tipoPorExtension(filename: string | null): 'pdf' | 'imagen' | 'otro' {
  const ext = (filename ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return 'pdf';
  if (EXT_IMAGEN.has(ext)) return 'imagen';
  return 'otro';
}

/**
 * Compara título y nombre de archivo ignorando lo que no distingue a un archivo de otro.
 *
 * Hace falta porque las dos columnas del SGD guardan el mismo nombre con distinto grado de
 * deterioro: `de_det` trae `... N ° 007-...` y `de_rut_ori` trae `... NÂ° 007-...` — el mismo
 * archivo escrito una vez en UTF-8 y otra con UTF-8 interpretado como Latin-1. Sin esto, la
 * etiqueta repite el nombre entero dos veces y no cabe ni en la separadora ni en el índice.
 */
function mismoNombre(a: string, b: string): boolean {
  const normalizar = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // acentos combinados que deja el NFD
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase();

  // Deshace el mojibake concreto que produce el SGD: bytes UTF-8 guardados como Latin-1
  // (`N°` → `NÂ°`). Sin esto, `Â` sobrevive a la normalización como una `A` y los dos nombres
  // parecen distintos justo en el caso que este helper existe para detectar.
  const variantes = (s: string) => {
    const salida = new Set([normalizar(s)]);
    try {
      salida.add(normalizar(Buffer.from(s, 'latin1').toString('utf8')));
    } catch {
      // Si no es reinterpretable, basta con la forma normalizada.
    }
    return salida;
  };

  const deB = variantes(b);
  return [...variantes(a)].some((v) => deB.has(v));
}

function etiquetaGrupo(grupo: GrupoAnexo): string {
  const nombre = grupo.archivos[0]?.filename;
  const partes = grupo.archivos.length > 1 ? ` (${grupo.archivos.length} partes)` : '';
  return nombre && !mismoNombre(nombre, grupo.titulo)
    ? `${grupo.titulo} — ${nombre}${partes}`
    : `${grupo.titulo}${partes}`;
}

/**
 * Incorpora un grupo al cuerpo. Resuelve y valida el archivo ANTES de dibujar nada, para que un
 * fallo nunca deje un marcador INICIO sin contenido detrás.
 */
async function anexarGrupo(ctx: Contexto, grupo: GrupoAnexo, doc: DocumentoExpediente) {
  const base = {
    numero: grupo.numero,
    tituloDoc: doc.titulo,
    tituloAnexo: grupo.titulo,
    archivos: grupo.archivos,
  };

  if (grupo.tipo === 'otro') {
    grupo.pagRel = ctx.cuerpo.getPageCount() + 1;
    dibujarMarcador(ctx, {
      ...base,
      variante: 'unico',
      nota: grupo.multiparte ? NOTA_MULTIPARTE : NOTA_NO_FUSIONABLE,
    });
    return;
  }

  const { nuAne } = grupo.archivos[0];
  let pdf: PdfLib | null = null;
  let imagen: PDFImage | null = null;

  try {
    const fila = await getArchivoAnexo(doc.nuAnn, doc.nuEmi, nuAne);
    const { buffer } = resolverAnexo(doc.nuAnn, doc.nuEmi, nuAne, fila);

    if (ctx.bytes + buffer.length > MAX_TOTAL_BYTES) throw new Error(NOTA_LIMITE);

    if (grupo.tipo === 'pdf') {
      pdf = await cargarPdf(buffer);
      if (pdf.getPageCount() === 0) throw new Error('El PDF del anexo no tiene páginas');
    } else {
      imagen = await embeberImagen(ctx.cuerpo, buffer);
    }
    ctx.bytes += buffer.length;
  } catch (error) {
    const motivo = motivoDe(error);
    ctx.job.errores.push({
      nuEmi: doc.nuEmi,
      documento: doc.titulo,
      nuAne,
      anexo: grupo.titulo,
      motivo,
    });
    grupo.pagRel = ctx.cuerpo.getPageCount() + 1;
    dibujarMarcador(ctx, { ...base, variante: 'unico', nota: motivo });
    return;
  }

  grupo.pagRel = ctx.cuerpo.getPageCount() + 1;
  dibujarMarcador(ctx, { ...base, variante: 'inicio' });
  if (pdf) {
    const paginas = await ctx.cuerpo.copyPages(pdf, pdf.getPageIndices());
    for (const pagina of paginas) ctx.cuerpo.addPage(pagina);
  } else if (imagen) {
    agregarPaginaImagen(ctx.cuerpo, imagen);
  }
  dibujarMarcador(ctx, { ...base, variante: 'fin' });
}

async function embeberImagen(cuerpo: PdfLib, buffer: Buffer): Promise<PDFImage> {
  const esPng = buffer.length > 8 && buffer.readUInt32BE(0) === 0x89504e47;
  try {
    return esPng ? await cuerpo.embedPng(buffer) : await cuerpo.embedJpg(buffer);
  } catch {
    throw new Error('Imagen ilegible o en un formato no soportado');
  }
}

function agregarPaginaImagen(cuerpo: PdfLib, img: PDFImage) {
  const escala = Math.min(USABLE_W / img.width, (PAGE_H - 2 * MARGIN) / img.height, 1);
  const w = img.width * escala;
  const h = img.height * escala;
  cuerpo.addPage([PAGE_W, PAGE_H]).drawImage(img, {
    x: (PAGE_W - w) / 2,
    y: (PAGE_H - h) / 2,
    width: w,
    height: h,
  });
}

const ETIQUETA_VARIANTE = { inicio: 'INICIO ANEXO', fin: 'FIN ANEXO', unico: 'ANEXO' };
/** El marcador es siempre 1 página exacta: se trunca la lista de partes. */
const MARCADOR_MAX_ARCHIVOS = 12;

/**
 * Los marcadores son texto y dos reglas: se dibujan con pdf-lib directamente sobre el cuerpo, sin
 * el rodeo pdfkit → Buffer → load → copyPages que sí necesitan separadoras e índice, cuya
 * paginación hay que calcular de antemano.
 */
function dibujarMarcador(
  ctx: Contexto,
  opciones: {
    variante: 'inicio' | 'fin' | 'unico';
    numero: number;
    tituloDoc: string;
    tituloAnexo: string;
    archivos: { filename: string | null }[];
    nota?: string;
  },
) {
  const { normal, bold, italic } = ctx.fuentes;
  const page = ctx.cuerpo.addPage([PAGE_W, PAGE_H]);
  const gris = rgb(0.27, 0.27, 0.27);
  let y = 560;

  const regla = () => {
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 1,
      color: rgb(0.4, 0.4, 0.4),
    });
  };

  const centrar = (texto: string, font: PDFFont, size: number, color = rgb(0, 0, 0)) => {
    const t = truncar(texto, font, size, USABLE_W - 20);
    page.drawText(t, { x: (PAGE_W - font.widthOfTextAtSize(t, size)) / 2, y, size, font, color });
  };

  regla();
  y -= 34;
  centrar(`${ETIQUETA_VARIANTE[opciones.variante]} ${opciones.numero}`, bold, 18);
  y -= 26;
  centrar(`Pertenece a: ${opciones.tituloDoc}`, normal, 11);
  y -= 20;
  if (opciones.tituloAnexo) {
    centrar(opciones.tituloAnexo, normal, 9.5, gris);
    y -= 22;
  }

  centrar(opciones.archivos.length > 1 ? 'Archivos:' : 'Archivo:', bold, 9, gris);
  y -= 14;
  for (const archivo of opciones.archivos.slice(0, MARCADOR_MAX_ARCHIVOS)) {
    centrar(archivo.filename ?? '(nombre no disponible)', normal, 9, gris);
    y -= 13;
  }
  if (opciones.archivos.length > MARCADOR_MAX_ARCHIVOS) {
    centrar(`+${opciones.archivos.length - MARCADOR_MAX_ARCHIVOS} parte(s) más`, italic, 8.5, gris);
    y -= 13;
  }

  if (opciones.nota) {
    y -= 8;
    centrar(opciones.nota, italic, 8.5, rgb(0.55, 0.35, 0.05));
    y -= 14;
  }
  y -= 8;
  regla();
}

/**
 * Las fuentes estándar de pdf-lib solo codifican WinAnsi: cualquier carácter fuera de ese
 * repertorio hace que `drawText` lance. Los asuntos del SGD traen `°`, `–`, comillas tipográficas
 * y algún emoji suelto, así que se sustituyen antes de dibujar.
 */
const RE_NO_WINANSI = /[^\x20-\x7E\xA0-\xFF–—‘’“”•…€]/g;

export function truncar(texto: string, font: PDFFont, size: number, maxWidth: number): string {
  const limpio = String(texto ?? '').replace(/\s+/g, ' ').replace(RE_NO_WINANSI, '?').trim();
  if (font.widthOfTextAtSize(limpio, size) <= maxWidth) return limpio;

  let corte = limpio;
  while (corte.length > 1 && font.widthOfTextAtSize(`${corte}…`, size) > maxWidth) {
    corte = corte.slice(0, -1);
  }
  return `${corte}…`;
}

// ── Separadoras e índice (pdfkit) ────────────────────────────────────────────

function pdfkitABuffer(construir: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [PAGE_W, PAGE_H],
      margin: MARGIN,
      autoFirstPage: false,
    });
    const trozos: Buffer[] = [];
    doc.on('data', (c: Buffer) => trozos.push(c));
    doc.on('end', () => resolve(Buffer.concat(trozos)));
    doc.on('error', reject);
    construir(doc);
    doc.end();
  });
}

const ANEXOS_MAX_LINEAS = 14;

/**
 * Una página exacta por documento: posiciones absolutas y textos con altura acotada (`ellipsis`),
 * para que pdfkit nunca desborde a otra página — el cuerpo copia la separadora `i` para el
 * documento `i` y un desbordamiento descuadraría todo.
 */
function renderSeparadoras(
  docs: DocumentoExpediente[],
  job: Job,
  gruposPorDoc: Map<string, GrupoAnexo[]>,
): Promise<Buffer> {
  return pdfkitABuffer((doc) => {
    for (const item of docs) {
      doc.addPage();
      const cx = MARGIN;
      let y = 260;

      doc.font('Helvetica').fontSize(9).fillColor('#666666')
        .text(`EXPEDIENTE ${job.etiqueta}`, cx, y, {
          width: USABLE_W,
          align: 'center',
          height: 12,
          ellipsis: true,
        });
      y += 30;
      doc.moveTo(cx + 80, y).lineTo(PAGE_W - MARGIN - 80, y)
        .lineWidth(0.7).strokeColor('#999999').stroke();
      y += 24;
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#000000')
        .text(item.titulo, cx, y, { width: USABLE_W, align: 'center', height: 40, ellipsis: true });
      y += 52;
      doc.font('Helvetica').fontSize(10).fillColor('#333333')
        .text(item.fechaEmision ?? '', cx, y, {
          width: USABLE_W,
          align: 'center',
          height: 14,
          ellipsis: true,
        });
      y += 26;
      if (item.dependenciaEmisora) {
        doc.font('Helvetica').fontSize(9)
          .text(`Emite: ${item.dependenciaEmisora}`, cx, y, {
            width: USABLE_W,
            align: 'center',
            height: 12,
            ellipsis: true,
          });
        y += 16;
      }
      if (item.dependenciaDestino) {
        doc.font('Helvetica').fontSize(9)
          .text(`Destino: ${item.dependenciaDestino}`, cx, y, {
            width: USABLE_W,
            align: 'center',
            height: 12,
            ellipsis: true,
          });
        y += 16;
      }
      y += 20;
      doc.moveTo(cx + 80, y).lineTo(PAGE_W - MARGIN - 80, y)
        .lineWidth(0.5).strokeColor('#cccccc').stroke();
      y += 16;
      doc.font('Helvetica').fontSize(8).fillColor('#444444')
        .text(item.asunto ?? '', cx + 40, y, {
          width: USABLE_W - 80,
          align: 'center',
          height: 60,
          ellipsis: true,
        });
      y += 70; // deja atrás el bloque de asunto con margen, crezca lo que crezca

      const grupos = gruposPorDoc.get(clave(item)) ?? [];
      if (grupos.length > 0) {
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000')
          .text('ANEXOS', cx + 40, y, { width: USABLE_W - 80, height: 11 });
        y += 16;
        const mostrar = grupos.slice(0, ANEXOS_MAX_LINEAS);
        doc.font('Helvetica').fontSize(7.5).fillColor('#333333');
        for (const grupo of mostrar) {
          doc.text(`${grupo.numero}. ${etiquetaGrupo(grupo)}`, cx + 44, y, {
            width: USABLE_W - 88,
            height: 11,
            ellipsis: true,
            lineBreak: false,
          });
          y += 13;
        }
        const restantes = grupos.length - mostrar.length;
        if (restantes > 0) {
          doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#888888')
            .text(`+${restantes} más — ver índice`, cx + 44, y, {
              width: USABLE_W - 88,
              height: 11,
              ellipsis: true,
              lineBreak: false,
            });
        }
      }
    }
  });
}

const IDX_HEADER_H = 70; // título + expediente, solo en la primera página
const IDX_ROW_H_DOC = 15;
const IDX_ROW_H_ANEXO = 11;
const IDX_TOP = MARGIN + 10;
const IDX_BOTTOM = PAGE_H - MARGIN - 20;

type FilaIndice =
  | { tipo: 'doc'; entrada: EntradaIndice; numeroDoc: number }
  | { tipo: 'anexo'; grupo: GrupoAnexo };

/**
 * Planificador puro: decide de antemano en qué página y a qué altura cae cada fila.
 *
 * Es la clave para que la numeración del índice sea exacta en un solo render: el número de página
 * absoluto de un documento es `páginasDelÍndice + pagRel`, y `páginasDelÍndice` solo se conoce
 * cuando ya se sabe cuántas filas caben. Calcularlo aparte evita el bucle "render → contar →
 * volver a renderizar" que produce índices desfasados cuando el total cambia de decena.
 */
export function planificarFilas(filas: { tipo: 'doc' | 'anexo' }[]) {
  const asignaciones: { pagina: number; y: number }[] = [];
  let pagina = 0;
  let y = IDX_TOP + IDX_HEADER_H;

  for (const fila of filas) {
    const altura = fila.tipo === 'doc' ? IDX_ROW_H_DOC : IDX_ROW_H_ANEXO;
    if (y + altura > IDX_BOTTOM) {
      pagina++;
      y = IDX_TOP + 20;
    }
    asignaciones.push({ pagina, y });
    y += altura;
  }

  return { asignaciones, totalPaginas: pagina + 1 };
}

function renderIndice(job: Job, entradas: EntradaIndice[]): Promise<Buffer> {
  const filas: FilaIndice[] = [];
  entradas.forEach((entrada, i) => {
    filas.push({ tipo: 'doc', entrada, numeroDoc: i + 1 });
    for (const grupo of entrada.grupos) filas.push({ tipo: 'anexo', grupo });
  });

  const { asignaciones, totalPaginas } = planificarFilas(filas);

  return pdfkitABuffer((doc) => {
    let paginaActual = -1;

    filas.forEach((fila, idx) => {
      const { pagina, y } = asignaciones[idx];

      if (pagina !== paginaActual) {
        doc.addPage();
        paginaActual = pagina;
        if (pagina === 0) {
          doc.font('Helvetica-Bold').fontSize(15).fillColor('#000000')
            .text('ÍNDICE DE DOCUMENTOS', MARGIN, IDX_TOP, {
              width: USABLE_W,
              align: 'center',
              height: 20,
              ellipsis: true,
            });
          const nAnexos = entradas.reduce((n, e) => n + e.grupos.length, 0);
          const resumen = `Expediente ${job.etiqueta} — ${entradas.length} documento(s)`
            + (job.incluirAnexos ? `, ${nAnexos} anexo(s)` : ' — anexos no incluidos');
          doc.font('Helvetica').fontSize(9).fillColor('#555555')
            .text(resumen, MARGIN, IDX_TOP + 26, {
              width: USABLE_W,
              align: 'center',
              height: 12,
              ellipsis: true,
            });
        }
      }

      if (fila.tipo === 'doc') {
        const { entrada, numeroDoc } = fila;
        const numeroPagina = entrada.pagRel == null
          ? 'no incluido'
          : String(totalPaginas + entrada.pagRel);
        doc.font('Helvetica').fontSize(8).fillColor('#000000')
          .text(`${numeroDoc}.`, MARGIN, y, { width: 24, height: 11, ellipsis: true });
        doc.font('Helvetica').fontSize(8)
          .text(entrada.titulo, MARGIN + 26, y, {
            width: USABLE_W - 26 - 150 - 60,
            height: 11,
            ellipsis: true,
            lineBreak: false,
          });
        doc.font('Helvetica').fontSize(7).fillColor('#666666')
          .text(entrada.fecha, PAGE_W - MARGIN - 200, y + 1, {
            width: 130,
            align: 'right',
            height: 10,
            ellipsis: true,
            lineBreak: false,
          });
        doc.font(entrada.pagRel == null ? 'Helvetica-Oblique' : 'Helvetica-Bold').fontSize(8)
          .fillColor(entrada.pagRel == null ? '#999999' : '#000000')
          .text(numeroPagina, PAGE_W - MARGIN - 60, y, {
            width: 60,
            align: 'right',
            height: 11,
            ellipsis: true,
            lineBreak: false,
          });
      } else {
        const { grupo } = fila;
        doc.font('Helvetica').fontSize(7).fillColor('#555555')
          .text(`${grupo.numero}. ${etiquetaGrupo(grupo)}`, MARGIN + 52, y, {
            width: USABLE_W - 52 - 60,
            height: 10,
            ellipsis: true,
            lineBreak: false,
          });
        doc.font('Helvetica').fontSize(7).fillColor('#666666')
          .text(grupo.pagRel == null ? '—' : String(totalPaginas + grupo.pagRel),
            PAGE_W - MARGIN - 60, y, {
              width: 60,
              align: 'right',
              height: 10,
              ellipsis: true,
              lineBreak: false,
            });
      }
    });
  });
}

/** Pie "Pág. X de Y" para que la numeración impresa coincida con el índice y con el visor. */
function estamparPiePagina(pdf: PdfLib, font: PDFFont) {
  const total = pdf.getPageCount();
  pdf.getPages().forEach((page, i) => {
    const { width } = page.getSize();
    const texto = `Pág. ${i + 1} de ${total}`;
    page.drawText(texto, {
      x: width - font.widthOfTextAtSize(texto, 7) - 18,
      y: 10,
      size: 7,
      font,
      color: rgb(0.35, 0.35, 0.35),
    });
  });
}
