import { QueryTypes } from 'sequelize';
import { stdRagSequelize } from '../config/stdRagDatabase';
import {
  leerParametros,
  planConFiltros,
  terminosDelPlan,
  terminosExplicitos,
  type CandidatoBusqueda,
} from '../../../compartido/rag/busquedaTerminos';
import type { PlanConsulta } from '../../../compartido/rag/planificadorService';
import { nombresDeContratos, type NombreContrato } from '../../sgd/rag/consultasExpedienteService';
import { agruparPorContrato, textoGrupos, type GrupoObra } from '../../sgd/rag/respuestasEstructuradasService';
import { movimientosDocumentosStd, type MovimientoStd } from '../services/stdConsultasService';
import {
  buscarDocumentosStdPorPlan,
  detallePaginaStd,
  fechasDocumentosStd,
  idDeCandidato,
  type CandidatoDocumentoStd,
} from './busquedaDocumentosStdService';
import type { MetaListadoStd } from './listadoChatStdService';

/**
 * Respuestas `ultimo_documento`, `participantes` y `agrupar` del chat STD, sin modelo de respuesta
 * (docs/PLAN-CHAT-CONSULTAS.md, Fase 7). Mismas respuestas que el SGD con la unidad = documento STD:
 *
 * - Las tarjetas usan las MISMAS formas que el SGD (las pinta el mismo componente del frontend); la
 *   referencia a la unidad va en `nuAnnExp` = N° STD (`nuSecExp` = null) y el archivo a abrir en
 *   `nuEmi` = id del adjunto principal. El adaptador STD del frontend las interpreta así.
 * - "Indicaciones" del STD = observaciones de cada derivación (`tbl_documento_mov.observaciones`),
 *   leídas en vivo de MariaDB junto con la acción y el estado.
 * - Agrupar: el STD guarda el contrato del documento en `etiquetas`; el nombre del proyecto se toma
 *   del corpus del SGD (mismos contratos MCEBS de la UE118), porque del STD hay muy poco contenido
 *   convertido (~2 %).
 */

const MAX_DOCUMENTOS = 200;
const MAX_TRAMITES = 5;
const MAX_MOVIMIENTOS_TARJETA = 15;
const MAX_AGRUPAR_STD = 60;
const TOPE_PARTICIPANTES = 25;

export interface ReferenciaStd { nuAnnExp: string; nuSecExp: null; numeroExpediente: string }
const referencia = (id: number): ReferenciaStd => ({ nuAnnExp: String(id), nuSecExp: null, numeroExpediente: `STD ${id}` });

interface Objetivo {
  ids: number[];
  candidatos: CandidatoDocumentoStd[];
  total: number;
  terminos: string[];
  ambito: 'documento' | 'busqueda' | 'conjunto';
  fueraDelConjunto?: boolean;
}

export interface OpcionesObjetivoStd {
  idDocumento?: number;
  conjunto?: number[] | null;
}

const candidatoSimple = (id: number): CandidatoBusqueda => ({ a: String(id), s: '', n: 1, dm: 0, dc: 0, r: false, t: 0, bm: 0, bc: 0 });

async function documentosObjetivo(plan: PlanConsulta, op: OpcionesObjetivoStd): Promise<Objetivo | null> {
  const terminos = terminosDelPlan(plan);
  if (op.idDocumento) {
    return { ids: [op.idDocumento], candidatos: [candidatoSimple(op.idDocumento)], total: 1, terminos, ambito: 'documento' };
  }
  // "¿Y el último (de esos)?" sin términos ni filtros propios: el listado anterior tal cual.
  const conjuntoDirecto = (): Objetivo | null => {
    if (!op.conjunto || op.conjunto.length === 0) return null;
    const ids = op.conjunto.slice(0, MAX_DOCUMENTOS);
    return { ids, candidatos: ids.map(candidatoSimple), total: op.conjunto.length, terminos: [], ambito: 'conjunto' };
  };
  if (terminosExplicitos(plan).length === 0 && !planConFiltros(plan) && conjuntoDirecto()) return conjuntoDirecto();

  const parametros = await leerParametros(stdRagSequelize);
  const desde = (r: Awaited<ReturnType<typeof buscarDocumentosStdPorPlan>>, fueraDelConjunto: boolean): Objetivo => ({
    ids: r.candidatos.slice(0, MAX_DOCUMENTOS).map(idDeCandidato),
    candidatos: r.candidatos.slice(0, MAX_DOCUMENTOS),
    total: r.total,
    terminos: r.terminos,
    ambito: 'busqueda',
    fueraDelConjunto,
  });

  const r = await buscarDocumentosStdPorPlan(plan, parametros, { dentroDe: op.conjunto ?? undefined, soloActuales: plan.filtros.actual });
  if (r.total > 0) return desde(r, false);
  if (op.conjunto && op.conjunto.length > 0 && r.terminos.length > 0) {
    const global = await buscarDocumentosStdPorPlan(plan, parametros, { soloActuales: plan.filtros.actual });
    if (global.total > 0) return desde(global, true);
  }
  if (r.terminos.length === 0) return conjuntoDirecto();
  return null;
}

const comillas = (terminos: string[]) => terminos.map((t) => `«${t}»`).join(' + ');
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
const fecha = (iso: string | null) => {
  if (!iso) return 's/f';
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
};

type ObjetivoTexto = Pick<Objetivo, 'total' | 'terminos' | 'ambito' | 'fueraDelConjunto'>;

function fraseAmbito(o: ObjetivoTexto): string {
  if (o.ambito === 'documento') return 'en este documento';
  if (o.ambito === 'conjunto') return `entre los ${plural(o.total, 'documento', 'documentos')} del listado anterior`;
  const sobre = o.terminos.length > 0 ? ` relacionados con ${comillas(o.terminos)}` : '';
  const aviso = o.fueraDelConjunto ? ' de toda la base (ninguno del listado anterior cumplía)' : '';
  return `entre ${o.total === 1 ? 'el documento' : `los ${o.total} documentos`}${sobre}${aviso}`;
}

// ── Último documento ────────────────────────────────────────────────────────────────────────────

/** Misma forma que `TarjetaDocumento` del SGD (ver la cabecera). */
export interface DocumentoStdTarjeta extends ReferenciaStd {
  nuAnn: string;
  nuEmi: string;
  titulo: string | null;
  asunto: string | null;
  fecha: string | null;
  emisor: string | null;
  remitente: string | null;
  terminosCoinciden: number;
}

export interface IndicacionStd {
  destino: string | null;
  persona: string | null;
  tramite: string | null;
  indicacion: string | null;
  estado: string | null;
  fecha: string | null;
}

export interface TarjetaDocumentoStd extends DocumentoStdTarjeta {
  totalTerminos: number;
  indicaciones: IndicacionStd[];
  anteriores: DocumentoStdTarjeta[];
}

export interface RespuestaUltimoDocumentoStd {
  texto: string;
  documento: TarjetaDocumentoStd;
  meta: { version: 1; kind: 'documento'; plan: PlanConsulta; documento: TarjetaDocumentoStd };
}

/**
 * "El último documento de X": entre los candidatos que cumplen más términos, primero los que los
 * tienen todos en sus datos (nivel 1) o juntos en un fragmento, y luego el más reciente — el mismo
 * criterio que el SGD (Fase 6). Pura: se prueba sin BD.
 */
export function ordenarParaUltimo(candidatos: CandidatoDocumentoStd[], fechas: Map<number, string | null>): CandidatoDocumentoStd[] {
  const fuerte = (c: CandidatoDocumentoStd) => (c.n === 1 || (c.j ?? 0) > 0 ? 1 : 0);
  return [...candidatos].sort((x, y) =>
    y.t - x.t
    || fuerte(y) - fuerte(x)
    || (fechas.get(idDeCandidato(y)) ?? '').localeCompare(fechas.get(idDeCandidato(x)) ?? '')
    || idDeCandidato(y) - idDeCandidato(x));
}

export function textoUltimoDocumentoStd(o: ObjetivoTexto, d: TarjetaDocumentoStd): string {
  if (o.ambito === 'documento') {
    return `${d.titulo ?? 'El documento'} (STD ${d.nuAnnExp}) es del ${fecha(d.fecha)}; abajo, sus derivaciones con las observaciones de cada una.`;
  }
  const parcial = d.totalTerminos > 0 && d.terminosCoinciden < d.totalTerminos
    ? ` Ojo: no cumple todos los términos (${d.terminosCoinciden} de ${d.totalTerminos}).`
    : '';
  return `El documento más reciente ${fraseAmbito(o)} es ${d.titulo ?? 'un documento'} (STD ${d.nuAnnExp}) del ${fecha(d.fecha)}.${parcial}`;
}

const indicacionDesde = (m: MovimientoStd): IndicacionStd => ({
  destino: m.area_destino,
  persona: m.destino,
  tramite: m.accion,
  indicacion: m.observacion,
  estado: m.estado,
  fecha: m.fecha,
});

export async function ejecutarUltimoDocumentoStd(plan: PlanConsulta, op: OpcionesObjetivoStd): Promise<RespuestaUltimoDocumentoStd | null> {
  const objetivo = await documentosObjetivo(plan, op);
  if (!objetivo) return null;

  const fechas = await fechasDocumentosStd(objetivo.ids);
  const ordenados = ordenarParaUltimo(objetivo.candidatos, fechas).slice(0, 4);
  const filas = await detallePaginaStd(ordenados, objetivo.terminos, 3);
  if (filas.length === 0) return null;
  const movimientos = await movimientosDocumentosStd([filas[0].idDocumento]);

  const aTarjeta = (f: (typeof filas)[number], c: CandidatoDocumentoStd): DocumentoStdTarjeta => ({
    ...referencia(f.idDocumento),
    nuAnn: 'STD',
    nuEmi: f.idAdjunto ? String(f.idAdjunto) : '',
    titulo: [f.tipoDoc, f.documento].filter(Boolean).join(' ') || null,
    asunto: f.asunto,
    fecha: f.fecha,
    emisor: null,
    remitente: f.origen,
    terminosCoinciden: c.t,
  });
  const documento: TarjetaDocumentoStd = {
    ...aTarjeta(filas[0], ordenados[0]),
    totalTerminos: objetivo.terminos.length,
    indicaciones: movimientos.slice(-MAX_MOVIMIENTOS_TARJETA).map(indicacionDesde),
    anteriores: filas.slice(1).map((f, i) => aTarjeta(f, ordenados[i + 1])),
  };
  return {
    texto: textoUltimoDocumentoStd(objetivo, documento),
    documento,
    meta: { version: 1, kind: 'documento', plan, documento },
  };
}

// ── Participantes ───────────────────────────────────────────────────────────────────────────────

export interface MovimientoChatStd {
  fecha: string | null;
  documento: string | null;
  emisor: string | null;
  destino: string | null;
  persona: string | null;
  tramite: string | null;
  indicacion: string | null;
  estado: string | null;
}

/** Misma forma que `BloqueParticipantes` del SGD; aquí "expedientes" cuenta documentos STD. */
export interface BloqueParticipantesStd {
  totalExpedientes: number;
  remitentes: { nombre: string; documento: string | null; documentos: number; expedientes: number }[];
  emisores: { dependencia: string | null; empleado: string | null; documentos: number; expedientes: number }[];
  destinatarios: { dependencia: string | null; persona: string | null; veces: number; expedientes: number }[];
  tramites: (ReferenciaStd & { movimientos: MovimientoChatStd[] })[];
}

export interface RespuestaParticipantesStd {
  texto: string;
  participantes: BloqueParticipantesStd;
  meta: { version: 1; kind: 'participantes'; plan: PlanConsulta; participantes: BloqueParticipantesStd };
}

/**
 * Agrupa los movimientos en quién derivó (emisores) y a quién (destinatarios). Pura: se prueba sin
 * BD. `documentos` de un emisor = derivaciones que hizo; `expedientes` = documentos STD distintos.
 */
export function agruparMovimientos(movs: MovimientoStd[]): Pick<BloqueParticipantesStd, 'emisores' | 'destinatarios'> {
  const emisores = new Map<string, { dependencia: string | null; empleado: string | null; documentos: number; docs: Set<number> }>();
  const destinatarios = new Map<string, { dependencia: string | null; persona: string | null; veces: number; docs: Set<number> }>();
  for (const m of movs) {
    if (m.origen || m.area_origen) {
      const k = `${m.area_origen ?? ''}|${m.origen ?? ''}`;
      const e = emisores.get(k) ?? { dependencia: m.area_origen, empleado: m.origen, documentos: 0, docs: new Set<number>() };
      e.documentos++;
      e.docs.add(Number(m.id_documento));
      emisores.set(k, e);
    }
    if (m.destino || m.area_destino) {
      const k = `${m.area_destino ?? ''}|${m.destino ?? ''}`;
      const d = destinatarios.get(k) ?? { dependencia: m.area_destino, persona: m.destino, veces: 0, docs: new Set<number>() };
      d.veces++;
      d.docs.add(Number(m.id_documento));
      destinatarios.set(k, d);
    }
  }
  const porDocs = <T extends { docs: Set<number> }>(a: T, b: T) => b.docs.size - a.docs.size;
  return {
    emisores: [...emisores.values()].sort((a, b) => porDocs(a, b) || b.documentos - a.documentos).slice(0, TOPE_PARTICIPANTES)
      .map(({ docs, ...e }) => ({ ...e, expedientes: docs.size })),
    destinatarios: [...destinatarios.values()].sort((a, b) => porDocs(a, b) || b.veces - a.veces).slice(0, TOPE_PARTICIPANTES)
      .map(({ docs, ...d }) => ({ ...d, expedientes: docs.size })),
  };
}

export function textoParticipantesStd(o: ObjetivoTexto, b: BloqueParticipantesStd): string {
  const tope = o.total > MAX_DOCUMENTOS ? ` (sobre los ${MAX_DOCUMENTOS} más relevantes)` : '';
  return `Participantes ${fraseAmbito(o)}${tope}: ${plural(b.remitentes.length, 'remitente', 'remitentes')}, `
    + `${plural(b.emisores.length, 'persona o área que derivó', 'personas o áreas que derivaron')} y `
    + `${plural(b.destinatarios.length, 'destinatario', 'destinatarios')}. Abajo, el trámite con las observaciones de `
    + `${plural(b.tramites.length, 'documento', 'documentos')}.`;
}

export async function ejecutarParticipantesStd(plan: PlanConsulta, op: OpcionesObjetivoStd): Promise<RespuestaParticipantesStd | null> {
  const objetivo = await documentosObjetivo(plan, op);
  if (!objetivo) return null;

  const [remitentes, movs] = await Promise.all([
    stdRagSequelize.query<{ nombre: string; entidad: string | null; n: number }>(
      `SELECT remitente AS nombre, max(remitente_entidad) AS entidad, count(*)::int AS n
         FROM rag.documento_std
        WHERE id_documento = ANY($1::bigint[]) AND remitente IS NOT NULL
        GROUP BY remitente ORDER BY 3 DESC LIMIT $2`,
      { bind: [objetivo.ids, TOPE_PARTICIPANTES], type: QueryTypes.SELECT },
    ),
    movimientosDocumentosStd(objetivo.ids),
  ]);

  const { emisores, destinatarios } = agruparMovimientos(movs);
  const tramites = objetivo.ids.slice(0, MAX_TRAMITES).map((id) => ({
    ...referencia(id),
    movimientos: movs.filter((m) => Number(m.id_documento) === id).map((m) => ({
      fecha: m.fecha,
      documento: null,
      emisor: [m.area_origen, m.origen].filter(Boolean).join(' · ') || null,
      destino: m.area_destino,
      persona: m.destino,
      tramite: m.accion,
      indicacion: m.observacion,
      estado: m.estado,
    })),
  })).filter((t) => t.movimientos.length > 0);

  const participantes: BloqueParticipantesStd = {
    totalExpedientes: objetivo.total,
    remitentes: remitentes.map((r) => ({
      nombre: r.nombre, documento: r.entidad && r.entidad !== r.nombre ? r.entidad : null,
      documentos: Number(r.n), expedientes: Number(r.n),
    })),
    emisores,
    destinatarios,
    tramites,
  };
  return {
    texto: textoParticipantesStd(objetivo, participantes),
    participantes,
    meta: { version: 1, kind: 'participantes', plan, participantes },
  };
}

// ── Agrupar por contrato ────────────────────────────────────────────────────────────────────────

/** "Contrato N° 341-2025-MCEBS" en el asunto, cuando el documento no tiene `etiquetas`. */
const RE_CONTRATO_ASUNTO = /contrato\s+n?[°º.o]*\s*(\d{1,4}\s*-\s*\d{4}\s*-\s*[a-z]+)/i;

/** "0315 - 2025-mcebs" → "315-2025-MCEBS" (igual que la normalización del SGD). Pura. */
export function normalizarContratoStd(texto: string | null): string | null {
  if (!texto) return null;
  const m = texto.match(/(\d{1,4})\s*-\s*(\d{4})\s*-\s*([a-z]+)/i);
  if (!m) return null;
  return `${String(Number(m[1]))}-${m[2]}-${m[3].toUpperCase()}`;
}

export async function agruparPorObraStd(meta: MetaListadoStd): Promise<{ texto: string; grupos: GrupoObra[]; agrupados: number; soloDirectos: boolean }> {
  const directos = meta.documentos.filter((c) => c.n === 1);
  const soloDirectos = directos.length > 0;
  const elegidos = (soloDirectos ? directos : meta.documentos).slice(0, MAX_AGRUPAR_STD);
  const ids = elegidos.map(idDeCandidato);

  const [filas, datos] = await Promise.all([
    detallePaginaStd(elegidos, meta.busqueda.terminos, (await leerParametros(stdRagSequelize)).mesesActual),
    stdRagSequelize.query<{ id: string; etiquetas: string | null; asunto: string | null }>(
      'SELECT id_documento::text AS id, etiquetas, asunto FROM rag.documento_std WHERE id_documento = ANY($1::bigint[])',
      { bind: [ids], type: QueryTypes.SELECT },
    ),
  ]);

  const contratos = new Map<string, string[]>();
  for (const d of datos) {
    const c = normalizarContratoStd(d.etiquetas) ?? normalizarContratoStd(d.asunto?.match(RE_CONTRATO_ASUNTO)?.[1] ?? null);
    if (c) contratos.set(`${d.id}|`, [c]);
  }
  const principales = [...new Set([...contratos.values()].map((l) => l[0]))].slice(0, 30);
  const nombres = await nombresDeContratos(principales).catch(() => new Map<string, NombreContrato>());

  const grupos = agruparPorContrato(
    filas.map((f) => ({
      nuAnnExp: String(f.idDocumento), nuSecExp: '', numeroExpediente: `STD ${f.idDocumento}`,
      archivado: f.archivado, ultimoMovimiento: f.ultimoMovimiento,
    })),
    contratos,
    nombres,
  );
  return { texto: textoGrupos(grupos), grupos, agrupados: elegidos.length, soloDirectos };
}
