import './compartido/config/env';
import app from './app';
import { appSequelize } from './compartido/config/appDatabase';
import { aplicarMigraciones } from './compartido/config/migraciones';
import { validarEntorno } from './compartido/config/validarEntorno';
import { sequelize } from './modulos/sgd/models';
import { STD_HABILITADO, stdDisponible, stdSequelize } from './modulos/std/config/stdDatabase';
import { asegurarBaseStdRag, aplicarMigracionesStd } from './modulos/std/config/stdRagDatabase';
import { iniciarPlanificadorBarridoStd } from './modulos/std/rag/barridoStdService';
import { iniciarSupervisorIngestaStd, reanudarJobsInterrumpidosStd } from './modulos/std/rag/ingestaStdService';
import { iniciarPlanificadorResumen } from './modulos/sgd/services/dashboardResumenService';
import { iniciarPlanificadorBarrido } from './modulos/sgd/rag/barridoService';
import { iniciarSupervisorIngesta, reanudarJobsInterrumpidos } from './modulos/sgd/rag/ingestaService';
import { iniciarMantenimientoPeriodico } from './modulos/sgd/rag/mantenimientoService';
import { revisarConfiguracionIA } from './compartido/ai/providerFactory';
import { iniciarLimpiezaPeriodica } from './modulos/sgd/services/unirPdfService';

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

    // El STD es opcional (sistema legado, casi solo de consulta): nada de esto bloquea el
    // arranque del resto del backend, a diferencia del SGD y la BD propia de arriba.
    if (STD_HABILITADO) {
      // La base `std_rag` (vectores, chunks, chat del STD) es infraestructura PROPIA — solo
      // necesita las credenciales de APP_DB_*, que ya son obligatorias, así que se prepara
      // aunque todavía no haya credenciales de MariaDB del STD cargadas.
      try {
        await asegurarBaseStdRag();
        const nuevasStd = await aplicarMigracionesStd();
        console.log(
          nuevasStd.length > 0
            ? `BD std_rag lista. Migraciones aplicadas: ${nuevasStd.join(', ')}`
            : 'BD std_rag lista. Sin migraciones pendientes.',
        );
      } catch (error) {
        console.error('No se pudo preparar la base std_rag; el módulo STD queda sin RAG:', error);
      }

      const std = stdDisponible();
      if (std.disponible) {
        try {
          await stdSequelize.authenticate();
          console.log('Conexión de solo lectura al STD (MariaDB) establecida correctamente.');
        } catch (error) {
          console.error('STD configurado pero no se pudo conectar:', error);
        }
      } else {
        console.log(`STD sin conexión de lectura (${std.motivo}); std_rag sigue disponible igual.`);
      }

      // Mismo patrón que el SGD: el planificador y el supervisor siempre corren, los
      // interruptores (`rag.barrido.activo`, que arranca en 'false') se leen en cada tick. Que la
      // conexión a MariaDB no esté lista todavía no impide arrancarlos — un tick que falle por
      // eso simplemente se registra y se reintenta en el siguiente.
      iniciarPlanificadorBarridoStd();
      await reanudarJobsInterrumpidosStd();
      iniciarSupervisorIngestaStd();
    } else {
      console.log('STD_HABILITADO no está activado; el backend arranca sin el módulo STD.');
    }

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
    // reanuda los jobs de conversión que se quedaron interrumpidos. La primera pasada se espera
    // aquí para que el arranque deje la cola coherente; a partir de ahí el supervisor repite la
    // misma revisión cada minuto — hace falta porque un reinicio a mitad de documento deja el
    // lease vigente 10 minutos más, y una única comprobación al arrancar nunca lo vería vencer.
    await reanudarJobsInterrumpidos();
    iniciarSupervisorIngesta();

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
