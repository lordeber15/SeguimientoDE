import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import adminRoutes from './modulos/sgd/routes/adminRoutes';
import authRoutes from './modulos/sgd/routes/authRoutes';
import calidadProcesosRoutes from './modulos/sgd/routes/calidadProcesosRoutes';
import chatRoutes from './modulos/sgd/routes/chatRoutes';
import dashboardRoutes from './modulos/sgd/routes/dashboardRoutes';
import dependenciaRoutes from './modulos/sgd/routes/dependenciaRoutes';
import documentoRoutes from './modulos/sgd/routes/documentoRoutes';
import ragRoutes from './modulos/sgd/routes/ragRoutes';
import seguimientoRoutes from './modulos/sgd/routes/seguimientoRoutes';
import unirPdfRoutes from './modulos/sgd/routes/unirPdfRoutes';
import archivoRoutesStd from './modulos/std/routes/archivoRoutesStd';
import chatRoutesStd from './modulos/std/routes/chatRoutesStd';
import documentoRoutesStd from './modulos/std/routes/documentoRoutesStd';
import ragRoutesStd from './modulos/std/routes/ragRoutesStd';
import { requiereAuth, requierePermiso } from './compartido/middlewares/authMiddleware';

const allowedOrigins = (process.env.CORS_ORIGIN ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const app = express();

// `contentSecurityPolicy` desactivado: esta API solo sirve JSON y archivos, y la CSP por defecto
// de helmet rompe la vista embebida de los PDF sin aportar nada aquí. El resto de cabeceras
// (nosniff, frameguard, HSTS…) sí interesan.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

app.use(cors({ origin: allowedOrigins.length > 0 ? allowedOrigins : true }));
app.use(express.json({ limit: '1mb' }));

// Detrás de un proxy inverso, `req.ip` sería la del proxy y el límite por IP protegería a todos
// por igual — es decir, a nadie. Solo se confía en el primer salto.
app.set('trust proxy', 1);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/rag', ragRoutes);
app.use('/api/rag/chat', chatRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/calidad-procesos', calidadProcesosRoutes);

// Todo lo demás exige sesión. El permiso concreto se comprueba por módulo: son datos de gestión
// documental de una entidad pública, no un catálogo abierto.
app.use('/api/dependencias', requiereAuth, requierePermiso('seguimiento.ver'), dependenciaRoutes);
app.use('/api/seguimiento', requiereAuth, requierePermiso('seguimiento.ver'), seguimientoRoutes);
app.use('/api/documentos', requiereAuth, requierePermiso('documentos.ver'), documentoRoutes);
app.use('/api/unir-pdf', requiereAuth, requierePermiso('pdf.unificar'), unirPdfRoutes);

// Módulo STD: el permiso se exige DENTRO de cada router (`std.consultar` para chat/documentos/
// adjuntos, `std.gestionar` para el panel RAG) — mismo patrón que `ragRoutes`/`chatRoutes` del SGD.
app.use('/api/std/chat', chatRoutesStd);
app.use('/api/std/documentos', documentoRoutesStd);
app.use('/api/std/adjuntos', archivoRoutesStd);
app.use('/api/std/rag', ragRoutesStd);

export default app;
