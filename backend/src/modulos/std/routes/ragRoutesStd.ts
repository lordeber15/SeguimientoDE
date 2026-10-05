import { Router } from 'express';
import {
  getConfig,
  getDocumentos,
  getDocumentosStdCobertura,
  getJob,
  getJobs,
  getMarkdownDocumento,
  getModelos,
  getPanel,
  postBarrer,
  postGC,
  postIngestaConversion,
  postIngestaEmbedding,
  postIngestaReintentoSinArchivo,
  postModeloRegistrar,
  postPausarJob,
  postReanudarJob,
  postCancelarJob,
  postExtraerVision,
  postReintentarDocumento,
  postRetencion,
  putConfig,
  putModeloActivar,
} from '../controllers/ragControllerStd';
import { requiereAuth, requierePermiso } from '../../../compartido/middlewares/authMiddleware';

const router = Router();

router.use(requiereAuth);

router.get('/panel', requierePermiso('std.gestionar'), getPanel);
router.get('/documentos', requierePermiso('std.gestionar'), getDocumentos);
router.get('/documentos/:id/markdown', requierePermiso('std.gestionar'), getMarkdownDocumento);
router.post('/documentos/:id/reintentar', requierePermiso('std.gestionar'), postReintentarDocumento);
router.post('/documentos/:id/vision', requierePermiso('std.gestionar'), postExtraerVision);
router.get('/documentos-std', requierePermiso('std.gestionar'), getDocumentosStdCobertura);

router.post('/barrer', requierePermiso('std.gestionar'), postBarrer);

router.get('/config', requierePermiso('std.gestionar'), getConfig);
router.put('/config/:clave', requierePermiso('std.gestionar'), putConfig);

router.post('/ingesta/conversion', requierePermiso('std.gestionar'), postIngestaConversion);
router.post('/ingesta/sin-archivo', requierePermiso('std.gestionar'), postIngestaReintentoSinArchivo);
router.post('/ingesta/embeddings', requierePermiso('std.gestionar'), postIngestaEmbedding);
router.post('/ingesta/:jobId/pausar', requierePermiso('std.gestionar'), postPausarJob);
router.post('/ingesta/:jobId/reanudar', requierePermiso('std.gestionar'), postReanudarJob);
router.post('/ingesta/:jobId/cancelar', requierePermiso('std.gestionar'), postCancelarJob);
router.get('/ingesta/:jobId', requierePermiso('std.gestionar'), getJob);
router.get('/ingesta', requierePermiso('std.gestionar'), getJobs);

router.get('/modelos', requierePermiso('std.gestionar'), getModelos);
router.post('/modelos/registrar', requierePermiso('std.gestionar'), postModeloRegistrar);
router.put('/modelos/:id/activar', requierePermiso('std.gestionar'), putModeloActivar);

router.post('/mantenimiento/retencion', requierePermiso('std.gestionar'), postRetencion);
router.post('/mantenimiento/gc', requierePermiso('std.gestionar'), postGC);

export default router;
