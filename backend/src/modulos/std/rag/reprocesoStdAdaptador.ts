import { stdRagSequelize } from '../config/stdRagDatabase';
import type { AdaptadorReproceso } from '../../../compartido/rag/reprocesoService';
import { ArchivoStdError } from '../services/stdStorageService';
import {
  filaDeDocumento,
  guardarMarkdown,
  IngestaStdError,
  obtenerBytesDocumentoStd,
  type FilaDocumentoStd,
} from './ingestaStdService';

/** El STD frente al reproceso con visión (`compartido/rag/reprocesoService.ts`). */
export const adaptadorReprocesoStd: AdaptadorReproceso<FilaDocumentoStd> = {
  modulo: 'std',
  sequelize: stdRagSequelize,
  leer: filaDeDocumento,
  async archivo(doc) {
    try {
      const { buffer, filename } = await obtenerBytesDocumentoStd(doc);
      return { buffer, filename, mime: doc.mime };
    } catch (error) {
      if (error instanceof ArchivoStdError) {
        throw new IngestaStdError(
          error.status === 404
            ? 'Este documento no tiene archivo en el repositorio del STD; no hay nada que reprocesar.'
            : `No se puede leer el archivo: ${error.message}`,
          409,
        );
      }
      throw error;
    }
  },
  guardar: (doc, sha256, markdown, origen) => guardarMarkdown(doc, sha256, markdown, origen),
  error: (mensaje, status) => new IngestaStdError(mensaje, status),
};
