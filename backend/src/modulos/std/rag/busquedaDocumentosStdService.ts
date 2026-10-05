import { QueryTypes } from 'sequelize';
import { stdRagSequelize } from '../config/stdRagDatabase';
import {
  claveCandidato,
  combinarCandidatos,
  condicionContiene as contiene,
  etiquetaCoincidencia,
  prepararTerminos,
  RE_FECHA,
  terminosDelPlan,
  type CandidatoBusqueda,
  type FilaHit,
  type ParametrosBusqueda,
  type ResumenBusqueda,
} from '../../../compartido/rag/busquedaTerminos';
import type { PlanConsulta } from '../../../compartido/rag/planificadorService';
import { estadoVivoDocumentosStd } from '../services/stdConsultasService';

/**
 * Búsqueda de DOCUMENTOS del STD para el chat (docs/PLAN-CHAT-CONSULTAS.md, Fase 7) — la misma
 * lógica que la búsqueda de expedientes del SGD (`compartido/rag/busquedaTerminos`: dos niveles,
 * IDF, sinónimos, frases estándar, "juntos"), con la unidad = documento STD:
 *
 * - Metadatos: `rag.documento_std.tsv_meta` (asunto, remitente y su entidad, número, tipo,
 *   contrato en `etiquetas`, área de origen), una fila por documento. Cubre los 60 mil documentos.
 * - Contenido: `rag.chunk` de sus archivos. Hoy solo ~2 % de los adjuntos está convertido, así que
 *   en el STD el nivel 1 (metadatos) carga casi todo el peso.
 * - Candidatos con la forma común: `a` = N° STD, `s` = '' (clave "48683|").
 * - Sin filtro de permisos: el módulo STD completo es solo para administradores (como el chat STD
 *   de siempre); los confidenciales se indexan igual (decisión del plan RAG del STD).
 */

export type CandidatoDocumentoStd = CandidatoBusqueda;

export interface ResultadoBusquedaStd extends ResumenBusqueda {
  candidatos: CandidatoDocumentoStd[];
}

const claveDoc = (id: number | string) => claveCandidato(String(id), '');
export const idDeCandidato = (c: Pick<CandidatoBusqueda, 'a'>) => Number(c.a);

async function hitsMetadatos(consultas: string[]): Promise<FilaHit[]> {
  const filas = await stdRagSequelize.query<{ i: string; id: string }>(
    `SELECT t.i::text AS i, ds.id_documento::text AS id
       FROM unnest($1::text[]) WITH ORDINALITY AS t(termino, i)
      CROSS JOIN LATERAL rag.tsq_alternativas(t.termino) AS q
       JOIN rag.documento_std ds ON ds.tsv_meta @@ q`,
    { bind: [consultas], type: QueryTypes.SELECT },
  );
  return filas.map((f) => ({ i: f.i, k: claveDoc(f.id), docs: 1 }));
}

async function hitsContenido(consultas: string[], exclusiones: string[]): Promise<FilaHit[]> {
  // Fragmentos DISTINTOS por documento: un mismo archivo suele estar enlazado varias veces en el
  // mismo documento (principal y anexo, varias derivaciones) y contaría doble.
  const filas = await stdRagSequelize.query<{ i: string; id: string; n: number }>(
    `SELECT t.i::text AS i, d.id_documento::text AS id, count(DISTINCT c.id)::int AS n
       FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS t(termino, excl, i)
      CROSS JOIN LATERAL (SELECT rag.tsq_alternativas(t.termino) AS q,
                                 rag.tsq_frases(NULLIF(t.excl, '')) AS x) z
       JOIN rag.chunk c ON c.tsv @@ z.q
       JOIN rag.documento d ON d.contenido_sha256 = c.sha256 AND d.vigente
      WHERE NOT coalesce(c.tsv @@ z.x, false)
      GROUP BY 1, 2`,
    { bind: [consultas, exclusiones], type: QueryTypes.SELECT },
  );
  return filas.map((f) => ({ i: f.i, k: claveDoc(f.id), docs: Number(f.n) }));
}

async function hitsJuntos(consultas: string[], exclusiones: string[]): Promise<Map<string, number>> {
  const resultado = new Map<string, number>();
  if (consultas.length < 2) return resultado;
  const filas = await stdRagSequelize.query<{ id: string; n: number }>(
    `WITH t AS (SELECT rag.tsq_alternativas(x) AS q FROM unnest($1::text[]) AS x),
          todos AS (SELECT string_agg('(' || q::text || ')', ' & ')::tsquery AS q, bool_and(q IS NOT NULL) AS ok FROM t)
     SELECT d.id_documento::text AS id, count(DISTINCT c.id)::int AS n
       FROM todos
      CROSS JOIN LATERAL (SELECT rag.tsq_frases(NULLIF($2, '')) AS x) z
       JOIN rag.chunk c ON c.tsv @@ todos.q
       JOIN rag.documento d ON d.contenido_sha256 = c.sha256 AND d.vigente
      WHERE todos.ok AND NOT coalesce(c.tsv @@ z.x, false)
      GROUP BY 1`,
    { bind: [consultas, exclusiones.filter(Boolean).join('|')], type: QueryTypes.SELECT },
  );
  for (const f of filas) resultado.set(claveDoc(f.id), Number(f.n));
  return resultado;
}

async function documentosConFiltro(condicionSql: string, binds: unknown[]): Promise<Set<string>> {
  const filas = await stdRagSequelize.query<{ id: string }>(
    `SELECT ds.id_documento::text AS id FROM rag.documento_std ds WHERE ${condicionSql}`,
    { bind: binds, type: QueryTypes.SELECT },
  );
  return new Set(filas.map((f) => claveDoc(f.id)));
}

/**
 * Filtros del plan sobre `rag.documento_std`. En el STD el remitente de un documento interno es
 * quien lo firma, así que "emitido por X" y "remitido por X" miran la misma columna; la dependencia
 * es el área (sigla - nombre) que originó el primer movimiento.
 */
async function aplicarFiltros(plan: PlanConsulta): Promise<{ permitidos: Set<string> | null; remitentes: Set<string> | null }> {
  const f = plan.filtros;
  const conjuntos: Set<string>[] = [];
  let remitentes: Set<string> | null = null;
  const persona = (n: number) => `(${contiene('ds.remitente', n)} OR ${contiene('ds.remitente_entidad', n)})`;

  if (f.remitente) {
    remitentes = await documentosConFiltro(persona(1), [f.remitente]);
    conjuntos.push(remitentes);
  }
  if (f.emisor) conjuntos.push(await documentosConFiltro(`${persona(1)} OR ${contiene('ds.area_origen', 1)}`, [f.emisor]));
  if (f.dependencia) conjuntos.push(await documentosConFiltro(contiene('ds.area_origen', 1), [f.dependencia]));
  if (f.tipoDoc) conjuntos.push(await documentosConFiltro(contiene('ds.tipo_doc', 1), [f.tipoDoc]));
  const desde = f.desde && RE_FECHA.test(f.desde) ? f.desde : null;
  const hasta = f.hasta && RE_FECHA.test(f.hasta) ? f.hasta : null;
  if (desde || hasta) {
    conjuntos.push(await documentosConFiltro(
      '($1::date IS NULL OR ds.fecha >= $1::date) AND ($2::date IS NULL OR ds.fecha <= $2::date)', [desde, hasta],
    ));
  }

  if (conjuntos.length === 0) return { permitidos: null, remitentes };
  const [primero, ...resto] = conjuntos;
  return { permitidos: new Set([...primero].filter((k) => resto.every((c) => c.has(k)))), remitentes };
}

export async function buscarDocumentosStdPorPlan(
  plan: PlanConsulta,
  parametros: ParametrosBusqueda,
  opciones: { dentroDe?: number[]; soloActuales?: boolean } = {},
): Promise<ResultadoBusquedaStd> {
  const terminos = terminosDelPlan(plan);
  const preparados = prepararTerminos(terminos, plan, parametros);
  const hayFiltros = Boolean(plan.filtros.remitente || plan.filtros.emisor || plan.filtros.dependencia
    || plan.filtros.tipoDoc || plan.filtros.desde || plan.filtros.hasta);

  const vacio: ResultadoBusquedaStd = {
    candidatos: [], total: 0, nivel1: 0, nivel2: 0, modoTerminos: 'todos', terminos,
    consultas: preparados.consultas, sinExpediente: 0, truncado: false,
  };
  if (terminos.length === 0 && !hayFiltros) return vacio;

  const [meta, contenido, juntos, filtros, universo] = await Promise.all([
    terminos.length > 0 ? hitsMetadatos(preparados.consultas) : Promise.resolve([]),
    terminos.length > 0 ? hitsContenido(preparados.consultas, preparados.exclusiones) : Promise.resolve([]),
    hitsJuntos(preparados.consultas, preparados.exclusiones),
    aplicarFiltros(plan),
    stdRagSequelize.query<{ n: number }>('SELECT count(*)::int AS n FROM rag.documento_std', { type: QueryTypes.SELECT }),
  ]);

  const dentroDe = opciones.dentroDe ? new Set(opciones.dentroDe.map(claveDoc)) : null;
  const combinados = combinarCandidatos(
    terminos.length, meta, contenido, filtros.permitidos, filtros.remitentes, parametros, dentroDe,
    Number(universo[0]?.n ?? 0), juntos,
  );
  let candidatos = combinados.candidatos;
  // Sin términos (solo filtros), el orden común es por clave descendente como texto; en el STD el
  // N° más alto es el más reciente, así que se ordena numéricamente.
  if (combinados.modo === 'sin_terminos') candidatos = [...candidatos].sort((x, y) => idDeCandidato(y) - idDeCandidato(x));

  if (opciones.soloActuales && candidatos.length > 0) {
    candidatos = candidatos.slice(0, parametros.maxCandidatos);
    const estados = await estadoVivoDocumentosStd(candidatos.map(idDeCandidato), parametros.mesesActual);
    candidatos = candidatos.filter((c) => estados.get(idDeCandidato(c))?.actual);
  }

  const nivel1 = candidatos.filter((c) => c.n === 1).length;
  return {
    candidatos: candidatos.slice(0, parametros.maxCandidatos),
    total: candidatos.length,
    nivel1,
    nivel2: candidatos.length - nivel1,
    modoTerminos: combinados.modo,
    terminos,
    consultas: preparados.consultas,
    sinExpediente: 0,
    truncado: candidatos.length > parametros.maxCandidatos,
  };
}

// ── Detalle de una página ───────────────────────────────────────────────────────────────────────

/**
 * Fila de la tabla del chat STD. Lleva los campos comunes de cualquier fila del chat (asunto,
 * origen, estado…, ver `frontend/src/api/chatComun.ts`) más la identidad del STD.
 */
export interface FilaDocumentoStdChat {
  idDocumento: number;
  /** Número formal ("001-2020-MINEDU/…"). */
  documento: string | null;
  tipoDoc: string | null;
  /** AAAA-MM-DD del documento. */
  fecha: string | null;
  etiquetas: string | null;
  /** Adjunto principal (para abrirlo en el visor), si es PDF. */
  idAdjunto: number | null;
  asunto: string | null;
  /** Remitente (y su entidad); en un documento interno, quien lo firma. */
  origen: string | null;
  remitentes: string[];
  /** Archivos PDF del documento. */
  documentos: number;
  ultimoMovimiento: string | null;
  dependenciaActual: string | null;
  archivado: boolean;
  feArchivo: string | null;
  nivel: 1 | 2;
  coincidencia: string;
}

export async function detallePaginaStd(
  candidatos: CandidatoDocumentoStd[],
  terminos: string[],
  mesesActual: number,
): Promise<FilaDocumentoStdChat[]> {
  if (candidatos.length === 0) return [];
  const ids = candidatos.map(idDeCandidato);

  const [filas, estados] = await Promise.all([
    stdRagSequelize.query<{
      id: string; documento: string | null; tipo_doc: string | null; fecha: string | null; etiquetas: string | null;
      asunto: string | null; remitente: string | null; entidad: string | null; area: string | null;
      adjuntos: number; id_adjunto: string | null;
    }>(
      `SELECT ds.id_documento::text AS id, ds.documento, ds.tipo_doc, to_char(ds.fecha, 'YYYY-MM-DD') AS fecha,
              ds.etiquetas, ds.asunto, ds.remitente, ds.remitente_entidad AS entidad, ds.area_origen AS area,
              ds.adjuntos_pdf_std AS adjuntos,
              (SELECT d.id_adjunto::text FROM rag.documento d
                WHERE d.id_documento = ds.id_documento AND d.origen = 'principal' AND d.vigente
                LIMIT 1) AS id_adjunto
         FROM rag.documento_std ds
        WHERE ds.id_documento = ANY($1::bigint[])`,
      { bind: [ids], type: QueryTypes.SELECT },
    ),
    estadoVivoDocumentosStd(ids, mesesActual).catch(() => new Map()),
  ]);

  const porId = new Map(filas.map((f) => [Number(f.id), f]));
  return candidatos.map((c) => {
    const id = idDeCandidato(c);
    const f = porId.get(id);
    const e = estados.get(id);
    const remitente = f?.remitente ?? null;
    const entidad = f?.entidad && f.entidad !== remitente ? f.entidad : null;
    return {
      idDocumento: id,
      documento: f?.documento ?? null,
      tipoDoc: f?.tipo_doc ?? null,
      fecha: f?.fecha ?? null,
      etiquetas: f?.etiquetas ?? null,
      idAdjunto: f?.id_adjunto ? Number(f.id_adjunto) : null,
      asunto: f?.asunto?.replace(/\s+/g, ' ').trim() ?? null,
      origen: [remitente, entidad].filter(Boolean).join(' · ') || f?.area || null,
      remitentes: [],
      documentos: Number(f?.adjuntos ?? 0),
      ultimoMovimiento: e?.ultimoMovimiento ?? null,
      dependenciaActual: e?.areaActual ?? null,
      archivado: e?.archivado ?? false,
      feArchivo: e?.feArchivo ?? null,
      nivel: c.n,
      coincidencia: etiquetaCoincidencia(c, terminos),
    };
  });
}

/** Fecha de cada documento (para elegir "el último"). */
export async function fechasDocumentosStd(ids: number[]): Promise<Map<number, string | null>> {
  if (ids.length === 0) return new Map();
  const filas = await stdRagSequelize.query<{ id: string; fecha: string | null }>(
    `SELECT id_documento::text AS id, to_char(fecha, 'YYYY-MM-DD') AS fecha
       FROM rag.documento_std WHERE id_documento = ANY($1::bigint[])`,
    { bind: [ids], type: QueryTypes.SELECT },
  );
  return new Map(filas.map((f) => [Number(f.id), f.fecha]));
}
