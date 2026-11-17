import '../compartido/config/env';
import fs from 'fs';
import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { appSequelize } from '../compartido/config/appDatabase';
import { detectarRegresiones } from '../compartido/rag/evaluacionRag';

/**
 * Importa a `rag.eval_corrida` las métricas que calculó Ragas (contenedor `rag-evals`) sobre una
 * corrida de `eval:rag`, y las compara con las de la última corrida ACEPTADA del módulo que también
 * las tenga (docs/PLAN-RAG-AVANZADO.md, Fase 1).
 *
 *   npm run eval:rag:importar -- evals/salidas/sgd-12.ragas.json [--tolerancia 0.05] [--no-fallar]
 */

const metricas = z.record(z.number().nullable());
const esquema = z.object({
  corrida_id: z.coerce.number().int(),
  modulo: z.enum(['sgd', 'std']),
  metricas,
  por_caso: z.array(z.object({ caso_id: z.string(), metricas })),
});

const soloNumeros = (m: Record<string, number | null>) =>
  Object.fromEntries(Object.entries(m).filter((e): e is [string, number] => typeof e[1] === 'number'));

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const archivo = argv.find((a) => !a.startsWith('--'));
  if (!archivo) throw new Error('Indique el archivo .ragas.json que generó el contenedor rag-evals');
  const iTol = argv.indexOf('--tolerancia');
  const tolerancia = iTol >= 0 ? Number(argv[iTol + 1]) : 0.05;

  const datos = esquema.parse(JSON.parse(fs.readFileSync(archivo, 'utf8')));

  await appSequelize.transaction(async (tx) => {
    const filas = await appSequelize.query<{ id: number }>(
      `UPDATE rag.eval_corrida SET metricas_ragas = $2::jsonb WHERE id = $1 AND modulo = $3 RETURNING id`,
      { bind: [datos.corrida_id, JSON.stringify(datos.metricas), datos.modulo], type: QueryTypes.SELECT, transaction: tx },
    );
    if (filas.length === 0) {
      throw new Error(`No existe la corrida #${datos.corrida_id} del módulo ${datos.modulo}`);
    }
    for (const c of datos.por_caso) {
      await appSequelize.query(
        `UPDATE rag.eval_resultado SET metricas_ragas = $3::jsonb WHERE corrida_id = $1 AND caso_id = $2`,
        { bind: [datos.corrida_id, c.caso_id, JSON.stringify(c.metricas)], transaction: tx },
      );
    }
  });

  console.log(`Métricas Ragas de la corrida #${datos.corrida_id} (${datos.modulo.toUpperCase()}):`);
  for (const [k, v] of Object.entries(datos.metricas)) {
    console.log(`  ${k.padEnd(20)} ${v === null ? '—' : v.toFixed(3)}`);
  }

  const [base] = await appSequelize.query<{ id: number; metricas_ragas: Record<string, number | null> }>(
    `SELECT id, metricas_ragas FROM rag.eval_corrida
      WHERE modulo = $1 AND aceptada AND metricas_ragas IS NOT NULL AND id <> $2
      ORDER BY fe DESC LIMIT 1`,
    { bind: [datos.modulo, datos.corrida_id], type: QueryTypes.SELECT },
  );
  if (!base) {
    console.log('Sin línea base con métricas Ragas todavía.');
    return 0;
  }

  const regresiones = detectarRegresiones(soloNumeros(base.metricas_ragas), soloNumeros(datos.metricas), tolerancia);
  if (regresiones.length === 0) {
    console.log(`Sin regresiones frente a la corrida #${base.id}.`);
    return 0;
  }
  console.log(`REGRESIÓN frente a la corrida #${base.id}:`);
  for (const r of regresiones) console.log(`  ${r.metrica}: ${r.base.toFixed(3)} → ${r.actual.toFixed(3)}`);
  return argv.includes('--no-fallar') ? 0 : 1;
}

main().then((codigo) => process.exit(codigo), (e) => {
  console.error(e);
  process.exit(1);
});
