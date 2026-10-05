import type { PlanConsulta } from '../../../compartido/rag/planificadorService';
import {
  buscarExpedientesPorPlan,
  detallePagina,
  leerParametros,
  terminosDelPlan,
  type FilaExpedienteChat,
} from './busquedaExpedientesService';
import {
  contratosPorExpediente,
  destinatariosSgd,
  documentosRecientes,
  indicacionesDocumento,
  nombresDeContratos,
  participantesRag,
  tramiteExpedientes,
  type Destinatario,
  type DocumentoEncontrado,
  type IndicacionDestino,
  type ParticipanteExterno,
  type ParticipanteInterno,
  type TramiteExpediente,
} from './consultasExpedienteService';
import type { MetaListado } from './listadoChatService';
import type { FiltroAcceso } from './retrievalService';

/**
 * Respuestas `ultimo_documento` y `participantes` (sin modelo de respuesta, D6) y los datos de
 * `agrupar` (que sí usa el modelo para agrupar por obra) — docs/PLAN-CHAT-CONSULTAS.md, Fase 5.
 *
 * Sobre qué expedientes trabajan, en este orden:
 *   1. modo "por expediente" → ese expediente;
 *   2. búsqueda de expedientes del plan (términos + filtros), dentro del conjunto activo si la
 *      pregunta continúa la anterior;
 *   3. sin términos ni filtros pero con conjunto activo ("¿y el último de esos?") → el conjunto.
 */

type Par = { nuAnnExp: string; nuSecExp: string };

export interface OpcionesObjetivo {
  expediente?: Par;
  conjunto?: Par[] | null;
}

/** Tope de expedientes sobre los que se buscan documentos / participantes. */
const MAX_EXPEDIENTES = 200;
/** Expedientes cuyo trámite completo (movimientos + indicaciones) se muestra. */
const MAX_TRAMITES = 5;
/** Expedientes que se le pasan al modelo para agrupar por obra. */
export const MAX_AGRUPAR = 60;

interface Objetivo {
  pares: Par[];
  total: number;
  terminos: string[];
  /** Cómo se llegó a los expedientes, para la frase. */
  ambito: 'expediente' | 'busqueda' | 'conjunto';
}

async function expedientesObjetivo(plan: PlanConsulta, filtro: FiltroAcceso, op: OpcionesObjetivo): Promise<Objetivo | null> {
  const terminos = terminosDelPlan(plan);
  if (op.expediente) return { pares: [op.expediente], total: 1, terminos, ambito: 'expediente' };

  const parametros = await leerParametros();
  const r = await buscarExpedientesPorPlan(plan, filtro, parametros, {
    dentroDe: op.conjunto ?? undefined,
    soloActuales: plan.filtros.actual,
  });
  if (r.total > 0) {
    return {
      pares: r.candidatos.slice(0, MAX_EXPEDIENTES).map((c) => ({ nuAnnExp: c.a, nuSecExp: c.s })),
      total: r.total,
      terminos: r.terminos,
      ambito: 'busqueda',
    };
  }
  if (op.conjunto && op.conjunto.length > 0 && r.terminos.length === 0) {
    return { pares: op.conjunto.slice(0, MAX_EXPEDIENTES), total: op.conjunto.length, terminos: [], ambito: 'conjunto' };
  }
  return null;
}

const comillas = (terminos: string[]) => terminos.map((t) => `«${t}»`).join(' + ');
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
const fecha = (iso: string | null) => {
  if (!iso) return 's/f';
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
};

function fraseAmbito(o: Objetivo): string {
  if (o.ambito === 'expediente') return 'en este expediente';
  const sobre = o.terminos.length > 0 ? ` relacionados con ${comillas(o.terminos)}` : '';
  if (o.ambito === 'conjunto') return `entre los ${plural(o.total, 'expediente', 'expedientes')} del listado anterior`;
  return `entre ${o.total === 1 ? 'el expediente' : `los ${o.total} expedientes`}${sobre}`;
}

// ── Último documento ────────────────────────────────────────────────────────────────────────────

export interface TarjetaDocumento extends DocumentoEncontrado {
  totalTerminos: number;
  indicaciones: IndicacionDestino[];
  /** Los siguientes más recientes con la misma prioridad, para contexto. */
  anteriores: DocumentoEncontrado[];
}

export interface RespuestaUltimoDocumento {
  texto: string;
  documento: TarjetaDocumento;
  meta: { version: 1; kind: 'documento'; plan: PlanConsulta; documento: TarjetaDocumento };
}

export function textoUltimoDocumento(o: Objetivo, d: TarjetaDocumento): string {
  const partes = [
    `El documento más reciente ${fraseAmbito(o)} es ${d.titulo ?? 'un documento sin título'} del ${fecha(d.fecha)}`
    + (o.ambito !== 'expediente' && d.numeroExpediente ? `, en el expediente ${d.numeroExpediente}` : '') + '.',
  ];
  if (d.totalTerminos > 1 && d.terminosCoinciden < d.totalTerminos) {
    partes.push(`Ningún documento cumple todos los términos; este cumple ${d.terminosCoinciden} de ${d.totalTerminos}.`);
  }
  if (d.indicaciones.length === 0) partes.push('No registra derivaciones.');
  return partes.join(' ');
}

export async function ejecutarUltimoDocumento(
  plan: PlanConsulta,
  filtro: FiltroAcceso,
  op: OpcionesObjetivo,
): Promise<RespuestaUltimoDocumento | null> {
  const objetivo = await expedientesObjetivo(plan, filtro, op);
  if (!objetivo) return null;

  const docs = await documentosRecientes(objetivo.pares, objetivo.terminos, filtro, 5);
  // Con términos, un documento que no cumple ninguno no es "el último documento de X".
  const relevantes = objetivo.terminos.length > 0 ? docs.filter((d) => d.terminosCoinciden > 0) : docs;
  const [primero, ...resto] = relevantes;
  if (!primero) return null;

  const indicaciones = await indicacionesDocumento(primero.nuAnn, primero.nuEmi, filtro).catch(() => []);
  const documento: TarjetaDocumento = {
    ...primero,
    totalTerminos: objetivo.terminos.length,
    indicaciones,
    anteriores: resto.filter((d) => d.terminosCoinciden === primero.terminosCoinciden).slice(0, 3),
  };
  return {
    texto: textoUltimoDocumento(objetivo, documento),
    documento,
    meta: { version: 1, kind: 'documento', plan, documento },
  };
}

// ── Participantes ───────────────────────────────────────────────────────────────────────────────

export interface BloqueParticipantes {
  totalExpedientes: number;
  remitentes: ParticipanteExterno[];
  emisores: ParticipanteInterno[];
  destinatarios: Destinatario[];
  tramites: TramiteExpediente[];
}

export interface RespuestaParticipantes {
  texto: string;
  participantes: BloqueParticipantes;
  meta: { version: 1; kind: 'participantes'; plan: PlanConsulta; participantes: BloqueParticipantes };
}

export function textoParticipantes(o: Objetivo, b: BloqueParticipantes): string {
  const cuenta = [
    plural(b.remitentes.length, 'remitente externo', 'remitentes externos'),
    plural(b.emisores.length, 'emisor interno', 'emisores internos'),
    plural(b.destinatarios.length, 'destinatario', 'destinatarios'),
  ].join(', ');
  const tope = (n: number) => (n >= 25 ? ' (se muestran los 25 más frecuentes de cada grupo)' : '');
  const masFrecuentes = tope(Math.max(b.remitentes.length, b.emisores.length, b.destinatarios.length));
  const tramites = o.ambito === 'expediente'
    ? 'Abajo, el trámite con las indicaciones de cada derivación.'
    : `Abajo, el trámite con indicaciones de ${b.tramites.length === 1 ? 'ese expediente' : `los ${b.tramites.length} más relevantes`}.`;
  return `Participaron ${fraseAmbito(o)}: ${cuenta}${masFrecuentes}. ${tramites}`;
}

export async function ejecutarParticipantes(
  plan: PlanConsulta,
  filtro: FiltroAcceso,
  op: OpcionesObjetivo,
): Promise<RespuestaParticipantes | null> {
  const objetivo = await expedientesObjetivo(plan, filtro, op);
  if (!objetivo) return null;

  const principales = objetivo.pares.slice(0, MAX_TRAMITES);
  const [rag, destinatarios, detalle] = await Promise.all([
    participantesRag(objetivo.pares, filtro),
    destinatariosSgd(objetivo.pares, filtro).catch(() => []),
    // Solo para el N° de expediente visible de los trámites que se muestran.
    detallePagina(principales.map((p) => ({ a: p.nuAnnExp, s: p.nuSecExp, n: 1, dm: 0, dc: 0, r: false, t: 0, bm: 0, bc: 0 })),
      [], filtro, 3).catch(() => [] as FilaExpedienteChat[]),
  ]);
  const numero = new Map(detalle.map((f) => [`${f.nuAnnExp}|${f.nuSecExp}`, f.numeroExpediente]));
  const tramites = await tramiteExpedientes(
    principales.map((p) => ({ ...p, numeroExpediente: numero.get(`${p.nuAnnExp}|${p.nuSecExp}`) ?? null })),
    filtro,
  ).catch(() => []);

  const participantes: BloqueParticipantes = {
    totalExpedientes: objetivo.total,
    remitentes: rag.remitentes,
    emisores: rag.emisores,
    destinatarios,
    tramites,
  };
  if (!participantes.remitentes.length && !participantes.emisores.length && !participantes.destinatarios.length) return null;

  return {
    texto: textoParticipantes(objetivo, participantes),
    participantes,
    meta: { version: 1, kind: 'participantes', plan, participantes },
  };
}

// ── Agrupar ─────────────────────────────────────────────────────────────────────────────────────

export interface GrupoObra {
  /** Contrato que define el grupo (el más citado de sus expedientes); null = sin contrato. */
  contrato: string | null;
  nombre: string | null;
  /** Menos de 10 fragmentos citan el contrato: el nombre puede venir de otro documento. */
  dudoso: boolean;
  expedientes: { numero: string; archivado: boolean; ultimoMovimiento: string | null }[];
}

export interface Agrupacion {
  texto: string;
  grupos: GrupoObra[];
  agrupados: number;
  soloDirectos: boolean;
}

const UMBRAL_NOMBRE_CONFIABLE = 10;

/** Clave para fusionar contratos de un mismo proyecto (p. ej. obra y equipamiento): el nombre
 *  normalizado y recortado — "…Medicina Tropical de la UNTRM, Sede Chachapoyas" y "…de la Universidad
 *  Nacional Toribio Rodríguez de Mendoza…" no se fusionan, y no hace falta: quedan como dos grupos. */
const claveNombre = (n: string) =>
  n.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);

/**
 * Agrupa por obra SIN modelo (Fase 5). Medido: los asuntos de controversia no nombran la obra y los
 * remitentes son personas, pero los documentos citan el contrato una y otra vez. Cada expediente va
 * al grupo de su contrato MÁS citado; el grupo se nombra con el proyecto de ese contrato (texto entre
 * comillas tras el número). Primero se probó con el modelo agrupando: entre corridas reasignaba
 * expedientes y repetía uno en dos grupos aunque el prompt lo prohibía — esto es determinista.
 *
 * Pura: se prueba sin BD.
 */
export function agruparPorContrato(
  filas: Pick<FilaExpedienteChat, 'nuAnnExp' | 'nuSecExp' | 'numeroExpediente' | 'archivado' | 'ultimoMovimiento'>[],
  contratos: Map<string, string[]>,
  nombres: Map<string, { nombre: string; menciones: number }>,
): GrupoObra[] {
  const grupos = new Map<string, GrupoObra>();
  for (const f of filas) {
    const contrato = contratos.get(`${f.nuAnnExp}|${f.nuSecExp}`)?.[0] ?? null;
    const info = contrato ? nombres.get(contrato) : undefined;
    const k = info ? `n:${claveNombre(info.nombre)}` : contrato ? `c:${contrato}` : 'sin';
    let g = grupos.get(k);
    if (!g) {
      g = {
        contrato,
        nombre: info?.nombre ?? null,
        dudoso: info ? info.menciones < UMBRAL_NOMBRE_CONFIABLE : false,
        expedientes: [],
      };
      grupos.set(k, g);
    }
    g.expedientes.push({
      numero: f.numeroExpediente ?? `${f.nuAnnExp}-${f.nuSecExp}`,
      archivado: f.archivado,
      ultimoMovimiento: f.ultimoMovimiento,
    });
  }
  // Los grupos con más expedientes primero; "sin contrato" siempre al final.
  return [...grupos.values()].sort((a, b) =>
    Number(a.contrato === null) - Number(b.contrato === null) || b.expedientes.length - a.expedientes.length);
}

export function textoGrupos(grupos: GrupoObra[]): string {
  return grupos.map((g) => {
    const titulo = g.contrato === null
      ? 'Sin contrato identificado'
      : g.nombre
        ? `${g.nombre} (contrato ${g.contrato}${g.dudoso ? ', nombre no confirmado' : ''})`
        : `Contrato ${g.contrato} (sin nombre de proyecto identificado)`;
    const expedientes = g.expedientes
      .map((e) => `${e.numero} (${e.archivado ? 'archivado' : 'en trámite'})`)
      .join(', ');
    return `- ${titulo}: ${expedientes}`;
  }).join('\n');
}

/**
 * Agrupación por obra de los expedientes de un listado. Si hay coincidencias directas se agrupan
 * SOLO esas: las de nivel 2 son en su mayoría contratos con la cláusula estándar de controversias.
 */
export async function agruparPorObra(meta: MetaListado, filtro: FiltroAcceso): Promise<Agrupacion> {
  const parametros = await leerParametros();
  const directos = meta.expedientes.filter((c) => c.n === 1);
  const soloDirectos = directos.length > 0;
  const elegidos = (soloDirectos ? directos : meta.expedientes).slice(0, MAX_AGRUPAR);

  const [filas, contratos] = await Promise.all([
    detallePagina(elegidos, meta.busqueda.terminos, filtro, parametros.mesesActual),
    contratosPorExpediente(elegidos.map((c) => ({ nuAnnExp: c.a, nuSecExp: c.s }))).catch(() => new Map<string, string[]>()),
  ]);
  const principales = [...new Set([...contratos.values()].map((l) => l[0]).filter(Boolean))].slice(0, 30);
  const nombres = await nombresDeContratos(principales).catch(() => new Map<string, { nombre: string; menciones: number }>());

  const grupos = agruparPorContrato(filas, contratos, nombres);
  return { texto: textoGrupos(grupos), grupos, agrupados: elegidos.length, soloDirectos };
}
