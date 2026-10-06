import '../compartido/config/env';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { QueryTypes, type Sequelize } from 'sequelize';
import { appSequelize } from '../compartido/config/appDatabase';
import { crearChatProvider, proveedorEmbeddingConfigurado } from '../compartido/ai/providerFactory';
import type { ChatProvider, ResultadoChat } from '../compartido/ai/types';
import { leerParametros, prepararTerminos, terminosDelPlan } from '../compartido/rag/busquedaTerminos';
import { mensajeFijo } from '../compartido/rag/cierreChat';
import { leerBooleano } from '../compartido/rag/configService';
import {
  agregarMetricas,
  calcularMetricasCaso,
  cargarCasos,
  detectarRegresiones,
  DIR_EVALS,
  MODULOS,
  normalizar,
  rutaCasos,
  type CasoRag,
  type EtiquetasResueltas,
  type FragmentoEvaluado,
  type MetricasAgregadas,
  type MetricasCaso,
  type ModuloEval,
} from '../compartido/rag/evaluacionRag';
import { planDeRespaldo, planificar, type ResultadoPlanificador } from '../compartido/rag/planificadorService';
import { generarRespuesta, recuperarContexto } from '../modulos/sgd/rag/chatService';
import { stdRagSequelize } from '../modulos/std/config/stdRagDatabase';
import { generarRespuestaStd, recuperarContextoStd } from '../modulos/std/rag/chatStdService';

/**
 * Evaluación del RAG contra el pipeline REAL del chat (docs/PLAN-RAG-AVANZADO.md, Fase 1):
 * planificador → retrieval híbrido + RRF → rerank → presupuesto → respuesta, con las mismas
 * funciones que usa `responderChat` (`recuperarContexto` / `generarRespuesta`), pero sin escribir
 * nada en el chat. Siempre recorre la ruta `contenido`, aunque el planificador clasifique la
 * pregunta de otra forma: lo que se mide aquí es el RAG; la clasificación ya la mide
 * `eval:planificador`. La intención obtenida sí se guarda, para detectar casos mal clasificados.
 *
 *   npm run eval:rag -- --modulo sgd                    # casos revisados, compara con la línea base
 *   npm run eval:rag -- --modulo std --ids a,b          # solo esos casos
 *   npm run eval:rag -- --modulo sgd --sin-generacion   # solo recuperación: sin la llamada de respuesta
 *   npm run eval:rag -- --modulo sgd --aceptar          # marca la corrida como nueva línea base
 *
 * Opciones: --incluir-borradores (también casos sin revisar), --archivo <ruta> (otro dataset),
 * --tolerancia 0.05 (caída máxima admitida por métrica), --no-fallar (exit 0 aunque haya regresión).
 *
 * Escribe la corrida en `rag.eval_corrida` / `rag.eval_resultado` (BD propia) y exporta
 * `evals/salidas/<modulo>-<id>.json` con el esquema {question, contexts, answer, ground_truth} que
 * consume el contenedor `rag-evals` (Ragas). Sale con código 1 si alguna métrica empeora más que la
 * tolerancia respecto de la última corrida aceptada del módulo.
 */

interface Opciones {
  modulo: ModuloEval;
  ids: string[];
  incluirBorradores: boolean;
  sinGeneracion: boolean;
  aceptar: boolean;
  noFallar: boolean;
  tolerancia: number;
  archivo: string | null;
}

function leerOpciones(argv: string[]): Opciones {
  const valor = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const modulo = valor('--modulo') ?? 'sgd';
  if (!(MODULOS as readonly string[]).includes(modulo)) throw new Error(`--modulo debe ser ${MODULOS.join(' o ')}`);
  const tolerancia = Number(valor('--tolerancia') ?? 0.05);
  if (!Number.isFinite(tolerancia) || tolerancia < 0) throw new Error('--tolerancia debe ser un número >= 0');
  return {
    modulo: modulo as ModuloEval,
    ids: (valor('--ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    incluirBorradores: argv.includes('--incluir-borradores'),
    sinGeneracion: argv.includes('--sin-generacion'),
    aceptar: argv.includes('--aceptar'),
    noFallar: argv.includes('--no-fallar'),
    tolerancia,
    archivo: valor('--archivo'),
  };
}

/** Lo que cada módulo aporta: su BD, cómo resolver las etiquetas y cómo correr su pipeline. */
interface AdaptadorModulo {
  db: Sequelize;
  resolverShas(caso: CasoRag): Promise<Set<string>>;
  ejecutar(provider: ChatProvider, caso: CasoRag, consulta: string, terminosFts: string[] | undefined): Promise<{
    candidatos: FragmentoEvaluado[];
    contexto: FragmentoEvaluado[];
    /** El modelo no se llama si no hay contexto (igual que el chat, que responde el mensaje fijo). */
    sinContexto: boolean;
    generar: () => Promise<{ texto: string; marcadoresInvalidos: number; uso: ResultadoChat['uso'] }>;
    usoRerank: ResultadoChat['uso'] | null;
    /** Candidatos por rama: con 0 en la vectorial, el retrieval cayó a FTS puro EN SILENCIO (proveedor
     *  de embeddings inaccesible o sin modelo activo) y el caso no mide el híbrido. */
    candidatosVec: number;
    candidatosFts: number;
  }>;
}

const adaptadorSgd: AdaptadorModulo = {
  db: appSequelize,
  async resolverShas(caso) {
    const shas = new Set<string>();
    for (const d of caso.relevantes.documentos) {
      if (!('nuAnn' in d)) throw new Error(`caso ${caso.id}: documento esperado sin nuAnn/nuEmi (¿es un caso del STD?)`);
      const filas = await appSequelize.query<{ sha: string }>(
        `SELECT DISTINCT contenido_sha256 AS sha FROM rag.documento
          WHERE nu_ann = $1 AND nu_emi = $2 AND ($3::int IS NULL OR nu_ane = $3)
            AND vigente AND contenido_sha256 IS NOT NULL`,
        { bind: [d.nuAnn, d.nuEmi, d.nuAne ?? null], type: QueryTypes.SELECT },
      );
      filas.forEach((f) => shas.add(f.sha));
    }
    return shas;
  },
  async ejecutar(provider, caso, consulta, terminosFts) {
    const ctx = await recuperarContexto(provider, {
      consulta,
      // La evaluación mide el corpus completo: sin filtro de dependencia (como admin/jefe).
      filtro: { coDependencia: null },
      expediente: caso.expediente,
      terminosFts,
    });
    const shaPorChunk = new Map(ctx.chunksAcotados.map((c) => [c.chunkId, c.sha256]));
    return {
      candidatos: ctx.resultado.chunks.map((c) => ({ sha256: c.sha256, texto: c.texto })),
      contexto: ctx.citas.map((c) => ({ sha256: shaPorChunk.get(c.chunkId) ?? '', texto: c.texto })),
      sinContexto: ctx.citas.length === 0 && !(ctx.timeline && ctx.timeline.length > 0),
      usoRerank: ctx.usoRerank,
      candidatosVec: ctx.resultado.candidatosVec,
      candidatosFts: ctx.resultado.candidatosFts,
      generar: async () => {
        const r = await generarRespuesta(provider, {
          timeline: ctx.timeline, citas: ctx.citas, historial: caso.historial, mensaje: caso.pregunta,
        });
        return { texto: r.texto, marcadoresInvalidos: r.marcadoresInvalidos.length, uso: r.respuesta.uso };
      },
    };
  },
};

const adaptadorStd: AdaptadorModulo = {
  db: stdRagSequelize,
  async resolverShas(caso) {
    const shas = new Set<string>();
    for (const d of caso.relevantes.documentos) {
      const [columna, valor] = 'idAdjunto' in d ? ['id_adjunto', d.idAdjunto]
        : 'idDocumento' in d ? ['id_documento', d.idDocumento]
          : (() => { throw new Error(`caso ${caso.id}: documento esperado sin idAdjunto/idDocumento (¿es un caso del SGD?)`); })();
      const filas = await stdRagSequelize.query<{ sha: string }>(
        `SELECT DISTINCT contenido_sha256 AS sha FROM rag.documento
          WHERE ${columna} = $1 AND vigente AND contenido_sha256 IS NOT NULL`,
        { bind: [valor], type: QueryTypes.SELECT },
      );
      filas.forEach((f) => shas.add(f.sha));
    }
    return shas;
  },
  async ejecutar(provider, caso, consulta, terminosFts) {
    const ctx = await recuperarContextoStd(provider, { consulta, idDocumento: caso.idDocumento, terminosFts });
    const shaPorChunk = new Map(ctx.chunksAcotados.map((c) => [c.chunkId, c.sha256]));
    const hayLineaTiempo = Boolean(ctx.timeline && (ctx.timeline.movimientos.length > 0 || ctx.timeline.referencias.length > 0));
    return {
      candidatos: ctx.resultado.chunks.map((c) => ({ sha256: c.sha256, texto: c.texto })),
      contexto: ctx.citas.map((c) => ({ sha256: shaPorChunk.get(c.chunkId) ?? '', texto: c.texto })),
      sinContexto: ctx.citas.length === 0 && !hayLineaTiempo,
      usoRerank: ctx.usoRerank,
      candidatosVec: ctx.resultado.candidatosVec,
      candidatosFts: ctx.resultado.candidatosFts,
      generar: async () => {
        const r = await generarRespuestaStd(provider, {
          timeline: ctx.timeline, citas: ctx.citas, historial: caso.historial, mensaje: caso.pregunta,
        });
        return { texto: r.texto, marcadoresInvalidos: r.marcadoresInvalidos.length, uso: r.respuesta.uso };
      },
    };
  },
};

interface ResultadoCaso {
  caso: CasoRag;
  metricas: MetricasCaso | null;
  intencion: string | null;
  consulta: string;
  contextos: string[];
  respuesta: string | null;
  ms: number;
  candidatosVec: number | null;
  candidatosFts: number | null;
  tokensIn: number;
  tokensOut: number;
  error: string | null;
}

async function evaluarCaso(
  adaptador: AdaptadorModulo,
  provider: ChatProvider,
  caso: CasoRag,
  opciones: Opciones,
  planificadorActivo: boolean,
): Promise<ResultadoCaso> {
  const inicio = Date.now();
  let tokensIn = 0;
  let tokensOut = 0;
  const sumar = (uso: ResultadoChat['uso'] | null | undefined) => {
    tokensIn += uso?.tokensIn ?? 0;
    tokensOut += uso?.tokensOut ?? 0;
  };

  let planificador: ResultadoPlanificador | null = null;
  try {
    const etiquetas: EtiquetasResueltas = {
      shas: await adaptador.resolverShas(caso),
      evidencias: caso.relevantes.evidencias.map(normalizar),
    };
    if (caso.relevantes.documentos.length > 0 && etiquetas.shas.size === 0) {
      throw new Error('ningún documento esperado está en el corpus (¿sin ingestar o ya no vigente?)');
    }

    if (planificadorActivo) {
      planificador = await planificar(provider, caso.pregunta, {
        modo: caso.expediente || caso.idDocumento ? 'expediente' : 'general',
        historial: caso.historial,
      });
      sumar(planificador.uso);
    }
    // Igual que el chat: con el plan de respaldo no hay reescritura confiable, se busca el texto literal.
    const plan = planificador?.plan ?? planDeRespaldo(caso.pregunta);
    const planConfiable = planificador !== null && !planificador.respaldo;
    const consulta = planConfiable ? plan.consulta : caso.pregunta;
    const terminosFts = planConfiable
      ? prepararTerminos(terminosDelPlan(plan), plan, await leerParametros(adaptador.db)).consultas
      : undefined;

    const r = await adaptador.ejecutar(provider, caso, consulta, terminosFts);
    sumar(r.usoRerank);

    let respuesta: string | null = null;
    let marcadores = 0;
    if (!opciones.sinGeneracion) {
      if (r.sinContexto) {
        respuesta = await mensajeFijo('sin_resultados', adaptador.db);
      } else {
        const g = await r.generar();
        sumar(g.uso);
        respuesta = g.texto;
        marcadores = g.marcadoresInvalidos;
      }
    }

    return {
      caso,
      metricas: calcularMetricasCaso({
        caso, etiquetas, candidatos: r.candidatos, contexto: r.contexto, respuesta, marcadoresAlucinados: marcadores,
      }),
      intencion: plan.intencion,
      consulta,
      contextos: r.contexto.map((f) => f.texto),
      respuesta,
      ms: Date.now() - inicio,
      candidatosVec: r.candidatosVec,
      candidatosFts: r.candidatosFts,
      tokensIn,
      tokensOut,
      error: null,
    };
  } catch (e) {
    return {
      caso, metricas: null, intencion: planificador?.plan.intencion ?? null, consulta: caso.pregunta,
      contextos: [], respuesta: null, ms: Date.now() - inicio, candidatosVec: null, candidatosFts: null, tokensIn, tokensOut,
      error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
    };
  }
}

function commitActual(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

async function lineaBase(modulo: ModuloEval): Promise<{ id: number; metricas: MetricasAgregadas } | null> {
  const filas = await appSequelize.query<{ id: number; metricas: MetricasAgregadas }>(
    `SELECT id, metricas FROM rag.eval_corrida WHERE modulo = $1 AND aceptada ORDER BY fe DESC LIMIT 1`,
    { bind: [modulo], type: QueryTypes.SELECT },
  );
  return filas[0] ?? null;
}

async function guardarCorrida(datos: {
  opciones: Opciones;
  config: Record<string, unknown>;
  agregadas: MetricasAgregadas;
  resultados: ResultadoCaso[];
  aceptada: boolean;
}): Promise<number> {
  return appSequelize.transaction(async (tx) => {
    const [fila] = await appSequelize.query<{ id: number }>(
      `INSERT INTO rag.eval_corrida (modulo, commit_git, config, casos, metricas, aceptada)
       VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6) RETURNING id`,
      {
        bind: [
          datos.opciones.modulo, commitActual(), JSON.stringify(datos.config), datos.resultados.length,
          JSON.stringify(datos.agregadas), datos.aceptada,
        ],
        type: QueryTypes.SELECT,
        transaction: tx,
      },
    );
    for (const r of datos.resultados) {
      await appSequelize.query(
        `INSERT INTO rag.eval_resultado (corrida_id, caso_id, metricas, intencion, consulta, respuesta, ms, error)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)`,
        {
          bind: [
            fila.id, r.caso.id, JSON.stringify({
              ...r.metricas, candidatosVec: r.candidatosVec, candidatosFts: r.candidatosFts,
              tokensIn: r.tokensIn, tokensOut: r.tokensOut,
            }),
            r.intencion, r.consulta, r.respuesta, r.ms, r.error,
          ],
          type: QueryTypes.INSERT,
          transaction: tx,
        },
      );
    }
    // bigserial llega como string desde pg: se normaliza para el nombre del archivo y el JSON exportado.
    return Number(fila.id);
  });
}

/** Exporta para Ragas: los casos `sin_respuesta` y los fallidos no entran (no tienen contexto que juzgar). */
function exportarParaRagas(corridaId: number, modulo: ModuloEval, resultados: ResultadoCaso[]): string {
  const dir = path.join(DIR_EVALS, 'salidas');
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, `${modulo}-${corridaId}.json`);
  const muestras = resultados
    .filter((r) => r.error === null && r.respuesta !== null && !r.caso.sin_respuesta && r.contextos.length > 0)
    .map((r) => ({
      caso_id: r.caso.id,
      question: r.caso.pregunta,
      contexts: r.contextos,
      answer: r.respuesta,
      ground_truth: r.caso.ground_truth,
    }));
  fs.writeFileSync(archivo, JSON.stringify({ corrida_id: corridaId, modulo, muestras }, null, 2), 'utf8');
  return archivo;
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '  —  ' : `${(100 * v).toFixed(1).padStart(5)}%`);

function imprimirResumen(agregadas: MetricasAgregadas, base: MetricasAgregadas | null): void {
  const etiquetas: [keyof MetricasAgregadas['promedios'], string][] = [
    ['hitN', 'Hit Rate @N (RRF, top-20)'],
    ['hitK', 'Hit Rate @K (contexto final)'],
    ['mrr', 'MRR (contexto final)'],
    ['precisionK', 'Precisión etiquetada @K'],
    ['recallEvidencias', 'Recall de evidencias @K'],
    ['abstencionCorrecta', 'Abstención correcta (sin_respuesta)'],
    ['abstencionIndebida', 'Abstención indebida (menos es mejor)'],
  ];
  console.log('\nMétrica                                   actual   base    n');
  for (const [clave, texto] of etiquetas) {
    console.log(`${texto.padEnd(40)} ${pct(agregadas.promedios[clave])}  ${pct(base?.promedios[clave])}  ${agregadas.n[clave] ?? 0}`);
  }
  console.log(`Marcadores alucinados: ${agregadas.marcadoresAlucinados} · errores: ${agregadas.errores} · `
    + `${agregadas.msPromedio} ms por caso`);
}

async function main(): Promise<number> {
  const opciones = leerOpciones(process.argv.slice(2));
  const archivo = opciones.archivo ?? rutaCasos(opciones.modulo);
  const dataset = cargarCasos(archivo);
  if (dataset.modulo !== opciones.modulo) {
    throw new Error(`${archivo} es del módulo "${dataset.modulo}", no "${opciones.modulo}"`);
  }

  const casos = dataset.casos.filter((c) =>
    (opciones.ids.length === 0 || opciones.ids.includes(c.id)) && (opciones.incluirBorradores || c.revisado));
  if (casos.length === 0) {
    console.log(`No hay casos que evaluar en ${archivo} (¿ninguno con "revisado": true? use --incluir-borradores).`);
    return 0;
  }

  const adaptador = opciones.modulo === 'sgd' ? adaptadorSgd : adaptadorStd;
  const provider = crearChatProvider();
  const planificadorActivo = await leerBooleano('chat.planificador.activo', true, adaptador.db);

  console.log(`Evaluando ${casos.length} casos del ${opciones.modulo.toUpperCase()} con ${provider.nombre}/${provider.modelo}`
    + `${opciones.sinGeneracion ? ' (sin generación)' : ''}…\n`);

  const resultados: ResultadoCaso[] = [];
  for (const caso of casos) {
    const r = await evaluarCaso(adaptador, provider, caso, opciones, planificadorActivo);
    resultados.push(r);
    const m = r.metricas;
    const marca = r.error ? 'ERR' : !m?.etiquetado ? ' · ' : m.hitK ? 'OK ' : m.hitN ? '~  ' : 'MAL';
    console.log(`${marca} ${caso.id.padEnd(32)} hit@N ${pct(m?.hitN)} hit@K ${pct(m?.hitK)} `
      + `mrr ${pct(m?.mrr)} vec ${r.candidatosVec ?? '-'} fts ${r.candidatosFts ?? '-'} [${r.intencion ?? '-'}] ${r.ms} ms${r.error ? `  ${r.error}` : ''}`);
  }

  const agregadas = agregarMetricas(resultados);
  const sinVectorial = resultados.filter((r) => r.candidatosVec === 0).length;
  if (sinVectorial > 0) {
    console.log(`\nAVISO: en ${sinVectorial}/${resultados.length} casos la rama vectorial no devolvió nada (¿embeddings `
      + 'inaccesibles desde aquí? revise OLLAMA_URL). Esos casos miden FTS puro, no el híbrido.');
  }
  const base = await lineaBase(opciones.modulo);
  imprimirResumen(agregadas, base?.metricas ?? null);

  const regresiones = base
    ? detectarRegresiones(
      base.metricas.promedios as Record<string, number>,
      agregadas.promedios as Record<string, number>,
      opciones.tolerancia,
    )
    : [];

  const config = {
    chat: { proveedor: provider.nombre, modelo: provider.modelo },
    embeddings: proveedorEmbeddingConfigurado(),
    planificador: planificadorActivo,
    sinGeneracion: opciones.sinGeneracion,
    incluirBorradores: opciones.incluirBorradores,
    ids: opciones.ids,
    presupuestoTokens: Number(process.env.RAG_CHAT_PRESUPUESTO_TOKENS ?? 3000),
    dataset: path.relative(DIR_EVALS, archivo),
  };
  const corridaId = await guardarCorrida({ opciones, config, agregadas, resultados, aceptada: opciones.aceptar });
  const exportado = opciones.sinGeneracion ? null : exportarParaRagas(corridaId, opciones.modulo, resultados);

  console.log(`\nCorrida #${corridaId} guardada${opciones.aceptar ? ' y ACEPTADA como línea base' : ''}.`);
  if (exportado) {
    console.log(`Para Ragas: docker compose --profile evals run --rm rag-evals /evals/salidas/${path.basename(exportado)}`);
  }
  if (!base) console.log('Sin línea base todavía: acepte una corrida con --aceptar para comparar las siguientes.');

  if (regresiones.length > 0) {
    console.log(`\nREGRESIÓN frente a la corrida #${base!.id} (tolerancia ${(100 * opciones.tolerancia).toFixed(0)} pts):`);
    for (const r of regresiones) console.log(`  ${r.metrica}: ${pct(r.base)} → ${pct(r.actual)}`);
    return opciones.noFallar ? 0 : 1;
  }
  return 0;
}

main().then((codigo) => process.exit(codigo), (e) => {
  console.error(e);
  process.exit(1);
});
