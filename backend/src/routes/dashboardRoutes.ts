import { Router } from 'express';
import {
  getEmpleados,
  getOficinas,
  getPendientesDetalle,
  getPendientesOficinas,
  getPesosTipoDocumento,
  getResumenEstado,
  getTiposDocumento,
  postResumenRefrescar,
  putPesoTipoDocumento,
} from '../controllers/dashboardController';
import { requiereAuth, requierePermiso } from '../middlewares/authMiddleware';

const router = Router();

router.use(requiereAuth);

// Consulta: cualquiera con dashboard.ver. Separadas para que el frontend pida cada agregación
// solo cuando su pestaña se abre.
router.get('/oficinas', requierePermiso('dashboard.ver'), getOficinas);
router.get('/empleados', requierePermiso('dashboard.ver'), getEmpleados);
router.get('/tipos-documento', requierePermiso('dashboard.ver'), getTiposDocumento);
// Carga laboral (Fase 2): backlog vigente hoy, sin acotar por desde/hasta — ver dashboardService.
router.get('/pendientes/oficinas', requierePermiso('dashboard.ver'), getPendientesOficinas);
// Drill-down: los documentos concretos detrás de un número de la tabla anterior.
router.get(
  '/pendientes/oficinas/:coDependencia/detalle',
  requierePermiso('dashboard.ver'),
  getPendientesDetalle,
);
router.get('/resumen/estado', requierePermiso('dashboard.ver'), getResumenEstado);

// Administración: forzar un refresco es una operación de ~8-10 s contra el SGD, no una consulta.
router.post('/resumen/refrescar', requierePermiso('dashboard.gestionar'), postResumenRefrescar);

// Fase 3 — pesos por tipo de documento: la pantalla trae muestra/mediana/sugerencia, no solo el
// peso vigente (que sí viaja dentro de /oficinas y /empleados con dashboard.ver), así que
// administrarla exige dashboard.gestionar igual que el refresco manual.
router.get('/pesos', requierePermiso('dashboard.gestionar'), getPesosTipoDocumento);
router.put('/pesos/:coTipDoc', requierePermiso('dashboard.gestionar'), putPesoTipoDocumento);

export default router;
