import type { Request, Response } from 'express';
import { buscarDocumentosStd } from '../rag/retrievalStdService';

const LARGO_MIN_BUSQUEDA = 3; // mismo umbral que seguimientoController.ts/chatController.ts del SGD

/**
 * Autocompletado de documentos del STD para el chat — ver `buscarDocumentosStd`: solo documentos
 * que el barrido ya descubrió (tienen al menos un PDF), no todo `tbl_documento`.
 */
export async function getBuscarDocumentos(req: Request, res: Response) {
  const termino = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  if (termino.length < LARGO_MIN_BUSQUEDA) {
    return res.status(400).json({
      message: `Escriba al menos ${LARGO_MIN_BUSQUEDA} caracteres del número o del documento`,
    });
  }

  try {
    res.json(await buscarDocumentosStd(termino));
  } catch (error) {
    console.error(`Error al buscar el documento STD "${termino}":`, error);
    res.status(500).json({ message: 'Error al procesar la operación' });
  }
}
