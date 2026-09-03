import { Router } from 'express';
import {
  getAccesos,
  getRoles,
  getUsuarios,
  putHabilitado,
  putRolesUsuario,
} from '../controllers/adminController';
import { requiereAuth, requierePermiso } from '../middlewares/authMiddleware';

const router = Router();

router.use(requiereAuth);

router.get('/usuarios', requierePermiso('usuarios.gestionar'), getUsuarios);
router.get('/roles', requierePermiso('usuarios.gestionar'), getRoles);
router.put('/usuarios/:codUser/roles', requierePermiso('usuarios.gestionar'), putRolesUsuario);
router.put('/usuarios/:codUser/habilitado', requierePermiso('usuarios.gestionar'), putHabilitado);
router.get('/accesos', requierePermiso('auditoria.ver'), getAccesos);

export default router;
