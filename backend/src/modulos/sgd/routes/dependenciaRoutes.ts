import { Router } from 'express';
import { getAllDependencias } from '../controllers/dependenciaController';

const router = Router();

router.get('/', getAllDependencias);

export default router;
