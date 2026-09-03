import { Router } from 'express';
import { getBuscarExpediente, getExpedientes, getUsuarios } from '../controllers/seguimientoController';

const router = Router();

router.get('/usuarios/:coDependencia', getUsuarios);
router.get('/expedientes/buscar', getBuscarExpediente);
router.get('/expedientes', getExpedientes);

export default router;
