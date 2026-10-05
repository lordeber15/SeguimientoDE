import type { Request, Response } from 'express';
import {
  ChatStdError,
  listarSesionesStd,
  obtenerHistorialSesionStd,
  paginaResultadosStd,
  responderChatStd,
  sesionParaDocumentoStd,
  textoChunkCitadoStd,
} from '../rag/chatStdService';
import { estadoIngestaDocumentoStd, estadoIngestaDocumentosStd } from '../rag/retrievalStdService';

/** `tbl_documento.id_documento` es `int unsigned`: hasta 10 dígitos, nunca negativo. */
const RE_ID_DOCUMENTO = /^\d{1,10}$/;
const MAX_IDS_ESTADO = 100;
/** 1 000 páginas de 10 = el tope de candidatos guardados por listado (`chat.max_candidatos`). */
const MAX_PAGINA = 1000;

function manejar(res: Response, error: unknown, contexto: string) {
  if (error instanceof ChatStdError) {
    return res.status(error.status).json({ message: error.message });
  }
  console.error(`${contexto}:`, error);
  return res.status(500).json({ message: 'Error al procesar la operación' });
}

function mensajeValido(req: Request): string | null {
  const mensaje = req.body?.mensaje;
  return typeof mensaje === 'string' && mensaje.trim() ? mensaje : null;
}

export async function postChatGeneral(req: Request, res: Response) {
  const mensaje = mensajeValido(req);
  if (!mensaje) return res.status(400).json({ message: 'Se requiere "mensaje"' });

  try {
    const respuesta = await responderChatStd({
      usuarioId: req.usuario!.codUser,
      modo: 'general',
      mensaje,
      sesionId: Number.isInteger(req.body?.sesionId) ? req.body.sesionId : undefined,
    });
    res.json(respuesta);
  } catch (error) {
    manejar(res, error, 'Error en el chat general del STD');
  }
}

export async function postChatDocumento(req: Request, res: Response) {
  const { idDocumento } = req.params;
  if (!RE_ID_DOCUMENTO.test(idDocumento)) {
    return res.status(400).json({ message: 'N° STD inválido' });
  }

  const mensaje = mensajeValido(req);
  if (!mensaje) return res.status(400).json({ message: 'Se requiere "mensaje"' });

  try {
    const respuesta = await responderChatStd({
      usuarioId: req.usuario!.codUser,
      modo: 'documento',
      mensaje,
      sesionId: Number.isInteger(req.body?.sesionId) ? req.body.sesionId : undefined,
      idDocumento: Number(idDocumento),
    });
    res.json(respuesta);
  } catch (error) {
    manejar(res, error, `Error en el chat del documento STD ${idDocumento}`);
  }
}

export async function getSesionDocumento(req: Request, res: Response) {
  const { idDocumento } = req.params;
  if (!RE_ID_DOCUMENTO.test(idDocumento)) {
    return res.status(400).json({ message: 'N° STD inválido' });
  }

  try {
    const sesion = await sesionParaDocumentoStd(req.usuario!.codUser, Number(idDocumento));
    res.json(sesion);
  } catch (error) {
    manejar(res, error, `Error al buscar la sesión del documento STD ${idDocumento}`);
  }
}

export async function getEstadoIngestaDocumento(req: Request, res: Response) {
  const { idDocumento } = req.params;
  if (!RE_ID_DOCUMENTO.test(idDocumento)) {
    return res.status(400).json({ message: 'N° STD inválido' });
  }

  try {
    const estado = await estadoIngestaDocumentoStd(Number(idDocumento));
    res.json(estado);
  } catch (error) {
    manejar(res, error, `Error al obtener el estado de ingesta del documento STD ${idDocumento}`);
  }
}

/** Mismo patrón que `getEstadoIngestaExpedientes` del SGD: badges de una tabla, en una sola llamada. */
export async function getEstadoIngestaDocumentos(req: Request, res: Response) {
  const crudo = typeof req.query.ids === 'string' ? req.query.ids : '';
  const entradas = crudo.split(',').map((s) => s.trim()).filter(Boolean);

  if (entradas.length === 0) {
    return res.status(400).json({ message: 'Se requiere "ids" (N° STD separados por coma)' });
  }
  if (entradas.length > MAX_IDS_ESTADO) {
    return res.status(400).json({ message: `Como máximo ${MAX_IDS_ESTADO} ids por llamada` });
  }

  const ids = entradas.filter((id) => RE_ID_DOCUMENTO.test(id)).map(Number);

  try {
    res.json(await estadoIngestaDocumentosStd(ids));
  } catch (error) {
    manejar(res, error, 'Error al obtener el estado de ingesta de los documentos STD');
  }
}

export async function getSesiones(req: Request, res: Response) {
  try {
    res.json(await listarSesionesStd(req.usuario!.codUser));
  } catch (error) {
    manejar(res, error, 'Error al listar las sesiones de chat del STD');
  }
}

export async function getSesion(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'id inválido' });

  try {
    res.json(await obtenerHistorialSesionStd(id, req.usuario!.codUser));
  } catch (error) {
    manejar(res, error, `Error al obtener la sesión de chat del STD ${id}`);
  }
}

export async function getChunkCitado(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'id inválido' });

  try {
    res.json({ texto: await textoChunkCitadoStd(id, req.usuario!.codUser) });
  } catch (error) {
    manejar(res, error, `Error al obtener el fragmento citado ${id}`);
  }
}

/** "Ver más" de una respuesta tabla: `GET /api/std/chat/mensajes/:id/resultados?pagina=n`. */
export async function getResultadosMensaje(req: Request, res: Response) {
  const id = Number(req.params.id);
  const pagina = Number(req.query.pagina ?? 1);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'id inválido' });
  if (!Number.isInteger(pagina) || pagina < 1 || pagina > MAX_PAGINA) {
    return res.status(400).json({ message: 'pagina inválida' });
  }

  try {
    res.json(await paginaResultadosStd(id, pagina, req.usuario!.codUser));
  } catch (error) {
    manejar(res, error, `Error al obtener los resultados del mensaje ${id} del STD`);
  }
}
