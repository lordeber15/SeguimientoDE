import { appSequelize } from '../../../compartido/config/appDatabase';
import type { AdaptadorReproceso } from '../../../compartido/rag/reprocesoService';
import { ArchivoError, mimePorNombre } from '../services/storageService';
import {
  filaDeDocumento,
  guardarMarkdown,
  IngestaError,
  obtenerBytesDocumento,
  type FilaDocumento,
} from './ingestaService';

/** El SGD frente al reproceso con visión (`compartido/rag/reprocesoService.ts`). */
export const adaptadorReprocesoSgd: AdaptadorReproceso<FilaDocumento> = {
  modulo: 'sgd',
  sequelize: appSequelize,
  leer: filaDeDocumento,
  async archivo(doc) {
    try {
      const { buffer, filename } = await obtenerBytesDocumento(doc);
      return { buffer, filename, mime: mimePorNombre(filename) };
    } catch (error) {
      if (error instanceof ArchivoError) {
        throw new IngestaError('Este documento no tiene archivo digital; no hay nada que reprocesar.', 409);
      }
      throw error;
    }
  },
  guardar: (doc, sha256, markdown, origen) => guardarMarkdown(doc, sha256, markdown, origen),
  error: (mensaje, status) => new IngestaError(mensaje, status),
};
