import '../compartido/config/env';
import { crearChatProvider } from '../compartido/ai/providerFactory';
import { casosPlanificador, compararPlan } from '../compartido/rag/evaluacionPlanificador';
import { planificar } from '../compartido/rag/planificadorService';
import { terminosDelPlan } from '../modulos/sgd/rag/busquedaExpedientesService';

/**
 * Evalúa el planificador contra el modelo REAL con el set de `casosPlanificador.json`
 * (docs/PLAN-CHAT-CONSULTAS.md, Fase 6). No escribe nada; gasta ~1 100 tokens por pregunta.
 *
 *   npm run eval:planificador            # 3 repeticiones por caso
 *   npm run eval:planificador -- 5 cambio_tema seguimiento_contenido   # 5 repeticiones, solo esos casos
 *
 * Dentro del contenedor: node dist/scripts/evaluarPlanificador.js
 */
async function main(): Promise<void> {
  const [repeticionesArg, ...ids] = process.argv.slice(2);
  const repeticiones = Math.max(1, Number(repeticionesArg) || 3);
  const casos = casosPlanificador().filter((c) => ids.length === 0 || ids.includes(c.id));
  const provider = crearChatProvider();

  let correctos = 0;
  let total = 0;
  let respaldos = 0;
  let tokensIn = 0;
  let ms = 0;
  const fallasPorCaso: { id: string; aciertos: number; fallas: string[] }[] = [];

  for (const caso of casos) {
    let aciertos = 0;
    const fallas: string[] = [];
    for (let i = 0; i < repeticiones; i++) {
      const r = await planificar(provider, caso.pregunta, { modo: caso.modo, historial: caso.historial });
      total++;
      ms += r.ms;
      tokensIn += r.uso?.tokensIn ?? 0;
      if (r.respaldo) {
        respaldos++;
        console.log(`        [respaldo] ${caso.id}: ${r.diagnostico}`);
      }
      const terminos = terminosDelPlan(r.plan);
      const f = compararPlan(r.plan, terminos, caso.esperado);
      if (f.length === 0) {
        aciertos++;
        correctos++;
      } else {
        fallas.push(`${f.join('; ')}  [${r.plan.intencion} ${JSON.stringify(terminos)}]`);
      }
    }
    fallasPorCaso.push({ id: caso.id, aciertos, fallas });
    const marca = aciertos === repeticiones ? 'OK ' : aciertos === 0 ? 'MAL' : '~  ';
    console.log(`${marca} ${aciertos}/${repeticiones}  ${caso.id}`);
    for (const f of [...new Set(fallas)]) console.log(`        ${f}`);
  }

  console.log(`\n${correctos}/${total} correctos (${((100 * correctos) / Math.max(total, 1)).toFixed(1)} %), `
    + `${respaldos} con plan de respaldo, ${Math.round(ms / Math.max(total, 1))} ms y `
    + `${Math.round(tokensIn / Math.max(total, 1))} tokens de entrada por pregunta.`);
  const inestables = fallasPorCaso.filter((c) => c.aciertos > 0 && c.aciertos < repeticiones).map((c) => c.id);
  if (inestables.length > 0) console.log(`Inestables (aciertan a veces): ${inestables.join(', ')}`);
}

main().then(() => process.exit(0), (e) => {
  console.error(e);
  process.exit(1);
});
