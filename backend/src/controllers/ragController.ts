import type { Request, Response } from 'express';
import { crearEmbeddingProvider } from '../ai/providerFactory';
import { ErrorIA } from '../ai/types';
import { barrer, BarridoOcupado, esInventarioInicial } from '../rag/barridoService';
import { escribirConfig, listarConfig } from '../rag/configService';
import {
  activarModelo,
  listarModelos,
  ModeloError,
  registrarSiNoExiste,
} from '../rag/embeddingModelService';
import {
  coberturaPorExpediente,
  consumoTokens,
  estadoBarrido,
  estadoCorpus,
  estadoMantenimiento,
  estadoProveedores,
  evaluacionRetrieval,
  listarDocumentos,
  markdownDocumento,
} from '../rag/estadoService';
import {
  cancelarJob,
  estadoJob,
  type FiltroIngesta,
  IngestaError,
  iniciarJobConversion,
  iniciarJobEmbedding,
  iniciarJobReparacion,
  listarJobs,
  pausarJob,
  reanudarJob,
  repararDocumento,
} from '../rag/ingestaService';
import { ejecutarGC, ejecutarRetencion } from '../rag/mantenimientoService';
import { transcribirDocumento } from '../rag/visionService';

function manejar(res: Response, error: unknown, contexto: string) {
  if (error instanceof BarridoOcupado) {
    return res.status(409).json({ message: 'Ya hay un barrido en curso' });
  }
  if (error instanceof IngestaError || error instanceof ModeloError) {
    return res.status(error.status).json({ message: error.message });
  }
  // `provider.comprobar()` (dentro de `iniciarJobEmbedding`) puede lanzar esto si el proveedor de
  // IA está mal configurado o caído — sin este mapeo caía al 500 genérico de abajo, sin ninguna
  // pista del motivo real (que sí trae `ErrorIA.message`, sin credenciales).
  if (error instanceof ErrorIA) {
    return res.status(409).json({ message: error.message });
  }
  console.error(`${contexto}:`, error);
  return res.status(500).json({ message: 'Error al procesar la operación' });
}

const RE_ANN = /^\d{4}$/;
const RE_SEC_EXP = /^\d{1,10}$/;
/** Mismo tope que el `limite` por defecto de un job — una selección manual no necesita más. */
const MAX_IDS_POR_JOB = 500;

/**
 * Blindaje contra el peligro real de `ingestaService.ts`: su guarda es
 * `if (filtro.nuAnnExp && filtro.nuSecExp)` — si uno de los dos llega vacío o falta, el filtro se
 * desactiva ENTERO y el job procesa todo el corpus (hasta 500 documentos / 2000 chunks) en vez de
 * un expediente. "Ambos o ninguno" es la única regla que lo evita; el resto (formato, `limite`) es
 * higiene de API normal.
 */
function filtroDeBody(body: unknown): FiltroIngesta {
  const b = (body ?? {}) as Record<string, unknown>;
  const tieneAnn = b.nuAnnExp !== undefined && b.nuAnnExp !== null && b.nuAnnExp !== '';
  const tieneSec = b.nuSecExp !== undefined && b.nuSecExp !== null && b.nuSecExp !== '';

  if (tieneAnn !== tieneSec) {
    throw new IngestaError('Indique el año y la secuencia del expediente, o ninguno de los dos');
  }

  let nuAnnExp: string | undefined;
  let nuSecExp: string | undefined;
  if (tieneAnn && tieneSec) {
    const ann = String(b.nuAnnExp).trim();
    const sec = String(b.nuSecExp).trim();
    if (!RE_ANN.test(ann) || !RE_SEC_EXP.test(sec)) {
      throw new IngestaError('Año o secuencia de expediente inválido');
    }
    // Misma normalización que `chatController.ts` para que este filtro y el badge de estado nunca
    // diverjan — si divergieran, el job daría 404 "nada pendiente" sobre un expediente que se ve
    // a simple vista sin indexar.
    nuAnnExp = ann;
    nuSecExp = sec.padStart(10, '0');
  }

  let limite: number | undefined;
  if (b.limite !== undefined && b.limite !== null) {
    const n = Number(b.limite);
    if (!Number.isInteger(n) || n < 1) {
      throw new IngestaError('"limite" debe ser un entero mayor o igual a 1');
    }
    limite = n;
  }

  let documentoIds: number[] | undefined;
  if (b.documentoIds !== undefined && b.documentoIds !== null) {
    if (!Array.isArray(b.documentoIds) || b.documentoIds.length === 0) {
      throw new IngestaError('"documentoIds" debe ser un arreglo con al menos un id');
    }
    if (b.documentoIds.length > MAX_IDS_POR_JOB) {
      throw new IngestaError(`Como máximo ${MAX_IDS_POR_JOB} documentos por trabajo`);
    }
    documentoIds = b.documentoIds.map((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new IngestaError('"documentoIds" tiene un id inválido');
      return n;
    });
  }

  return { nuAnnExp, nuSecExp, documentoIds, limite };
}

/** Todo lo que pinta el panel, en una sola llamada. */
export async function getPanel(_req: Request, res: Response) {
  try {
    const [corpus, barrido, proveedores, tokens, mantenimiento, evaluacion] = await Promise.all([
      estadoCorpus(),
      estadoBarrido(),
      estadoProveedores(),
      consumoTokens(),
      estadoMantenimiento(),
      evaluacionRetrieval(),
    ]);

    res.json({
      corpus, barrido, proveedores, tokens, mantenimiento, evaluacion,
      inventarioInicial: await esInventarioInicial(),
    });
  } catch (error) {
    manejar(res, error, 'Error al obtener el estado del RAG');
  }
}

/** Documentos individuales, con filtros — el detalle detrás de los contadores de `getPanel`. */
export async function getDocumentos(req: Request, res: Response) {
  const estado = typeof req.query.estado === 'string' ? req.query.estado : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const nuAnnExp = typeof req.query.nuAnnExp === 'string' ? req.query.nuAnnExp.trim() : undefined;
  const nuSecExp = typeof req.query.nuSecExp === 'string' ? req.query.nuSecExp.trim() : undefined;
  const jobId = req.query.jobId ? Number(req.query.jobId) : undefined;
  const pagina = req.query.pagina ? Number(req.query.pagina) : undefined;
  const porPagina = req.query.porPagina ? Number(req.query.porPagina) : undefined;

  if ((nuAnnExp && !RE_ANN.test(nuAnnExp)) || (nuSecExp && !RE_SEC_EXP.test(nuSecExp))) {
    return res.status(400).json({ message: 'Año o secuencia de expediente inválido' });
  }
  if (jobId !== undefined && (!Number.isInteger(jobId) || jobId < 1)) {
    return res.status(400).json({ message: 'jobId inválido' });
  }
  if ((pagina !== undefined && (!Number.isInteger(pagina) || pagina < 1))
    || (porPagina !== undefined && (!Number.isInteger(porPagina) || porPagina < 1))) {
    return res.status(400).json({ message: '"pagina" y "porPagina" deben ser enteros mayores o iguales a 1' });
  }

  try {
    res.json(await listarDocumentos({
      estado, q,
      nuAnnExp: nuAnnExp || undefined,
      nuSecExp: nuSecExp ? nuSecExp.padStart(10, '0') : undefined,
      jobId,
      pagina, porPagina,
    }));
  } catch (error) {
    if (error instanceof RangeError) return res.status(400).json({ message: error.message });
    manejar(res, error, 'Error al listar los documentos');
  }
}

/** El markdown convertido de un documento puntual, para revisar por qué quedó vacío o con error. */
export async function getMarkdownDocumento(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ message: 'Id de documento inválido' });
  }

  try {
    const resultado = await markdownDocumento(id);
    if (!resultado) {
      return res.status(404).json({ message: 'Este documento todavía no tiene markdown convertido' });
    }
    res.json(resultado);
  } catch (error) {
    manejar(res, error, 'Error al obtener el markdown del documento');
  }
}

/**
 * Reintenta UN documento ahora mismo — no espera al próximo barrido ni encola un job. Devuelve
 * 202 cuando la conversión sigue corriendo tras el tiempo de espera (sigue en curso por su cuenta;
 * "Actualizar" en la lista mostrará el resultado cuando termine).
 */
export async function postReintentarDocumento(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ message: 'Id de documento inválido' });
  }

  try {
    const resultado = await repararDocumento(id);
    res.status(resultado.enCurso ? 202 : 200).json(resultado);
  } catch (error) {
    manejar(res, error, `Error al reintentar el documento ${id}`);
  }
}

/**
 * Último recurso manual: extrae el texto con IA de visión. Solo tiene sentido sobre documentos
 * "sin texto" o "con error" — `visionService` rechaza cualquier otro caso con un 409 explicando
 * por qué (incluida la clave que falte, o el techo diario de tokens).
 */
export async function postExtraerVision(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ message: 'Id de documento inválido' });
  }

  try {
    const documento = await transcribirDocumento(id);
    res.json({ documento });
  } catch (error) {
    manejar(res, error, `Error al extraer con IA el documento ${id}`);
  }
}

/** Dispara la retención manualmente. Funciona aunque el interruptor esté apagado — igual que
 * "Barrer ahora": el interruptor gobierna la automatización, no la capacidad. */
export async function postRetencion(_req: Request, res: Response) {
  try {
    res.json(await ejecutarRetencion());
  } catch (error) {
    manejar(res, error, 'Error al ejecutar la retención');
  }
}

/** Igual que arriba, para el recolector de basura de contenidos huérfanos. */
export async function postGC(_req: Request, res: Response) {
  try {
    res.json(await ejecutarGC());
  } catch (error) {
    manejar(res, error, 'Error al ejecutar el recolector de basura');
  }
}

export async function getExpedientes(req: Request, res: Response) {
  const limite = Number(req.query.limite ?? 50);
  try {
    res.json(await coberturaPorExpediente(Number.isFinite(limite) ? limite : 50));
  } catch (error) {
    manejar(res, error, 'Error al obtener la cobertura por expediente');
  }
}

/**
 * Barrido manual. Funciona **aunque el interruptor esté apagado**: el interruptor gobierna la
 * automatización, no la capacidad. Sin esto, "desactivado" sería un callejón sin salida.
 */
export async function postBarrer(_req: Request, res: Response) {
  try {
    const tipo = (await esInventarioInicial()) ? 'inventario_inicial' : 'watermark';
    res.json(await barrer(tipo, 'manual'));
  } catch (error) {
    manejar(res, error, 'Error al ejecutar el barrido');
  }
}

const CLAVES_EDITABLES = new Set([
  'rag.barrido.activo',
  'rag.barrido.cadencia_min',
  'rag.barrido.cadencia_hash_min',
  'rag.ingesta.activa',
  'rag.retencion.activa',
  'rag.retencion.dias',
  'rag.gc.activo',
  'rag.gc.gracia_dias',
]);

export async function getConfig(_req: Request, res: Response) {
  try {
    res.json(await listarConfig());
  } catch (error) {
    manejar(res, error, 'Error al leer la configuración');
  }
}

export async function putConfig(req: Request, res: Response) {
  const { clave } = req.params;
  const valor = req.body?.valor;

  // Lista blanca: `app.config` puede acabar guardando cosas que no debe tocar un formulario.
  if (!CLAVES_EDITABLES.has(clave)) {
    return res.status(400).json({ message: `La clave "${clave}" no es editable desde aquí` });
  }
  if (typeof valor !== 'string' && typeof valor !== 'boolean' && typeof valor !== 'number') {
    return res.status(400).json({ message: 'Se espera "valor"' });
  }

  try {
    await escribirConfig(clave, String(valor), req.usuario!.codUser);
    res.json({ ok: true });
  } catch (error) {
    manejar(res, error, `Error al guardar ${clave}`);
  }
}

// ── Ingesta ───────────────────────────────────────────────────────────────

/** Funciona hoy: markitdown no necesita API key. */
export async function postIngestaConversion(req: Request, res: Response) {
  try {
    const { jobId } = await iniciarJobConversion(filtroDeBody(req.body), req.usuario!.codUser);
    res.status(202).json({ jobId });
  } catch (error) {
    manejar(res, error, 'Error al iniciar la ingesta de conversión');
  }
}

/**
 * Reparación masiva de documentos "sin archivo" o "sin texto" — solo generación y markitdown,
 * nunca la extracción con IA de pago. Comparte el mismo blindaje de filtro que la conversión.
 */
export async function postIngestaReparacion(req: Request, res: Response) {
  try {
    const { jobId } = await iniciarJobReparacion(filtroDeBody(req.body), req.usuario!.codUser);
    res.status(202).json({ jobId });
  } catch (error) {
    manejar(res, error, 'Error al iniciar la reparación');
  }
}

/**
 * Bloqueado hasta que haya proveedor de embeddings configurado y activo. El código está completo
 * y probado con proveedores simulados: en cuanto haya credenciales, esto funciona sin tocar nada.
 */
export async function postIngestaEmbedding(req: Request, res: Response) {
  try {
    const { jobId } = await iniciarJobEmbedding(filtroDeBody(req.body), req.usuario!.codUser);
    res.status(202).json({ jobId });
  } catch (error) {
    manejar(res, error, 'Error al iniciar la ingesta de embeddings');
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

/** Pausa un job de conversión/reparación en curso — resumable con `postReanudarJob`. */
export async function postPausarJob(req: Request, res: Response) {
  const id = idDeJob(req, res);
  if (id === null) return;
  try {
    await pausarJob(id);
    res.json(await estadoJob(id));
  } catch (error) {
    manejar(res, error, `Error al pausar el job ${id}`);
  }
}

export async function postReanudarJob(req: Request, res: Response) {
  const id = idDeJob(req, res);
  if (id === null) return;
  try {
    await reanudarJob(id);
    res.json(await estadoJob(id));
  } catch (error) {
    manejar(res, error, `Error al reanudar el job ${id}`);
  }
}

/** Detiene definitivamente un job — a diferencia de pausar, no se puede reanudar después. */
export async function postCancelarJob(req: Request, res: Response) {
  const id = idDeJob(req, res);
  if (id === null) return;
  try {
    await cancelarJob(id);
    res.json(await estadoJob(id));
  } catch (error) {
    manejar(res, error, `Error al detener el job ${id}`);
  }
}

export async function getJob(req: Request, res: Response) {
  const id = Number(req.params.jobId);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'jobId inválido' });

  try {
    res.json(await estadoJob(id));
  } catch (error) {
    manejar(res, error, `Error al consultar el job ${id}`);
  }
}

export async function getJobs(req: Request, res: Response) {
  const limite = Number(req.query.limite ?? 20);
  try {
    res.json(await listarJobs(Number.isFinite(limite) ? limite : 20));
  } catch (error) {
    manejar(res, error, 'Error al listar los trabajos de ingesta');
  }
}

// ── Modelos de embedding ─────────────────────────────────────────────────

export async function getModelos(_req: Request, res: Response) {
  try {
    res.json(await listarModelos());
  } catch (error) {
    manejar(res, error, 'Error al listar los modelos de embedding');
  }
}

/** Registra el modelo configurado en el `.env` para que aparezca en la lista y se pueda activar. */
export async function postModeloRegistrar(_req: Request, res: Response) {
  try {
    res.json(await registrarSiNoExiste(crearEmbeddingProvider()));
  } catch (error) {
    manejar(res, error, 'Error al registrar el modelo de embedding');
  }
}

export async function putModeloActivar(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'id inválido' });

  try {
    await activarModelo(id, req.usuario!.codUser, crearEmbeddingProvider());
    res.json({ ok: true });
  } catch (error) {
    manejar(res, error, `Error al activar el modelo ${id}`);
  }
}
