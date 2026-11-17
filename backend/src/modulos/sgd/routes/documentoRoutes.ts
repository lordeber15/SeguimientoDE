import { Router } from 'express';
import {
  getAnexo,
  getDocumento,
  getEstadoAlmacenamiento,
  getInteracciones,
  getInteraccionesCompletas,
  getListaAnexos,
} from '../controllers/documentoController';

const router = Router();

router.get('/almacenamiento', getEstadoAlmacenamiento);
router.get('/expediente/:nuAnnExp/:nuSecExp/interacciones-completas', getInteraccionesCompletas);
router.get('/expediente/:nuAnnExp/:nuSecExp/interacciones', getInteracciones);
router.get('/:nuAnn/:nuEmi', getDocumento);
router.get('/:nuAnn/:nuEmi/anexos', getListaAnexos);
router.get('/:nuAnn/:nuEmi/anexos/:nuAne', getAnexo);

export default router;
