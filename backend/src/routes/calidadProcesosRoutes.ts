import { Router } from 'express';
import {
  getFlujo,
  getProcesos,
  getPropuesta,
  putNombreProceso,
} from '../controllers/calidadProcesosController';
import { requiereAuth, requierePermiso } from '../middlewares/authMiddleware';

const router = Router();

router.use(requiereAuth);

// Consulta: cualquiera con calidad.ver. Separadas para que el frontend pida el flujo y la
// propuesta solo al abrir su pestaña, igual que hace el dashboard con /empleados.
router.get('/procesos', requierePermiso('calidad.ver'), getProcesos);
router.get('/procesos/:clave/flujo', requierePermiso('calidad.ver'), getFlujo);
router.get('/procesos/:clave/propuesta', requierePermiso('calidad.ver'), getPropuesta);

// Renombrar una familia cambia lo que ve todo el mundo. Reutiliza `dashboard.gestionar` en vez de
// crear un permiso más, igual que hizo la Fase 3 con los pesos por tipo de documento.
router.put('/procesos/:clave/nombre', requierePermiso('dashboard.gestionar'), putNombreProceso);

export default router;
