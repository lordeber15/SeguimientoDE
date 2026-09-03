import { Router } from 'express';
import {
  getDescargaUnion,
  getEstadoUnion,
  postUnirPdf,
} from '../controllers/unirPdfController';

const router = Router();

router.post('/expediente/:nuAnnExp/:nuSecExp', postUnirPdf);
router.get('/:jobId/estado', getEstadoUnion);
router.get('/:jobId/descargar', getDescargaUnion);

export default router;
