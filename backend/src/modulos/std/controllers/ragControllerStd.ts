import type { Request, Response } from 'express';
import { crearEmbeddingProvider } from '../../../compartido/ai/providerFactory';
import { ErrorIA } from '../../../compartido/ai/types';
import { barrerStd, BarridoStdOcupado } from '../rag/barridoStdService';
import { escribirConfig, listarConfig } from '../../../compartido/rag/configService';
import {
  activarModelo,
  listarModelos,
  ModeloError,
  registrarSiNoExiste,
} from '../../../compartido/rag/embeddingModelService';
import { stdRagSequelize } from '../config/stdRagDatabase';
import {
  coberturaPorDocumentoStd,
  consumoTokensStd,
  estadoBarridoStd,
  estadoCorpusStd,
  estadoMantenimientoStd,
  estadoProveedoresStd,
  evaluacionRetrievalStd,
  listarDocumentosStd,
  markdownDocumentoStd,
} from '../rag/estadoStdService';
import {
  cancelarJobStd,
  estadoJobStd,
  type FiltroIngestaStd,
  IngestaStdError,
  iniciarJobConversionStd,
  iniciarJobEmbeddingStd,
  iniciarJobReintentoSinArchivoStd,
  listarJobsStd,
  pausarJobStd,
  reanudarJobStd,
  repararDocumentoStd,
} from '../rag/ingestaStdService';
import { ejecutarGCStd, ejecutarRetencionStd } from '../rag/mantenimientoStdService';
import { transcribirDocumentoStd } from '../rag/visionStdService';
import type { OrigenAdjuntoStd } from '../services/stdDocumentoService';

/**
 * Panel de administración del módulo STD (`std.gestionar`) — mismo diseño que
 * `modulos/sgd/controllers/ragController.ts`, reescrito contra `std_rag` y acotado a lo que el
 * motor del STD ya ofrece hoy (ver la cabecera de `ingestaStdService.ts`: sin reparación masiva,
 * sin "documentos largos sueltos" — se añadirán aquí mismo si hace falta, siguiendo este mismo
 * patrón).
 */

function manejar(res: Response, error: unknown, contexto: string) {
  if (error instanceof BarridoStdOcupado) {
    return res.status(409).json({ message: 'Ya hay un barrido del STD en curso' });
  }
  if (error instanceof IngestaStdError || error instanceof ModeloError) {
    return res.status(error.status).json({ message: error.message });
  }
  if (error instanceof ErrorIA) {
    return res.status(409).json({ message: error.message });
  }
  console.error(`${contexto}:`, error);
  return res.status(500).json({ message: 'Error al procesar la operación' });
}

const RE_ID_DOCUMENTO = /^\d{1,10}$/;
const ORIGENES_VALIDOS = new Set<OrigenAdjuntoStd>(['principal', 'anexo', 'derivacion']);
/** Mismo tope que el `limite` por defecto de un job — una selección manual no necesita más. */
const MAX_IDS_POR_JOB = 500;

function filtroDeBodyStd(body: unknown): FiltroIngestaStd {
  const b = (body ?? {}) as Record<string, unknown>;

  let idDocumento: number | undefined;
  if (b.idDocumento !== undefined && b.idDocumento !== null && b.idDocumento !== '') {
    const n = Number(b.idDocumento);
    if (!Number.isInteger(n) || n < 1) throw new IngestaStdError('"idDocumento" inválido');
    idDocumento = n;
  }

  let documentoIds: number[] | undefined;
  if (b.documentoIds !== undefined && b.documentoIds !== null) {
    if (!Array.isArray(b.documentoIds) || b.documentoIds.length === 0) {
      throw new IngestaStdError('"documentoIds" debe ser un arreglo con al menos un id');
    }
    if (b.documentoIds.length > MAX_IDS_POR_JOB) {
      throw new IngestaStdError(`Como máximo ${MAX_IDS_POR_JOB} documentos por trabajo`);
    }
    documentoIds = b.documentoIds.map((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new IngestaStdError('"documentoIds" tiene un id inválido');
      return n;
    });
  }

  let anio: number | undefined;
  if (b.anio !== undefined && b.anio !== null && b.anio !== '') {
    const n = Number(b.anio);
    if (!Number.isInteger(n) || n < 2000 || n > 2100) throw new IngestaStdError('"anio" inválido');
    anio = n;
  }

  let origen: OrigenAdjuntoStd | undefined;
  if (b.origen !== undefined && b.origen !== null && b.origen !== '') {
    if (!ORIGENES_VALIDOS.has(b.origen as OrigenAdjuntoStd)) throw new IngestaStdError('"origen" inválido');
    origen = b.origen as OrigenAdjuntoStd;
  }

  let limite: number | undefined;
  if (b.limite !== undefined && b.limite !== null) {
    const n = Number(b.limite);
    if (!Number.isInteger(n) || n < 1) throw new IngestaStdError('"limite" debe ser un entero mayor o igual a 1');
    limite = n;
  }

  return { idDocumento, documentoIds, anio, origen, limite };
}

/** Todo lo que pinta el panel, en una sola llamada. */
export async function getPanel(_req: Request, res: Response) {
  try {
    const [corpus, barrido, proveedores, tokens, mantenimiento, evaluacion] = await Promise.all([
      estadoCorpusStd(),
      estadoBarridoStd(),
      estadoProveedoresStd(),
      consumoTokensStd(),
      estadoMantenimientoStd(),
      evaluacionRetrievalStd(),
    ]);

    res.json({ corpus, barrido, proveedores, tokens, mantenimiento, evaluacion });
  } catch (error) {
    manejar(res, error, 'Error al obtener el estado del RAG del STD');
  }
}

export async function getDocumentos(req: Request, res: Response) {
  const estado = typeof req.query.estado === 'string' ? req.query.estado : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const idDocumentoCrudo = typeof req.query.idDocumento === 'string' ? req.query.idDocumento.trim() : undefined;
  const jobId = req.query.jobId ? Number(req.query.jobId) : undefined;
  const pagina = req.query.pagina ? Number(req.query.pagina) : undefined;
  const porPagina = req.query.porPagina ? Number(req.query.porPagina) : undefined;

  if (idDocumentoCrudo && !RE_ID_DOCUMENTO.test(idDocumentoCrudo)) {
    return res.status(400).json({ message: 'N° STD inválido' });
  }
  if (jobId !== undefined && (!Number.isInteger(jobId) || jobId < 1)) {
    return res.status(400).json({ message: 'jobId inválido' });
  }
  if ((pagina !== undefined && (!Number.isInteger(pagina) || pagina < 1))
    || (porPagina !== undefined && (!Number.isInteger(porPagina) || porPagina < 1))) {
    return res.status(400).json({ message: '"pagina" y "porPagina" deben ser enteros mayores o iguales a 1' });
  }

  try {
    res.json(await listarDocumentosStd({
      estado, q,
      idDocumento: idDocumentoCrudo ? Number(idDocumentoCrudo) : undefined,
      jobId,
      pagina, porPagina,
    }));
  } catch (error) {
    if (error instanceof RangeError) return res.status(400).json({ message: error.message });
    manejar(res, error, 'Error al listar los documentos del STD');
  }
}

export async function getMarkdownDocumento(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ message: 'Id de documento inválido' });
  }

  try {
    const resultado = await markdownDocumentoStd(id);
    if (!resultado) {
      return res.status(404).json({ message: 'Este documento todavía no tiene markdown convertido' });
    }
    res.json(resultado);
  } catch (error) {
    manejar(res, error, 'Error al obtener el markdown del documento STD');
  }
}

export async function postReintentarDocumento(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ message: 'Id de documento inválido' });
  }

  try {
    const resultado = await repararDocumentoStd(id);
    res.status(resultado.enCurso ? 202 : 200).json(resultado);
  } catch (error) {
    manejar(res, error, `Error al reintentar el documento STD ${id}`);
  }
}

/**
 * Último recurso manual: extrae el texto con IA de visión. Solo sobre "sin texto", "con error" o
 * "sin archivo" — `visionStdService` rechaza cualquier otro caso con un 409 explicando por qué.
 */
export async function postExtraerVision(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ message: 'Id de documento inválido' });
  }

  try {
    const documento = await transcribirDocumentoStd(id);
    res.json({ documento });
  } catch (error) {
    manejar(res, error, `Error al extraer con IA el documento STD ${id}`);
  }
}

export async function postRetencion(_req: Request, res: Response) {
  try {
    res.json(await ejecutarRetencionStd());
  } catch (error) {
    manejar(res, error, 'Error al ejecutar la retención del STD');
  }
}

export async function postGC(_req: Request, res: Response) {
  try {
    res.json(await ejecutarGCStd());
  } catch (error) {
    manejar(res, error, 'Error al ejecutar el recolector de basura del STD');
  }
}

export async function getDocumentosStdCobertura(req: Request, res: Response) {
  const limite = Number(req.query.limite ?? 50);
  try {
    res.json(await coberturaPorDocumentoStd(Number.isFinite(limite) ? limite : 50));
  } catch (error) {
    manejar(res, error, 'Error al obtener la cobertura por documento del STD');
  }
}

/** Barrido manual. Funciona aunque el interruptor esté apagado — mismo criterio que el SGD. */
export async function postBarrer(_req: Request, res: Response) {
  try {
    res.json(await barrerStd('manual'));
  } catch (error) {
    manejar(res, error, 'Error al ejecutar el barrido del STD');
  }
}

const CLAVES_EDITABLES = new Set([
  'rag.barrido.activo',
  'rag.barrido.cadencia_min',
  'rag.ingesta.activa',
  'rag.retencion.activa',
  'rag.retencion.dias',
  'rag.gc.activo',
  'rag.gc.gracia_dias',
]);

export async function getConfig(_req: Request, res: Response) {
  try {
    res.json(await listarConfig(stdRagSequelize));
  } catch (error) {
    manejar(res, error, 'Error al leer la configuración del STD');
  }
}

export async function putConfig(req: Request, res: Response) {
  const { clave } = req.params;
  const valor = req.body?.valor;

  if (!CLAVES_EDITABLES.has(clave)) {
    return res.status(400).json({ message: `La clave "${clave}" no es editable desde aquí` });
  }
  if (typeof valor !== 'string' && typeof valor !== 'boolean' && typeof valor !== 'number') {
    return res.status(400).json({ message: 'Se espera "valor"' });
  }

  try {
    await escribirConfig(clave, String(valor), req.usuario!.codUser, stdRagSequelize);
    res.json({ ok: true });
  } catch (error) {
    manejar(res, error, `Error al guardar ${clave}`);
  }
}

// ── Ingesta ───────────────────────────────────────────────────────────────

export async function postIngestaConversion(req: Request, res: Response) {
  try {
    const { jobId } = await iniciarJobConversionStd(filtroDeBodyStd(req.body), req.usuario!.codUser);
    res.status(202).json({ jobId });
  } catch (error) {
    manejar(res, error, 'Error al iniciar la ingesta de conversión del STD');
  }
}

/**
 * Reintenta TODOS los "sin archivo", incluidos los que agotaron sus intentos (típicamente marcados
 * mientras `uploads/` estaba desmontado). Rechaza con 409 si sigue desmontado.
 */
export async function postIngestaReintentoSinArchivo(req: Request, res: Response) {
  try {
    const resultado = await iniciarJobReintentoSinArchivoStd(req.usuario!.codUser);
    res.status(202).json(resultado);
  } catch (error) {
    manejar(res, error, 'Error al reintentar los documentos sin archivo del STD');
  }
}

export async function postIngestaEmbedding(req: Request, res: Response) {
  try {
    const { jobId } = await iniciarJobEmbeddingStd(filtroDeBodyStd(req.body), req.usuario!.codUser);
    res.status(202).json({ jobId });
  } catch (error) {
    manejar(res, error, 'Error al iniciar la ingesta de embeddings del STD');
  }
}

function idDeJob(req: Request, res: Response): number | null {
  const id = Number(req.params.jobId);
  if (!Number.isInteger(id)) {
    res.status(400).json({ message: 'jobId inválido' });
    return null;
  }
  return id;
}

export async function postPausarJob(req: Request, res: Response) {
  const id = idDeJob(req, res);
  if (id === null) return;
  try {
    await pausarJobStd(id);
    res.json(await estadoJobStd(id));
  } catch (error) {
    manejar(res, error, `Error al pausar el job ${id}`);
  }
}

export async function postReanudarJob(req: Request, res: Response) {
  const id = idDeJob(req, res);
  if (id === null) return;
  try {
    await reanudarJobStd(id);
    res.json(await estadoJobStd(id));
  } catch (error) {
    manejar(res, error, `Error al reanudar el job ${id}`);
  }
}

export async function postCancelarJob(req: Request, res: Response) {
  const id = idDeJob(req, res);
  if (id === null) return;
  try {
    await cancelarJobStd(id);
    res.json(await estadoJobStd(id));
  } catch (error) {
    manejar(res, error, `Error al detener el job ${id}`);
  }
}

export async function getJob(req: Request, res: Response) {
  const id = Number(req.params.jobId);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'jobId inválido' });

  try {
    res.json(await estadoJobStd(id));
  } catch (error) {
    manejar(res, error, `Error al consultar el job ${id}`);
  }
}

export async function getJobs(req: Request, res: Response) {
  const limite = Number(req.query.limite ?? 20);
  try {
    res.json(await listarJobsStd(Number.isFinite(limite) ? limite : 20));
  } catch (error) {
    manejar(res, error, 'Error al listar los trabajos de ingesta del STD');
  }
}

// ── Modelos de embedding ─────────────────────────────────────────────────
//
// Mismo proveedor configurado en `.env` que el SGD (`EMBEDDING_PROVIDER`), pero registrado y
// activado como un modelo INDEPENDIENTE en `std_rag`: las tablas `rag.embedding_model` de las dos
// bases nunca se leen entre sí, así que activar el modelo en una no activa nada en la otra.

export async function getModelos(_req: Request, res: Response) {
  try {
    res.json(await listarModelos(stdRagSequelize));
  } catch (error) {
    manejar(res, error, 'Error al listar los modelos de embedding del STD');
  }
}

export async function postModeloRegistrar(_req: Request, res: Response) {
  try {
    res.json(await registrarSiNoExiste(crearEmbeddingProvider(), stdRagSequelize));
  } catch (error) {
    manejar(res, error, 'Error al registrar el modelo de embedding del STD');
  }
}

export async function putModeloActivar(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'id inválido' });

  try {
    await activarModelo(id, req.usuario!.codUser, crearEmbeddingProvider(), stdRagSequelize);
    res.json({ ok: true });
  } catch (error) {
    manejar(res, error, `Error al activar el modelo ${id}`);
  }
}
