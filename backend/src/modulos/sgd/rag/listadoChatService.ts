import type { PlanConsulta } from '../../../compartido/rag/planificadorService';
import {
  buscarExpedientesPorPlan,
  detallePagina,
  leerParametros,
  type CandidatoExpediente,
  type FilaExpedienteChat,
  type ResultadoBusquedaExpedientes,
} from './busquedaExpedientesService';
import { clave, estadoVivoExpedientes } from './enriquecimientoSgdService';
import type { FiltroAcceso } from './retrievalService';

/**
 * Respuestas `listar` / `contar` del chat (docs/PLAN-CHAT-CONSULTAS.md, Fase 3, D6): tabla + una
 * frase de plantilla, SIN llamar al modelo de respuesta. Lo que se guarda en `chat_mensaje.meta`
 * (`MetaListado`) es la lista completa y ordenada de expedientes: el "ver más" pagina sobre ella sin
 * volver a buscar, y la Fase 4 la usará como conjunto activo ("de esos, ¿cuál es el último?").
 */

export const FILAS_POR_PAGINA = 10;

export interface TablaExpedientes {
  filas: FilaExpedienteChat[];
  pagina: number;
  porPagina: number;
  total: number;
  nivel1: number;
  nivel2: number;
  hayMas: boolean;
}

export interface MetaListado {
  version: 1;
  plan: PlanConsulta;
  busqueda: Omit<ResultadoBusquedaExpedientes, 'candidatos'>;
  expedientes: CandidatoExpediente[];
  /** Para contar: desglose en trámite / archivados (sobre los candidatos guardados). */
  estados?: { enTramite: number; archivados: number; sinDato: number };
}

export interface RespuestaListado {
  texto: string;
  tabla: TablaExpedientes;
  meta: MetaListado;
}

const comillas = (terminos: string[]) => terminos.map((t) => `«${t}»`).join(' + ');

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** " relacionados con «a» + «b», con documentos remitidos por «X»" (o vacío si no hay criterio). */
function descripcionCriterio(plan: PlanConsulta, terminos: string[], total: number): string {
  const f = plan.filtros;
  const filtros: string[] = [];
  if (f.remitente) filtros.push(`con documentos remitidos por «${f.remitente}»`);
  if (f.emisor) filtros.push(`con documentos emitidos por «${f.emisor}»`);
  if (f.dependencia) filtros.push(`con documentos de «${f.dependencia}»`);
  if (f.tipoDoc) filtros.push(`con documentos tipo ${f.tipoDoc.toUpperCase()}`);
  if (f.desde || f.hasta) filtros.push(`con documentos entre ${f.desde ?? '…'} y ${f.hasta ?? 'hoy'}`);

  const partes: string[] = [];
  if (terminos.length > 0) partes.push(`${total === 1 ? 'relacionado' : 'relacionados'} con ${comillas(terminos)}`);
  partes.push(...filtros);
  return partes.length > 0 ? ` ${partes.join(', ')}` : '';
}

/** Frase de plantilla de la respuesta. Pura: se prueba sin BD. */
export function textoListado(
  intencion: 'listar' | 'contar',
  plan: PlanConsulta,
  b: Omit<ResultadoBusquedaExpedientes, 'candidatos'>,
  mesesActual: number,
  estados?: MetaListado['estados'],
): string {
  const criterio = descripcionCriterio(plan, b.terminos, b.total);
  const actual = plan.filtros.actual ? ` con movimiento en los últimos ${plural(mesesActual, 'mes', 'meses')}` : '';
  const lineas: string[] = [];

  if (b.modoTerminos === 'alguno') {
    lineas.push(`Ningún expediente cumple todos los términos (${comillas(b.terminos)}); muestro los que cumplen al menos uno.`);
  }

  const verbo = intencion === 'contar' ? 'Hay' : 'Encontré';
  const cabeza = `${verbo} ${plural(b.total, 'expediente', 'expedientes')}${criterio}${actual}.`;
  lineas.push(cabeza);

  if (b.terminos.length > 0 && b.total > 0) {
    lineas.push(
      `${plural(b.nivel1, 'coincide', 'coinciden')} directamente (asunto o remitente) y `
      + `${plural(b.nivel2, 'lo menciona', 'lo mencionan')} solo dentro del contenido de sus documentos.`,
    );
  }

  if (estados) {
    const base = b.truncado ? ' (sobre los resultados más relevantes)' : '';
    lineas.push(
      `${plural(estados.enTramite, 'sigue', 'siguen')} en trámite y ${plural(estados.archivados, 'está archivado', 'están archivados')}${base}.`,
    );
  }

  if (b.truncado) lineas.push('El resultado es muy amplio: precise la búsqueda para ver todo.');
  if (b.sinExpediente > 0) {
    lineas.push(`Además, ${plural(b.sinExpediente, 'documento sin expediente menciona', 'documentos sin expediente mencionan')} estos términos (no se listan).`);
  }
  return lineas.join(' ');
}

export async function ejecutarListado(
  intencion: 'listar' | 'contar',
  plan: PlanConsulta,
  filtro: FiltroAcceso,
  opciones: { dentroDe?: { nuAnnExp: string; nuSecExp: string }[] } = {},
): Promise<RespuestaListado | null> {
  const parametros = await leerParametros();
  const resultado = await buscarExpedientesPorPlan(plan, filtro, parametros, {
    dentroDe: opciones.dentroDe,
    soloActuales: plan.filtros.actual,
  });
  if (resultado.total === 0) return null;

  const { candidatos, ...busqueda } = resultado;

  let estados: MetaListado['estados'];
  if (intencion === 'contar') {
    const vivos = await estadoVivoExpedientes(
      candidatos.map((c) => ({ nuAnnExp: c.a, nuSecExp: c.s })), parametros.mesesActual,
    ).catch(() => null);
    if (vivos) {
      let enTramite = 0;
      let archivados = 0;
      for (const c of candidatos) {
        const e = vivos.get(clave(c.a, c.s));
        if (!e) continue;
        if (e.archivado) archivados++;
        else enTramite++;
      }
      estados = { enTramite, archivados, sinDato: candidatos.length - enTramite - archivados };
    }
  }

  const meta: MetaListado = { version: 1, plan, busqueda, expedientes: candidatos, estados };
  const tabla = await paginaDesdeMeta(meta, 1, filtro);
  return { texto: textoListado(intencion, plan, busqueda, parametros.mesesActual, estados), tabla, meta };
}

/** Una página de la lista guardada en `meta`, con el estado en vivo de esas filas. */
export async function paginaDesdeMeta(meta: MetaListado, pagina: number, filtro: FiltroAcceso): Promise<TablaExpedientes> {
  const parametros = await leerParametros();
  const desde = (pagina - 1) * FILAS_POR_PAGINA;
  const tramo = meta.expedientes.slice(desde, desde + FILAS_POR_PAGINA);
  const filas = await detallePagina(tramo, meta.busqueda.terminos, filtro, parametros.mesesActual);
  return {
    filas,
    pagina,
    porPagina: FILAS_POR_PAGINA,
    total: meta.expedientes.length,
    nivel1: meta.busqueda.nivel1,
    nivel2: meta.busqueda.nivel2,
    hayMas: desde + FILAS_POR_PAGINA < meta.expedientes.length,
  };
}

/** Lo mínimo que el historial necesita para volver a pintar la tabla sin re-buscar. */
export function resumenTabla(meta: MetaListado): TablaExpedientes {
  return {
    filas: [],
    pagina: 0,
    porPagina: FILAS_POR_PAGINA,
    total: meta.expedientes.length,
    nivel1: meta.busqueda.nivel1,
    nivel2: meta.busqueda.nivel2,
    hayMas: meta.expedientes.length > 0,
  };
}

export function esMetaListado(meta: unknown): meta is MetaListado {
  return typeof meta === 'object' && meta !== null && (meta as MetaListado).version === 1
    && Array.isArray((meta as MetaListado).expedientes);
}
