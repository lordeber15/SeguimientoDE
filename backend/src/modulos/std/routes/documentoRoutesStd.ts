import { Router } from 'express';
import { getBuscarDocumentos } from '../controllers/documentoControllerStd';
import { requiereAuth, requierePermiso } from '../../../compartido/middlewares/authMiddleware';

const router = Router();

router.use(requiereAuth, requierePermiso('std.consultar'));

router.get('/buscar', getBuscarDocumentos);

export default router;
