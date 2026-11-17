import { registrarPublicador, type PasoTraza, type Traza } from './traza';

/**
 * Destinos de las trazas (docs/PLAN-RAG-AVANZADO.md, Fase 2, D4):
 *
 * 1. SIEMPRE la BD del módulo (`rag.traza` / `rag.traza_paso`): sin servicios extra, consultable por
 *    SQL y purgada por la retención de mantenimiento junto con `retrieval_log`.
 * 2. Langfuse, solo si `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` y `LANGFUSE_HOST` están definidos
 *    (pensado para una instancia self-hosted: las trazas llevan texto de documentos). Por OTLP/HTTP
 *    con JSON — la API de ingesta antigua de Langfuse está obsoleta — y sin SDK: es un POST.
 *
 * `activarPublicacionDeTrazas()` lo llama `server.ts` al arrancar. Tests y scripts no lo llaman: las
 * trazas se arman igual en memoria, pero no se escriben en ningún lado.
 */

export function activarPublicacionDeTrazas(): void {
  registrarPublicador(publicar);
}

async function publicar(traza: Traza): Promise<void> {
  const tareas: Promise<void>[] = [guardarEnBd(traza)];
  if (langfuseConfigurado()) tareas.push(exportarALangfuse(traza));
  const resultados = await Promise.allSettled(tareas);
  const fallo = resultados.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (fallo) throw fallo.reason;
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

async function guardarEnBd(traza: Traza): Promise<void> {
  const ms = (traza.fin ?? Date.now()) - traza.inicio;
  // Un reintento (continuación) suma su tiempo y sus tokens a la traza original y la deja con el
  // estado del último intento: la traza cuenta la historia completa del turno, no solo su final.
  await traza.db.query(
    `INSERT INTO rag.traza
       (id, modulo, nombre, usuario_id, sesion_id, mensaje_id, entrada, salida, estado, error,
        ms, tokens_in, tokens_out, fe_inicio, fe_fin)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13,
             to_timestamp($14 / 1000.0), to_timestamp($15 / 1000.0))
     ON CONFLICT (id) DO UPDATE SET
       mensaje_id = COALESCE(EXCLUDED.mensaje_id, rag.traza.mensaje_id),
       salida = EXCLUDED.salida,
       estado = EXCLUDED.estado,
       error = EXCLUDED.error,
       ms = rag.traza.ms + EXCLUDED.ms,
       tokens_in = rag.traza.tokens_in + EXCLUDED.tokens_in,
       tokens_out = rag.traza.tokens_out + EXCLUDED.tokens_out,
       reintentos = rag.traza.reintentos + 1,
       fe_fin = EXCLUDED.fe_fin`,
    {
      bind: [
        traza.id, traza.modulo, traza.nombre, traza.usuarioId, traza.sesionId, traza.mensajeId,
        json(traza.entrada), json(traza.salida), traza.estado, traza.error,
        ms, traza.tokensIn, traza.tokensOut, traza.inicio, traza.fin ?? Date.now(),
      ],
    },
  );

  const filas = [raizComoPaso(traza), ...traza.pasos].map((p) => ({
    id: p.id,
    padre_id: p.padreId || null,
    nombre: p.nombre,
    tipo: p.tipo,
    fe_inicio: p.inicio,
    ms: p.fin === null ? null : p.fin - p.inicio,
    entrada: p.entrada ?? null,
    salida: p.salida ?? null,
    modelo: p.modelo ?? null,
    tokens_in: p.tokensIn ?? null,
    tokens_out: p.tokensOut ?? null,
    nivel: p.nivel,
    error: p.error ?? null,
  }));
  // Un solo INSERT para todos los pasos: una traza típica trae 8-15.
  await traza.db.query(
    `INSERT INTO rag.traza_paso
       (traza_id, id, padre_id, nombre, tipo, fe_inicio, ms, entrada, salida, modelo, tokens_in,
        tokens_out, nivel, error)
     SELECT $1, x.id, x.padre_id, x.nombre, x.tipo, to_timestamp(x.fe_inicio / 1000.0), x.ms,
            x.entrada, x.salida, x.modelo, x.tokens_in, x.tokens_out, x.nivel, x.error
       FROM jsonb_to_recordset($2::jsonb) AS x(
         id text, padre_id text, nombre text, tipo text, fe_inicio double precision, ms integer,
         entrada jsonb, salida jsonb, modelo text, tokens_in integer, tokens_out integer,
         nivel text, error text)
     ON CONFLICT (traza_id, id) DO NOTHING`,
    { bind: [traza.id, JSON.stringify(filas)] },
  );
}

/** El span raíz de esta ejecución, como un paso más (un reintento queda como segundo raíz). */
function raizComoPaso(traza: Traza): PasoTraza {
  return {
    id: traza.raizId,
    padreId: '',
    nombre: traza.continuacion ? `${traza.nombre} (reintento)` : traza.nombre,
    tipo: 'paso',
    inicio: traza.inicio,
    fin: traza.fin,
    entrada: traza.entrada,
    salida: traza.salida,
    nivel: traza.estado === 'error' ? 'ERROR' : 'DEFAULT',
    error: traza.error ?? undefined,
  };
}

// ── Langfuse (OTLP/HTTP JSON) ────────────────────────────────────────────────

export function langfuseConfigurado(): boolean {
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_HOST);
}

type ValorOtlp = { stringValue: string } | { intValue: string } | { boolValue: boolean };
interface AtributoOtlp { key: string; value: ValorOtlp }

const texto = (key: string, v: unknown): AtributoOtlp[] =>
  v === undefined || v === null ? [] : [{ key, value: { stringValue: typeof v === 'string' ? v : JSON.stringify(v) } }];
const entero = (key: string, v: number | undefined): AtributoOtlp[] =>
  v === undefined ? [] : [{ key, value: { intValue: String(Math.round(v)) } }];
const nanos = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString();

const TIPO_LANGFUSE: Record<PasoTraza['tipo'], string> = {
  paso: 'span',
  recuperacion: 'retriever',
  generacion: 'generation',
  embedding: 'embedding',
  evento: 'event',
};

/**
 * Traza → cuerpo OTLP/JSON con los atributos de Langfuse (trace name, user, session, input/output,
 * tipo de observación, modelo, tokens, nivel). El contexto de la traza se copia en cada span, como
 * pide la guía de ingesta v4 de Langfuse para poder filtrar por él.
 */
export function aOtlp(traza: Traza): unknown {
  const sesion = traza.sesionId !== null ? `${traza.modulo}-${traza.sesionId}` : undefined;
  const contexto: AtributoOtlp[] = [
    ...texto('langfuse.trace.name', traza.nombre),
    ...texto('langfuse.user.id', traza.usuarioId),
    ...texto('langfuse.session.id', sesion),
    ...texto('langfuse.trace.metadata.modulo', traza.modulo),
    ...texto('langfuse.trace.metadata.mensaje_id', traza.mensajeId === null ? undefined : String(traza.mensajeId)),
  ];

  const span = (p: PasoTraza) => ({
    traceId: traza.id,
    spanId: p.id,
    ...(p.padreId ? { parentSpanId: p.padreId } : {}),
    name: p.nombre,
    kind: 1,
    startTimeUnixNano: nanos(p.inicio),
    endTimeUnixNano: nanos(p.fin ?? p.inicio),
    attributes: [
      ...contexto,
      ...texto('langfuse.observation.type', TIPO_LANGFUSE[p.tipo]),
      ...texto('langfuse.observation.input', p.entrada),
      ...texto('langfuse.observation.output', p.salida),
      ...texto('langfuse.observation.level', p.nivel === 'DEFAULT' ? undefined : p.nivel),
      ...texto('langfuse.observation.status_message', p.error),
      ...texto('gen_ai.request.model', p.modelo),
      ...entero('gen_ai.usage.input_tokens', p.tokensIn),
      ...entero('gen_ai.usage.output_tokens', p.tokensOut),
    ],
    status: p.nivel === 'ERROR' ? { code: 2, message: p.error ?? '' } : { code: 0 },
  });

  return {
    resourceSpans: [{
      resource: { attributes: texto('service.name', 'seguimiento-backend') },
      scopeSpans: [{
        scope: { name: 'seguimiento.chat' },
        spans: [raizComoPaso(traza), ...traza.pasos].map(span),
      }],
    }],
  };
}

async function exportarALangfuse(traza: Traza): Promise<void> {
  const host = process.env.LANGFUSE_HOST!.replace(/\/+$/, '');
  const credencial = Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString('base64');
  const abortador = new AbortController();
  const temporizador = setTimeout(() => abortador.abort(), 5000);
  try {
    const r = await fetch(`${host}/api/public/otel/v1/traces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${credencial}`,
        'x-langfuse-ingestion-version': '4',
      },
      body: JSON.stringify(aOtlp(traza)),
      signal: abortador.signal,
    });
    if (!r.ok) throw new Error(`Langfuse HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  } finally {
    clearTimeout(temporizador);
  }
}

export interface PuntajeTraza {
  nombre: string;
  valor: number;
  comentario?: string;
}

/**
 * Puntajes del juez LLM (Fase 5) sobre una traza ya exportada, con la API pública de scores
 * (`POST /api/public/scores`, NUMERIC). Uno por petición: la API no acepta lotes. Sin Langfuse
 * configurado no hace nada; un fallo solo se registra (el veredicto ya quedó en `rag.juicio_turno`).
 */
export async function exportarPuntajesALangfuse(trazaId: string, puntajes: PuntajeTraza[]): Promise<void> {
  if (!langfuseConfigurado()) return;
  const host = process.env.LANGFUSE_HOST!.replace(/\/+$/, '');
  const credencial = Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString('base64');
  for (const p of puntajes) {
    const abortador = new AbortController();
    const temporizador = setTimeout(() => abortador.abort(), 5000);
    try {
      const r = await fetch(`${host}/api/public/scores`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${credencial}` },
        body: JSON.stringify({
          traceId: trazaId, name: `juez.${p.nombre}`, value: p.valor, dataType: 'NUMERIC',
          ...(p.comentario ? { comment: p.comentario.slice(0, 500) } : {}),
        }),
        signal: abortador.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    } catch (e) {
      console.warn(`No se pudo exportar el puntaje ${p.nombre} de la traza ${trazaId} a Langfuse: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(temporizador);
    }
  }
}
