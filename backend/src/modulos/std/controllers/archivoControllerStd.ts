import type { Request, Response } from 'express';
import { documentoPorIdAdjunto } from '../rag/retrievalStdService';
import { leerClaveAdjuntoStd } from '../services/stdDocumentoService';
import { ArchivoStdError, leerArchivoStd, limpiarMime } from '../services/stdStorageService';

/**
 * Visor del archivo citado en el chat STD — GET /api/std/adjuntos/:idAdjunto/archivo.
 *
 * Solo sirve adjuntos que ya pasan por `rag.documento` (ver `documentoPorIdAdjunto`): es el
 * conjunto que el barrido ya descubrió y filtró a PDF (ver `FILTRO_PDF` en
 * `stdDocumentoService.ts`), no un proxy genérico sobre las 357 mil filas de `tbl_adjunto` del
 * STD. La clave física (`tbl_adjunto.adjunto`, 40 hex) NUNCA se guarda en `std_rag` — se resuelve
 * en vivo contra el STD (solo lectura) en cada petición, ver la migración `001_std_rag.sql`.
 */

function cabeceraDisposicion(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function manejarError(res: Response, error: unknown, contexto: string) {
  if (error instanceof ArchivoStdError) {
    return res.status(error.status).json({ message: error.message });
  }
  console.error(`${contexto}:`, error);
  return res.status(500).json({ message: 'Error al procesar la operación' });
}

export async function getArchivoAdjunto(req: Request, res: Response) {
  const idAdjunto = Number(req.params.idAdjunto);
  if (!Number.isInteger(idAdjunto) || idAdjunto <= 0) {
    return res.status(400).json({ message: 'idAdjunto inválido' });
  }

  try {
    const documento = await documentoPorIdAdjunto(idAdjunto);
    if (!documento) {
      return res.status(404).json({ message: 'Ese adjunto no forma parte del corpus indexado del STD' });
    }

    const clave = await leerClaveAdjuntoStd(idAdjunto);
    if (!clave) {
      return res.status(404).json({ message: 'El adjunto ya no existe en el STD' });
    }

    const { buffer } = leerArchivoStd(clave.adjunto, clave.hash);
    const filename = documento.nombreArchivo ?? `adjunto_${idAdjunto}.pdf`;

    res.setHeader('Content-Type', limpiarMime(documento.mime));
    res.setHeader('Content-Disposition', cabeceraDisposicion(filename));
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (error) {
    manejarError(res, error, `Error al leer el adjunto STD ${idAdjunto}`);
  }
}
