import type { Request, Response } from 'express';
import {
  ChatError,
  listarSesiones,
  obtenerHistorialSesion,
  responderChat,
  sesionParaExpediente,
  textoChunkCitado,
} from '../rag/chatService';
import {
  buscarExpedientes,
  estadoIngestaExpediente,
  estadoIngestaExpedientes,
} from '../rag/retrievalService';

const RE_ANN = /^\d{4}$/;
const RE_SEC_EXP = /^\d{1,10}$/;
const MAX_PARES_ESTADO = 100;

/** "2026-325", "2026/62", "2026 0000000325" → par literal. Ver `getBuscarExpedientes`. */
const RE_PAR_EXPEDIENTE = /^(\d{4})\s*[-/ ]\s*(\d{1,10})$/;
const LARGO_MIN_BUSQUEDA = 3; // mismo umbral que seguimientoController.ts

function manejar(res: Response, error: unknown, contexto: string) {
  if (error instanceof ChatError) {
    return res.status(error.status).json({ message: error.message });
  }
  console.error(`${contexto}:`, error);
  return res.status(500).json({ message: 'Error al procesar la operación' });
}

/**
 * `jefe` ve todas las dependencias por definición de rol (migración 001); `admin` también.
 * Cualquier otro rol con `rag.consultar` queda acotado a `co_dependencia` del usuario logueado
 * — es el filtro que PLAN-RAG.md §9 marca como el mayor riesgo de seguridad del sistema.
 */
function sinRestriccionDependencia(req: Request): boolean {
  return req.usuario!.roles.includes('admin') || req.usuario!.roles.includes('jefe');
}

function mensajeValido(req: Request): string | null {
  const mensaje = req.body?.mensaje;
  return typeof mensaje === 'string' && mensaje.trim() ? mensaje : null;
}

export async function postChatGeneral(req: Request, res: Response) {
  const mensaje = mensajeValido(req);
  if (!mensaje) return res.status(400).json({ message: 'Se requiere "mensaje"' });

  try {
    const respuesta = await responderChat({
      usuarioId: req.usuario!.codUser,
      sinRestriccionDependencia: sinRestriccionDependencia(req),
      coDependencia: req.usuario!.coDependencia,
      modo: 'general',
      mensaje,
      sesionId: Number.isInteger(req.body?.sesionId) ? req.body.sesionId : undefined,
    });
    res.json(respuesta);
  } catch (error) {
    manejar(res, error, 'Error en el chat general');
  }
}

export async function postChatExpediente(req: Request, res: Response) {
  const { nuAnnExp, nuSecExp } = req.params;
  if (!RE_ANN.test(nuAnnExp) || !RE_SEC_EXP.test(nuSecExp)) {
    return res.status(400).json({ message: 'Año o secuencia de expediente inválido' });
  }

  const mensaje = mensajeValido(req);
  if (!mensaje) return res.status(400).json({ message: 'Se requiere "mensaje"' });

  try {
    const respuesta = await responderChat({
      usuarioId: req.usuario!.codUser,
      sinRestriccionDependencia: sinRestriccionDependencia(req),
      coDependencia: req.usuario!.coDependencia,
      modo: 'expediente',
      mensaje,
      sesionId: Number.isInteger(req.body?.sesionId) ? req.body.sesionId : undefined,
      expediente: { nuAnnExp, nuSecExp: nuSecExp.padStart(10, '0') },
    });
    res.json(respuesta);
  } catch (error) {
    manejar(res, error, `Error en el chat del expediente ${nuAnnExp}/${nuSecExp}`);
  }
}

export async function getSesionExpediente(req: Request, res: Response) {
  const { nuAnnExp, nuSecExp } = req.params;
  if (!RE_ANN.test(nuAnnExp) || !RE_SEC_EXP.test(nuSecExp)) {
    return res.status(400).json({ message: 'Año o secuencia de expediente inválido' });
  }

  try {
    const sesion = await sesionParaExpediente(
      req.usuario!.codUser,
      nuAnnExp,
      nuSecExp.padStart(10, '0'),
    );
    res.json(sesion);
  } catch (error) {
    manejar(res, error, `Error al buscar la sesión del expediente ${nuAnnExp}/${nuSecExp}`);
  }
}

export async function getEstadoIngestaExpediente(req: Request, res: Response) {
  const { nuAnnExp, nuSecExp } = req.params;
  if (!RE_ANN.test(nuAnnExp) || !RE_SEC_EXP.test(nuSecExp)) {
    return res.status(400).json({ message: 'Año o secuencia de expediente inválido' });
  }

  try {
    const estado = await estadoIngestaExpediente(nuAnnExp, nuSecExp.padStart(10, '0'));
    res.json(estado);
  } catch (error) {
    manejar(res, error, `Error al obtener el estado de ingesta del expediente ${nuAnnExp}/${nuSecExp}`);
  }
}

/**
 * Estado de ingesta de un lote de expedientes, para pintar el badge de la tabla de Seguimiento sin
 * hacer una llamada por fila. `pares` viaja como `año:secuencia,año:secuencia,...` en query string
 * (lectura pura, sin efectos — cabe cómoda en una URL incluso con 100 pares).
 *
 * Un par mal formado se descarta en silencio, no tumba la petición entera: un dato raro no debe
 * apagar el badge de las otras filas que sí vinieron bien.
 *
 * `nuSecExp` se espera YA en el formato de 10 dígitos con ceros a la izquierda (el mismo que trae
 * `ExpedienteSeguimiento.nuSecExp` y el que guarda `rag.documento`, verificado 1:1) — a diferencia
 * de las rutas de un solo expediente, aquí no se paddea: la respuesta reetiqueta cada resultado con
 * el par tal cual se recibió, así que paddear rompería la correspondencia si el cliente mandara
 * algo distinto de 10 dígitos sin que nadie se diera cuenta.
 */
export async function getEstadoIngestaExpedientes(req: Request, res: Response) {
  const crudo = typeof req.query.pares === 'string' ? req.query.pares : '';
  const entradas = crudo.split(',').map((s) => s.trim()).filter(Boolean);

  if (entradas.length === 0) {
    return res.status(400).json({ message: 'Se requiere "pares" (año:secuencia,año:secuencia,...)' });
  }
  if (entradas.length > MAX_PARES_ESTADO) {
    return res.status(400).json({ message: `Como máximo ${MAX_PARES_ESTADO} pares por llamada` });
  }

  const pares: { nuAnnExp: string; nuSecExp: string }[] = [];
  for (const entrada of entradas) {
    const [nuAnnExp, nuSecExp] = entrada.split(':');
    if (nuAnnExp && nuSecExp && RE_ANN.test(nuAnnExp) && RE_SEC_EXP.test(nuSecExp)) {
      pares.push({ nuAnnExp, nuSecExp });
    }
  }

  try {
    res.json(await estadoIngestaExpedientes(pares));
  } catch (error) {
    manejar(res, error, 'Error al obtener el estado de ingesta de los expedientes');
  }
}

/**
 * Busca el expediente por su número compuesto (`DE000020260000062`, `2026-0000325`) — el usuario ve
 * ese número en toda la aplicación, no la clave interna `(nu_ann_exp, nu_sec_exp)`, y el prefijo
 * varía de largo por dependencia, así que partirlo a mano no es posible.
 *
 * Si el término YA es un par año-secuencia se resuelve además como clave exacta: es el acceso
 * directo que daban las dos casillas de antes, y el único camino a un expediente que el barrido no
 * haya recorrido todavía.
 */
export async function getBuscarExpedientes(req: Request, res: Response) {
  const termino = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  if (termino.length < LARGO_MIN_BUSQUEDA) {
    return res.status(400).json({
      message: `Escriba al menos ${LARGO_MIN_BUSQUEDA} caracteres del número de expediente`,
    });
  }

  const par = RE_PAR_EXPEDIENTE.exec(termino);

  try {
    res.json(
      await buscarExpedientes(
        termino,
        // Mismo padding a 10 dígitos que el resto de rutas de expediente de este archivo.
        par ? { nuAnnExp: par[1], nuSecExp: par[2].padStart(10, '0') } : null,
      ),
    );
  } catch (error) {
    manejar(res, error, `Error al buscar el expediente "${termino}"`);
  }
}

export async function getSesiones(req: Request, res: Response) {
  try {
    res.json(await listarSesiones(req.usuario!.codUser));
  } catch (error) {
    manejar(res, error, 'Error al listar las sesiones de chat');
  }
}

export async function getSesion(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'id inválido' });

  try {
    res.json(await obtenerHistorialSesion(id, req.usuario!.codUser));
  } catch (error) {
    manejar(res, error, `Error al obtener la sesión de chat ${id}`);
  }
}

/**
 * Texto completo del fragmento citado — se pide solo cuando el usuario despliega la cita, que es
 * lo que permite que la respuesta y el historial viajen sin el markdown crudo de cada chunk.
 */
export async function getChunkCitado(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'id inválido' });

  try {
    res.json({ texto: await textoChunkCitado(id, req.usuario!.codUser) });
  } catch (error) {
    manejar(res, error, `Error al obtener el fragmento citado ${id}`);
  }
}
