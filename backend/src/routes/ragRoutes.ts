import { Router } from 'express';
import {
  getConfig,
  getDocumentos,
  getExpedientes,
  getJob,
  getJobs,
  getMarkdownDocumento,
  getModelos,
  getPanel,
  postBarrer,
  postCancelarJob,
  postExtraerVision,
  postGC,
  postIngestaConversion,
  postIngestaEmbedding,
  postIngestaLargos,
  postIngestaReparacion,
  postModeloRegistrar,
  postPausarJob,
  postReanudarJob,
  postReintentarDocumento,
  postRetencion,
  putConfig,
  putModeloActivar,
} from '../controllers/ragController';
import { requiereAuth, requierePermiso } from '../middlewares/authMiddleware';

const router = Router();

router.use(requiereAuth);

// La ingesta consume presupuesto de LLM: es una operación de administración, no de consulta.
router.get('/panel', requierePermiso('rag.gestionar'), getPanel);
router.get('/documentos', requierePermiso('rag.gestionar'), getDocumentos);
router.get('/documentos/:id/markdown', requierePermiso('rag.gestionar'), getMarkdownDocumento);
router.post('/documentos/:id/reintentar', requierePermiso('rag.gestionar'), postReintentarDocumento);
router.post('/documentos/:id/vision', requierePermiso('rag.gestionar'), postExtraerVision);
router.get('/expedientes', requierePermiso('rag.gestionar'), getExpedientes);
router.post('/barrer', requierePermiso('rag.gestionar'), postBarrer);
router.get('/config', requierePermiso('rag.gestionar'), getConfig);
router.put('/config/:clave', requierePermiso('rag.gestionar'), putConfig);

router.post('/ingesta/conversion', requierePermiso('rag.gestionar'), postIngestaConversion);
router.post('/ingesta/reparacion', requierePermiso('rag.gestionar'), postIngestaReparacion);
router.post('/ingesta/largos', requierePermiso('rag.gestionar'), postIngestaLargos);
router.post('/ingesta/embeddings', requierePermiso('rag.gestionar'), postIngestaEmbedding);
router.post('/ingesta/:jobId/pausar', requierePermiso('rag.gestionar'), postPausarJob);
router.post('/ingesta/:jobId/reanudar', requierePermiso('rag.gestionar'), postReanudarJob);
router.post('/ingesta/:jobId/cancelar', requierePermiso('rag.gestionar'), postCancelarJob);
router.get('/ingesta/:jobId', requierePermiso('rag.gestionar'), getJob);
router.get('/ingesta', requierePermiso('rag.gestionar'), getJobs);

router.get('/modelos', requierePermiso('rag.gestionar'), getModelos);
router.post('/modelos/registrar', requierePermiso('rag.gestionar'), postModeloRegistrar);
router.put('/modelos/:id/activar', requierePermiso('rag.gestionar'), putModeloActivar);

// Mantenimiento (Fase 6): funcionan manualmente aunque el interruptor automático esté apagado.
router.post('/mantenimiento/retencion', requierePermiso('rag.gestionar'), postRetencion);
router.post('/mantenimiento/gc', requierePermiso('rag.gestionar'), postGC);

export default router;
