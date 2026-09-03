import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import adminRoutes from './routes/adminRoutes';
import authRoutes from './routes/authRoutes';
import calidadProcesosRoutes from './routes/calidadProcesosRoutes';
import chatRoutes from './routes/chatRoutes';
import dashboardRoutes from './routes/dashboardRoutes';
import dependenciaRoutes from './routes/dependenciaRoutes';
import documentoRoutes from './routes/documentoRoutes';
import ragRoutes from './routes/ragRoutes';
import seguimientoRoutes from './routes/seguimientoRoutes';
import unirPdfRoutes from './routes/unirPdfRoutes';
import { requiereAuth, requierePermiso } from './middlewares/authMiddleware';

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

export default app;
