import fs from 'fs';
import type { Request, Response } from 'express';
import {
  getDescarga,
  getEstado,
  iniciarJob,
  UnionError,
} from '../services/unirPdfService';

const RE_ANN = /^\d{4}$/;
const RE_SEC_EXP = /^\d{1,10}$/;
const RE_JOB = /^[0-9a-f-]{36}$/i;

function manejarError(res: Response, error: unknown, contexto: string) {
  if (error instanceof UnionError) {
    return res.status(error.status).json({ message: error.message });
  }

  console.error(`${contexto}:`, error);
  return res.status(500).json({ message: 'Error al generar el PDF unificado' });
}

/**
 * Arranca la unión y responde 202 con el `jobId`. El merge tarda minutos en un expediente grande:
 * una respuesta síncrona moriría por timeout del proxy o del navegador.
 */
export function postUnirPdf(req: Request, res: Response) {
  const { nuAnnExp, nuSecExp } = req.params;

  if (!RE_ANN.test(nuAnnExp) || !RE_SEC_EXP.test(nuSecExp)) {
    return res.status(400).json({ message: 'Año o secuencia de expediente inválido' });
  }

  // Por defecto se incluyen; se excluyen solo si el cliente lo pide explícitamente.
  const incluirAnexos = req.query.anexos !== 'no';

  try {
    const { jobId } = iniciarJob({
      nuAnnExp,
      nuSecExp: nuSecExp.padStart(10, '0'),
      incluirAnexos,
    });
    res.status(202).json({ jobId });
  } catch (error) {
    manejarError(res, error, `Error al iniciar la unión de ${nuAnnExp}/${nuSecExp}`);
  }
}

export function getEstadoUnion(req: Request, res: Response) {
  const { jobId } = req.params;

  if (!RE_JOB.test(jobId)) {
    return res.status(400).json({ message: 'Identificador de trabajo inválido' });
  }

  const estado = getEstado(jobId);
  if (!estado) {
    return res.status(404).json({ message: 'El trabajo no existe o ya caducó' });
  }

  res.json(estado);
}

export function getDescargaUnion(req: Request, res: Response) {
  const { jobId } = req.params;

  if (!RE_JOB.test(jobId)) {
    return res.status(400).json({ message: 'Identificador de trabajo inválido' });
  }

  try {
    const { filePath, filename } = getDescarga(jobId);
    const { size } = fs.statSync(filePath);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', size);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );

    // Streaming: un expediente unido puede pesar cientos de MB y `readFileSync` lo cargaría entero
    // en memoria justo cuando el proceso ya viene de fusionar todo eso.
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    manejarError(res, error, `Error al descargar la unión ${jobId}`);
  }
}
