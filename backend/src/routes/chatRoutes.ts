import { Router } from 'express';
import {
  getBuscarExpedientes,
  getChunkCitado,
  getEstadoIngestaExpediente,
  getEstadoIngestaExpedientes,
  getSesion,
  getSesionExpediente,
  getSesiones,
  postChatExpediente,
  postChatGeneral,
} from '../controllers/chatController';
import { requiereAuth, requierePermiso } from '../middlewares/authMiddleware';

const router = Router();

router.use(requiereAuth, requierePermiso('rag.consultar'));

router.post('/general', postChatGeneral);
router.post('/expediente/:nuAnnExp/:nuSecExp', postChatExpediente);
router.get('/expedientes/buscar', getBuscarExpedientes);
router.get('/expedientes/estado', getEstadoIngestaExpedientes);
router.get('/expediente/:nuAnnExp/:nuSecExp/estado', getEstadoIngestaExpediente);
router.get('/sesiones/expediente/:nuAnnExp/:nuSecExp', getSesionExpediente);
router.get('/sesiones', getSesiones);
router.get('/sesiones/:id', getSesion);
// Texto completo de un fragmento citado: lo pide el frontend al desplegar la cita, no antes.
router.get('/chunks/:id', getChunkCitado);

export default router;
