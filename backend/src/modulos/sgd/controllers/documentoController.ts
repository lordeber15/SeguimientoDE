import type { Request, Response } from 'express';
import { esGenerable, generarDocumentoPdf } from '../services/documentoGeneradoService';
import {
  getAnexos,
  getArchivoAnexo,
  getArchivoDoc,
  getDatosDocumentoGenerado,
  getInteraccionesExpediente,
  getInteraccionesUsuario,
} from '../services/documentoService';
import {
  ArchivoError,
  estadoAlmacenamiento,
  mimePorNombre,
  resolverAnexo,
  resolverDocumento,
  type ArchivoResuelto,
} from '../services/storageService';

const RE_ANN = /^\d{4}$/;
const RE_EMI = /^\d{1,10}$/;
const RE_CODIGO = /^\d{1,5}$/;
const RE_SEC_EXP = /^\d{1,10}$/;

/**
 * Los nombres del SGD traen espacios, tildes, `°`, `$` y `!`. `filename*` (RFC 5987) transporta
 * el nombre real; `filename` queda como respaldo ASCII para clientes viejos.
 */
function cabeceraDisposicion(filename: string, mime: string): string {
  const tipo = mime === 'application/pdf' || mime.startsWith('image/') ? 'inline' : 'attachment';
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  return `${tipo}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function enviarArchivo(res: Response, archivo: ArchivoResuelto) {
  const mime = mimePorNombre(archivo.filename);

  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', cabeceraDisposicion(archivo.filename, mime));
  res.setHeader('Content-Length', archivo.buffer.length);
  // De dónde salió el archivo: útil para diagnosticar sin abrir la BD.
  res.setHeader('X-Origen-Archivo', archivo.origen);
  res.send(archivo.buffer);
}

function manejarError(res: Response, error: unknown, contexto: string) {
  if (error instanceof ArchivoError) {
    // 404 es normal: solo 47 de las 31.404 emisiones están en el disco de esta máquina, y 7.317
    // remitos no tienen archivo alguno. No es un fallo del sistema, así que no ensucia el log.
    if (error.status !== 404) console.error(`${contexto}:`, error.message);
    return res.status(error.status).json({ message: error.message });
  }

  console.error(`${contexto}:`, error);
  return res.status(500).json({ message: 'Error al obtener el archivo' });
}

/**
 * PROVEÍDOS (232) y HOJAS DE ENVÍO (304) no tienen archivo: el SGD los renderiza on-demand con
 * JasperReports. `unirPdfService` ya los dibuja para que el PDF unificado no tenga huecos; sin
 * esto, el visor devolvía 404 sobre un documento que sí existe — el 82 % de los documentos sin
 * archivo son de estos dos tipos.
 */
async function generarSiCorresponde(nuAnn: string, nuEmi: string): Promise<ArchivoResuelto | null> {
  const datos = await getDatosDocumentoGenerado(nuAnn, nuEmi);
  if (!datos || !esGenerable(datos.coTipDoc)) return null;

  const nombre = [datos.tipoDocumento, datos.numeroDocumento].filter(Boolean).join(' ');
  return {
    buffer: await generarDocumentoPdf(datos),
    filename: `${nombre || `documento_${nuAnn}_${nuEmi}`}.pdf`,
    origen: 'generado',
  };
}

export async function getDocumento(req: Request, res: Response) {
  const { nuAnn, nuEmi } = req.params;

  if (!RE_ANN.test(nuAnn) || !RE_EMI.test(nuEmi)) {
    return res.status(400).json({ message: 'Año o número de emisión inválido' });
  }

  try {
    const fila = await getArchivoDoc(nuAnn, nuEmi);
    enviarArchivo(res, resolverDocumento(nuAnn, nuEmi, fila));
  } catch (error) {
    // Solo se intenta dibujar cuando de verdad no hay archivo, para no añadir una consulta extra
    // al camino normal.
    if (error instanceof ArchivoError && error.status === 404) {
      try {
        const generado = await generarSiCorresponde(nuAnn, nuEmi);
        if (generado) return enviarArchivo(res, generado);
      } catch (errorGeneracion) {
        // Si el dibujo falla, vale más el 404 original: el archivo sigue sin existir.
        console.error(`Error al generar el documento ${nuAnn}/${nuEmi}:`, errorGeneracion);
      }
    }
    manejarError(res, error, `Error al obtener el documento ${nuAnn}/${nuEmi}`);
  }
}

export async function getListaAnexos(req: Request, res: Response) {
  const { nuAnn, nuEmi } = req.params;

  if (!RE_ANN.test(nuAnn) || !RE_EMI.test(nuEmi)) {
    return res.status(400).json({ message: 'Año o número de emisión inválido' });
  }

  try {
    res.json(await getAnexos(nuAnn, nuEmi));
  } catch (error) {
    console.error(`Error al listar anexos de ${nuAnn}/${nuEmi}:`, error);
    res.status(500).json({ message: 'Error al listar los anexos' });
  }
}

export async function getAnexo(req: Request, res: Response) {
  const { nuAnn, nuEmi, nuAne } = req.params;

  if (!RE_ANN.test(nuAnn) || !RE_EMI.test(nuEmi) || !/^\d{1,4}$/.test(nuAne)) {
    return res.status(400).json({ message: 'Año, número de emisión o número de anexo inválido' });
  }

  try {
    const fila = await getArchivoAnexo(nuAnn, nuEmi, Number(nuAne));

    if (!fila) {
      return res.status(404).json({ message: 'El anexo no existe para ese documento' });
    }

    enviarArchivo(res, resolverAnexo(nuAnn, nuEmi, nuAne, fila));
  } catch (error) {
    manejarError(res, error, `Error al obtener el anexo ${nuAnn}/${nuEmi}/${nuAne}`);
  }
}

export async function getInteracciones(req: Request, res: Response) {
  const { nuAnnExp, nuSecExp } = req.params;
  const dependencia = typeof req.query.dependencia === 'string' ? req.query.dependencia.trim() : '';
  const usuario = typeof req.query.usuario === 'string' ? req.query.usuario.trim() : '';

  if (!RE_ANN.test(nuAnnExp) || !RE_SEC_EXP.test(nuSecExp)) {
    return res.status(400).json({ message: 'Año o secuencia de expediente inválido' });
  }

  if (!RE_CODIGO.test(dependencia) || !RE_CODIGO.test(usuario)) {
    return res
      .status(400)
      .json({ message: 'Se requieren los parámetros "dependencia" y "usuario" (códigos numéricos)' });
  }

  try {
    const items = await getInteraccionesUsuario(
      nuAnnExp,
      nuSecExp.padStart(10, '0'),
      dependencia.padStart(5, '0'),
      usuario.padStart(5, '0'),
    );
    res.json({ total: items.length, items });
  } catch (error) {
    console.error(`Error al obtener interacciones de ${nuAnnExp}/${nuSecExp}:`, error);
    res.status(500).json({ message: 'Error al obtener las interacciones del expediente' });
  }
}

/** Igual que `getInteracciones`, pero sin acotar a un participante: trae el expediente entero. */
export async function getInteraccionesCompletas(req: Request, res: Response) {
  const { nuAnnExp, nuSecExp } = req.params;

  if (!RE_ANN.test(nuAnnExp) || !RE_SEC_EXP.test(nuSecExp)) {
    return res.status(400).json({ message: 'Año o secuencia de expediente inválido' });
  }

  try {
    const items = await getInteraccionesExpediente(nuAnnExp, nuSecExp.padStart(10, '0'));
    res.json({ total: items.length, items });
  } catch (error) {
    console.error(`Error al obtener el expediente completo ${nuAnnExp}/${nuSecExp}:`, error);
    res.status(500).json({ message: 'Error al obtener el expediente completo' });
  }
}

/**
 * Diagnóstico: si el volumen de documentos no está montado, todas las descargas devuelven 404 y
 * desde fuera no hay forma de distinguirlo de "este documento no tiene archivo".
 */
export function getEstadoAlmacenamiento(_req: Request, res: Response) {
  res.json(estadoAlmacenamiento());
}
