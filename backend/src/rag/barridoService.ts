import { QueryTypes } from 'sequelize';
import { appSequelize } from '../config/appDatabase';
import { DB_SCHEMA, sequelize } from '../config/database';
import { leerBooleano, leerNumero } from './configService';

const S = DB_SCHEMA;

/**
 * Barrido de detección incremental. Ver docs/PLAN-RAG.md §6.
 *
 * **Detecta, no ingesta.** Nunca encola trabajo por su cuenta: por eso dejarlo encendido no
 * cuesta ni un token. Lo que sí hace es mantener al día el estado del corpus para que el panel
 * pueda decir cuánto falta y el usuario decida qué procesar.
 *
 * Tres cedazos, del más barato al más caro (tiempos medidos ✅ sobre la BD real):
 *   1. Watermark por expediente — documentos nuevos y ediciones de metadatos (190 ms)
 *   2. `fe_use_mod` de anexos — anexos añadidos o editados (193 ms)
 *   3. `sha256` en el servidor — archivo reemplazado en silencio (12,3 s / 2,8 GB)
 */

/** Identificador del advisory lock. Impide dos barridos simultáneos. */
const LOCK_ID = 815_243_001;

export type TipoBarrido = 'inventario_inicial' | 'watermark' | 'anexos' | 'hash';
export type DisparoBarrido = 'automatico' | 'manual';

export interface ResultadoBarrido {
  id: number | null;
  tipo: TipoBarrido;
  expedientesRevisados: number;
  documentosNuevos: number;
  documentosCambiados: number;
  documentosBaja: number;
  ms: number;
  omitido?: string;
}

export class BarridoOcupado extends Error {
  constructor() {
    super('Ya hay un barrido en curso');
    this.name = 'BarridoOcupado';
  }
}

// ── Filtro común: qué documentos del SGD entran ─────────────────────────────
//
// ⚠️ `nu_ann_exp` NUNCA es NULL en esta BD: los 306 documentos sin expediente lo tienen como
// cadena VACÍA. Un filtro `IS NOT NULL` los agruparía a todos en un expediente fantasma.
const EXPEDIENTE_REAL = `TRIM(COALESCE(r.nu_ann_exp,'')) <> '' AND TRIM(COALESCE(r.nu_sec_exp,'')) <> ''`;

interface FilaWatermark {
  nu_ann_exp: string;
  nu_sec_exp: string;
  doc_count: string;
  watermark: string;
}

/**
 * Cedazo 1: una sola consulta devuelve el watermark de TODOS los expedientes. Se compara con lo
 * guardado en nuestra BD; si el par (nº de documentos, última modificación) no cambió, el
 * expediente ni se mira. Por eso revisar 1.000 expedientes cuesta una consulta y no 1.000.
 *
 * Se usa `fe_use_mod` y no `fe_emi` porque está poblado al 100 % y se mueve de verdad: el 60 % de
 * los remitos se modifica después de creado ✅.
 */
async function leerWatermarksSgd(): Promise<FilaWatermark[]> {
  return sequelize.query<FilaWatermark>(
    `SELECT r.nu_ann_exp, r.nu_sec_exp,
            count(*)::text AS doc_count,
            max(greatest(r.fe_use_cre, r.fe_use_mod))::text AS watermark
       FROM ${S}.tdtv_remitos r
      WHERE ${EXPEDIENTE_REAL}
        AND COALESCE(r.es_eli,'0') <> '1'
      GROUP BY 1, 2`,
    { type: QueryTypes.SELECT },
  );
}

interface FilaDocumentoSgd {
  nu_ann: string;
  nu_emi: string;
  nu_ann_exp: string | null;
  nu_sec_exp: string | null;
  numero_sgd: string | null;
  titulo: string | null;
  tipo_doc: string | null;
  co_tip_doc: string | null;
  asunto: string | null;
  fe_emi: string | null;
  co_dep_emi: string | null;
  de_dep_emi: string | null;
  es_eli: string | null;
}

/** Documentos de un conjunto de expedientes, con sus metadatos para desnormalizar (D4). */
async function leerDocumentosSgd(claves: { ann: string; sec: string }[]): Promise<FilaDocumentoSgd[]> {
  if (claves.length === 0) return [];

  return sequelize.query<FilaDocumentoSgd>(
    `SELECT r.nu_ann, r.nu_emi, r.nu_ann_exp, r.nu_sec_exp,
            NULLIF(TRIM(res.nu_expediente),'') AS numero_sgd,
            TRIM(CONCAT_WS(' N° ', COALESCE(td.cdoc_desdoc, r.co_tip_doc_adm, 'DOCUMENTO'),
                 res.nu_doc::text)) AS titulo,
            COALESCE(td.cdoc_desdoc, r.co_tip_doc_adm) AS tipo_doc,
            r.co_tip_doc_adm AS co_tip_doc,
            NULLIF(TRIM(r.de_asu),'') AS asunto,
            r.fe_emi::text,
            r.co_dep_emi,
            COALESCE(d.de_sigla, r.co_dep_emi) AS de_dep_emi,
            COALESCE(r.es_eli,'0') AS es_eli
       FROM ${S}.tdtv_remitos r
       LEFT JOIN ${S}.tdtx_remitos_resumen res ON res.nu_ann = r.nu_ann AND res.nu_emi = r.nu_emi
       LEFT JOIN ${S}.si_mae_tipo_doc td ON td.cdoc_tipdoc = r.co_tip_doc_adm
       LEFT JOIN ${S}.rhtm_dependencia d ON d.co_dependencia = r.co_dep_emi
      WHERE (r.nu_ann_exp, r.nu_sec_exp) IN (
              SELECT unnest($1::text[]), unnest($2::text[])
            )`,
    {
      bind: [claves.map((c) => c.ann), claves.map((c) => c.sec)],
      type: QueryTypes.SELECT,
    },
  );
}

/**
 * Ejecuta un barrido de watermark. Es el que corre habitualmente.
 *
 * Idempotente: dos ejecuciones seguidas sin cambios en el SGD reportan 0 nuevos y 0 cambiados.
 */
export async function barrer(
  tipo: TipoBarrido = 'watermark',
  disparo: DisparoBarrido = 'manual',
): Promise<ResultadoBarrido> {
  const inicio = Date.now();

  const bloqueo = await appSequelize.query<{ ok: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS ok',
    { bind: [LOCK_ID], type: QueryTypes.SELECT },
  );
  if (!bloqueo[0]?.ok) throw new BarridoOcupado();

  const [{ id }] = await appSequelize.query<{ id: number }>(
    'INSERT INTO rag.barrido (tipo, disparo) VALUES ($1, $2) RETURNING id',
    { bind: [tipo, disparo], type: QueryTypes.SELECT },
  );

  const conteo = { revisados: 0, nuevos: 0, cambiados: 0, bajas: 0 };

  try {
    const watermarks = await leerWatermarksSgd();
    conteo.revisados = watermarks.length;

    const conocidos = await appSequelize.query<{
      nu_ann_exp: string;
      nu_sec_exp: string;
      doc_count_sgd: number;
      watermark_sgd: string | null;
    }>('SELECT nu_ann_exp, nu_sec_exp, doc_count_sgd, watermark_sgd::text FROM rag.expediente', {
      type: QueryTypes.SELECT,
    });

    const porClave = new Map(
      conocidos.map((c) => [`${c.nu_ann_exp}|${c.nu_sec_exp}`, c]),
    );

    // Diferencia en local: las dos bases están en servidores distintos y no hay JOIN posible (D4).
    const cambiados = watermarks.filter((w) => {
      const previo = porClave.get(`${w.nu_ann_exp}|${w.nu_sec_exp}`);
      if (!previo) return true;
      return (
        Number(previo.doc_count_sgd) !== Number(w.doc_count)
        || String(previo.watermark_sgd ?? '') !== String(w.watermark ?? '')
      );
    });

    // Se procesa por lotes para no traer los metadatos de todo el corpus de una vez.
    const LOTE = 200;
    for (let i = 0; i < cambiados.length; i += LOTE) {
      const lote = cambiados.slice(i, i + LOTE);
      const documentos = await leerDocumentosSgd(
        lote.map((w) => ({ ann: w.nu_ann_exp, sec: w.nu_sec_exp })),
      );

      const resumen = await sincronizarDocumentos(documentos);
      conteo.nuevos += resumen.nuevos;
      conteo.cambiados += resumen.cambiados;
      conteo.bajas += resumen.bajas;

      await actualizarExpedientes(lote, documentos);
      await new Promise((r) => setImmediate(r)); // no monopolizar el event loop
    }

    await appSequelize.query(
      `UPDATE rag.barrido
          SET fe_fin = now(), expedientes_revisados = $2, documentos_nuevos = $3,
              documentos_cambiados = $4, documentos_baja = $5
        WHERE id = $1`,
      {
        bind: [id, conteo.revisados, conteo.nuevos, conteo.cambiados, conteo.bajas],
        type: QueryTypes.UPDATE,
      },
    );

    return {
      id,
      tipo,
      expedientesRevisados: conteo.revisados,
      documentosNuevos: conteo.nuevos,
      documentosCambiados: conteo.cambiados,
      documentosBaja: conteo.bajas,
      ms: Date.now() - inicio,
    };
  } catch (error) {
    await appSequelize.query(
      'UPDATE rag.barrido SET fe_fin = now(), error = $2 WHERE id = $1',
      {
        bind: [id, error instanceof Error ? error.message : 'error desconocido'],
        type: QueryTypes.UPDATE,
      },
    );
    throw error;
  } finally {
    await appSequelize.query('SELECT pg_advisory_unlock($1)', {
      bind: [LOCK_ID],
      type: QueryTypes.SELECT,
    });
  }
}

/**
 * Inserta los documentos nuevos y da de baja los anulados.
 *
 * Un documento que ya existe **no** se vuelve a poner en `pendiente` por un cambio de metadatos:
 * solo se refrescan los campos desnormalizados. Volver a convertirlo por un cambio de asunto
 * sería exactamente el desperdicio que este barrido existe para evitar.
 */
async function sincronizarDocumentos(
  documentos: FilaDocumentoSgd[],
): Promise<{ nuevos: number; cambiados: number; bajas: number }> {
  if (documentos.length === 0) return { nuevos: 0, cambiados: 0, bajas: 0 };

  const vivos = documentos.filter((d) => d.es_eli !== '1');
  const anulados = documentos.filter((d) => d.es_eli === '1');

  let nuevos = 0;
  if (vivos.length > 0) {
    const filas = await appSequelize.query<{ inserted: boolean }>(
      `INSERT INTO rag.documento
         (nu_ann, nu_emi, nu_ane, nu_ann_exp, nu_sec_exp, titulo, tipo_doc, co_tip_doc,
          asunto, fe_emi, co_dep_emi, de_dep_emi)
       SELECT * FROM unnest(
         $1::text[], $2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[],
         $8::text[], $9::text[], $10::timestamptz[], $11::text[], $12::text[])
       ON CONFLICT (nu_ann, nu_emi, nu_ane) DO UPDATE SET
         titulo = EXCLUDED.titulo, tipo_doc = EXCLUDED.tipo_doc, asunto = EXCLUDED.asunto,
         co_tip_doc = EXCLUDED.co_tip_doc,
         fe_emi = EXCLUDED.fe_emi, de_dep_emi = EXCLUDED.de_dep_emi,
         nu_ann_exp = EXCLUDED.nu_ann_exp, nu_sec_exp = EXCLUDED.nu_sec_exp,
         vigente = true
       RETURNING (xmax = 0) AS inserted`,
      {
        bind: [
          vivos.map((d) => d.nu_ann),
          vivos.map((d) => d.nu_emi),
          // 0 = documento principal (centinela; el SGD nunca usa nu_ane=0 para un anexo real).
          // NULL no sirve: en PostgreSQL un UNIQUE trata NULL <> NULL, así que ON CONFLICT nunca
          // coincidiría y cada barrido insertaría un duplicado (ver migración 004).
          vivos.map(() => 0),
          vivos.map((d) => (d.nu_ann_exp?.trim() ? d.nu_ann_exp : null)),
          vivos.map((d) => (d.nu_sec_exp?.trim() ? d.nu_sec_exp : null)),
          vivos.map((d) => d.titulo),
          vivos.map((d) => d.tipo_doc),
          vivos.map((d) => d.co_tip_doc),
          vivos.map((d) => d.asunto),
          vivos.map((d) => d.fe_emi),
          vivos.map((d) => d.co_dep_emi),
          vivos.map((d) => d.de_dep_emi),
        ],
        type: QueryTypes.SELECT,
      },
    );
    nuevos = filas.filter((f) => f.inserted).length;
  }

  // Bajas: un documento anulado tras ingerirse dejaría chunks que el chat seguiría citando como
  // vigentes. En documentos de gobierno eso no es cosmético.
  let bajas = 0;
  if (anulados.length > 0) {
    const filas = await appSequelize.query(
      `UPDATE rag.documento SET vigente = false
        WHERE vigente AND (nu_ann, nu_emi) IN (SELECT unnest($1::text[]), unnest($2::text[]))
        RETURNING id`,
      {
        bind: [anulados.map((d) => d.nu_ann), anulados.map((d) => d.nu_emi)],
        type: QueryTypes.SELECT,
      },
    );
    bajas = filas.length;
  }

  return { nuevos, cambiados: 0, bajas };
}

async function actualizarExpedientes(
  watermarks: FilaWatermark[],
  documentos: FilaDocumentoSgd[],
): Promise<void> {
  if (watermarks.length === 0) return;

  const numeroPorClave = new Map<string, string | null>();
  for (const d of documentos) {
    const clave = `${d.nu_ann_exp}|${d.nu_sec_exp}`;
    if (d.numero_sgd && !numeroPorClave.has(clave)) numeroPorClave.set(clave, d.numero_sgd);
  }

  await appSequelize.query(
    `INSERT INTO rag.expediente
       (nu_ann_exp, nu_sec_exp, numero_sgd, doc_count_sgd, watermark_sgd, fe_ultimo_barrido)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::timestamptz[]),
                  LATERAL (SELECT now()) AS t(fe)
     ON CONFLICT (nu_ann_exp, nu_sec_exp) DO UPDATE SET
       numero_sgd = COALESCE(EXCLUDED.numero_sgd, rag.expediente.numero_sgd),
       doc_count_sgd = EXCLUDED.doc_count_sgd,
       watermark_sgd = EXCLUDED.watermark_sgd,
       fe_ultimo_barrido = now()`,
    {
      bind: [
        watermarks.map((w) => w.nu_ann_exp),
        watermarks.map((w) => w.nu_sec_exp),
        watermarks.map((w) => numeroPorClave.get(`${w.nu_ann_exp}|${w.nu_sec_exp}`) ?? null),
        watermarks.map((w) => Number(w.doc_count)),
        watermarks.map((w) => w.watermark),
      ],
      type: QueryTypes.INSERT,
    },
  );

  await refrescarContadores(watermarks);
}

/** Contadores por expediente: alimentan el `%` del panel sin agregar sobre cientos de miles de chunks. */
async function refrescarContadores(watermarks: FilaWatermark[]): Promise<void> {
  await appSequelize.query(
    `UPDATE rag.expediente e SET
       docs_ingestados = c.ok,
       docs_pendientes = c.pendientes,
       docs_sin_texto  = c.sin_texto
     FROM (
       SELECT d.nu_ann_exp, d.nu_sec_exp,
              count(*) FILTER (WHERE d.estado = 'ok')::int AS ok,
              count(*) FILTER (WHERE d.estado IN ('pendiente','en_proceso','convertido'))::int AS pendientes,
              count(*) FILTER (WHERE d.estado = 'sin_texto')::int AS sin_texto
         FROM rag.documento d
        WHERE d.vigente
          AND (d.nu_ann_exp, d.nu_sec_exp) IN (SELECT unnest($1::text[]), unnest($2::text[]))
        GROUP BY 1, 2
     ) c
     WHERE e.nu_ann_exp = c.nu_ann_exp AND e.nu_sec_exp = c.nu_sec_exp`,
    {
      bind: [watermarks.map((w) => w.nu_ann_exp), watermarks.map((w) => w.nu_sec_exp)],
      type: QueryTypes.UPDATE,
    },
  );
}

// ── Planificador ─────────────────────────────────────────────────────────────

let temporizador: NodeJS.Timeout | null = null;

/**
 * Arranca el planificador. Siempre corre; el interruptor se consulta en **cada tick**, así que
 * encenderlo o apagarlo surte efecto sin reiniciar el contenedor, con un tick de retardo como
 * máximo.
 */
export function iniciarPlanificadorBarrido(): void {
  if (temporizador) return;

  const tick = async () => {
    try {
      if (!(await leerBooleano('rag.barrido.activo'))) return;

      const cadencia = await leerNumero('rag.barrido.cadencia_min', 15);
      const ultimo = await appSequelize.query<{ minutos: number | null }>(
        `SELECT EXTRACT(EPOCH FROM (now() - max(fe_inicio)))/60 AS minutos
           FROM rag.barrido WHERE tipo IN ('watermark','inventario_inicial')`,
        { type: QueryTypes.SELECT },
      );

      const minutos = ultimo[0]?.minutos;
      if (minutos !== null && minutos !== undefined && minutos < cadencia) return;

      const primero = await esInventarioInicial();
      const resultado = await barrer(primero ? 'inventario_inicial' : 'watermark', 'automatico');
      console.log(
        `Barrido ${resultado.tipo}: ${resultado.expedientesRevisados} expedientes, `
          + `${resultado.documentosNuevos} nuevos, ${resultado.documentosBaja} bajas, ${resultado.ms} ms`,
      );
    } catch (error) {
      if (error instanceof BarridoOcupado) return; // otro barrido en curso: normal
      console.error('Barrido automático falló:', error);
    }
  };

  // Se comprueba cada minuto; la cadencia real la decide `rag.barrido.cadencia_min`.
  temporizador = setInterval(() => void tick(), 60_000);
  temporizador.unref();
}

export async function esInventarioInicial(): Promise<boolean> {
  const filas = await appSequelize.query<{ n: string }>(
    'SELECT count(*) AS n FROM rag.expediente',
    { type: QueryTypes.SELECT },
  );
  return Number(filas[0]?.n ?? 0) === 0;
}
