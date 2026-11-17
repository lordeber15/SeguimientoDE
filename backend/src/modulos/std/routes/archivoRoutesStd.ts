import { Router } from 'express';
import { getArchivoAdjunto } from '../controllers/archivoControllerStd';
import { requiereAuth, requierePermiso } from '../../../compartido/middlewares/authMiddleware';

const router = Router();

router.use(requiereAuth, requierePermiso('std.consultar'));

router.get('/:idAdjunto/archivo', getArchivoAdjunto);

export default router;
