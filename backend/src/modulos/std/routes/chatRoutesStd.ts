import { Router } from 'express';
import {
  getChunkCitado,
  getEstadoIngestaDocumento,
  getEstadoIngestaDocumentos,
  getResultadosMensaje,
  getSesion,
  getSesionDocumento,
  getSesiones,
  postChatDocumento,
  postChatGeneral,
  postReintentarMensajeStd,
} from '../controllers/chatControllerStd';
import { requiereAuth, requierePermiso } from '../../../compartido/middlewares/authMiddleware';

const router = Router();

router.use(requiereAuth, requierePermiso('std.consultar'));

router.post('/general', postChatGeneral);
router.post('/documento/:idDocumento', postChatDocumento);
router.get('/documentos/estado', getEstadoIngestaDocumentos);
router.get('/documento/:idDocumento/estado', getEstadoIngestaDocumento);
router.get('/sesiones/documento/:idDocumento', getSesionDocumento);
router.get('/sesiones', getSesiones);
router.get('/sesiones/:id', getSesion);
// Texto completo de un fragmento citado: lo pide el frontend al desplegar la cita, no antes.
router.get('/chunks/:id', getChunkCitado);
// "Ver más" de una respuesta tabla (listado de documentos guardado en el mensaje).
router.get('/mensajes/:id/resultados', getResultadosMensaje);
// Reintento de un turno 'fallido' sobre las citas que ese turno ya guardó.
router.post('/mensajes/:id/reintentar', postReintentarMensajeStd);

export default router;
