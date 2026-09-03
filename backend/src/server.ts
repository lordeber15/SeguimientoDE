import './config/env';
import app from './app';
import { appSequelize } from './config/appDatabase';
import { aplicarMigraciones } from './config/migraciones';
import { validarEntorno } from './config/validarEntorno';
import { sequelize } from './models';
import { iniciarPlanificadorResumen } from './services/dashboardResumenService';
import { iniciarPlanificadorBarrido } from './rag/barridoService';
import { reanudarJobsInterrumpidos } from './rag/ingestaService';
import { iniciarMantenimientoPeriodico } from './rag/mantenimientoService';
import { revisarConfiguracionIA } from './ai/providerFactory';
import { iniciarLimpiezaPeriodica } from './services/unirPdfService';

const PORT = Number(process.env.PORT ?? 3012);

async function start() {
  // Antes que nada: si falta una variable crítica, mejor no arrancar que fallar en el primer login.
  validarEntorno();

  try {
    await sequelize.authenticate();
    console.log(`Conexión a PostgreSQL (esquema ${process.env.DB_SCHEMA}) establecida correctamente.`);

    await appSequelize.authenticate();
    const nuevas = await aplicarMigraciones();
    console.log(
      nuevas.length > 0
        ? `BD propia lista. Migraciones aplicadas: ${nuevas.join(', ')}`
        : 'BD propia lista. Sin migraciones pendientes.',
    );

    // Barre los PDF unidos caducados y los huérfanos que dejó una ejecución anterior.
    iniciarLimpiezaPeriodica();

    // El planificador siempre corre; el interruptor `rag.barrido.activo` se consulta en cada
    // tick, así que encenderlo o apagarlo surte efecto sin reiniciar. Arranca DESACTIVADO.
    iniciarPlanificadorBarrido();

    // Espejo local del dashboard de desempeño (ver dashboardResumenService.ts) — arranca
    // ACTIVADO: sin refresco periódico el dashboard mostraría el espejo vacío para siempre, y a
    // diferencia del barrido del RAG no tiene ningún costo externo (solo SQL en background).
    iniciarPlanificadorResumen();

    // Retención de logs (activa por defecto) y recolector de basura de contenidos huérfanos
    // (desactivado por defecto) — Fase 6. Mismo patrón: el planificador siempre corre, los
    // interruptores se leen de `app.config` en cada comprobación.
    iniciarMantenimientoPeriodico();

    // Reclama ítems de ingesta con lease vencido (proceso caído o backend reiniciado a medias) y
    // reanuda los jobs de conversión que se quedaron interrumpidos.
    await reanudarJobsInterrumpidos();

    // La configuración de IA se avisa, no bloquea: hoy es normal no tener claves todavía y la
    // ingesta puede convertir y trocear sin ellas. Solo los embeddings quedan a la espera.
    const problemasIA = revisarConfiguracionIA();
    if (problemasIA.length > 0) {
      console.log('Proveedores de IA pendientes de configurar:');
      for (const p of problemasIA) console.log(`  - ${p.variable}: ${p.mensaje}`);
    }

    app.listen(PORT, () => {
      console.log(`Backend escuchando en el puerto ${PORT}`);
    });
  } catch (error) {
    console.error('No se pudo iniciar el backend:', error);
    process.exit(1);
  }
}

start();
