import { stdRagSequelize } from '../config/stdRagDatabase';
import { leerParametros, type ResumenBusqueda } from '../../../compartido/rag/busquedaTerminos';
import type { PlanConsulta } from '../../../compartido/rag/planificadorService';
import { textoListado, UNIDAD_DOCUMENTO_STD, type EstadosListado } from '../../../compartido/rag/textosListado';
import { estadoVivoDocumentosStd } from '../services/stdConsultasService';
import {
  buscarDocumentosStdPorPlan,
  detallePaginaStd,
  idDeCandidato,
  type CandidatoDocumentoStd,
  type FilaDocumentoStdChat,
} from './busquedaDocumentosStdService';

/**
 * Respuestas `listar` / `contar` del chat STD (docs/PLAN-CHAT-CONSULTAS.md, Fase 7): tabla de
 * documentos + frase de plantilla, sin modelo de respuesta. Mismo diseño que el SGD
 * (`listadoChatService.ts`): la lista completa y ordenada se guarda en `chat_mensaje.meta`, el
 * "ver más" pagina sobre ella y es el conjunto activo de la conversación ("de esos…").
 */

export const FILAS_POR_PAGINA_STD = 10;

export interface TablaDocumentosStd {
  filas: FilaDocumentoStdChat[];
  pagina: number;
  porPagina: number;
  total: number;
  nivel1: number;
  nivel2: number;
  hayMas: boolean;
}

export interface MetaListadoStd {
  version: 1;
  sistema: 'std';
  plan: PlanConsulta;
  busqueda: ResumenBusqueda;
  documentos: CandidatoDocumentoStd[];
  estados?: EstadosListado;
}

export interface RespuestaListadoStd {
  texto: string;
  tabla: TablaDocumentosStd;
  meta: MetaListadoStd;
}

export function esMetaListadoStd(meta: unknown): meta is MetaListadoStd {
  const m = meta as Partial<MetaListadoStd> | null;
  return typeof m === 'object' && m !== null && m.version === 1 && m.sistema === 'std'
    && Array.isArray(m.documentos) && typeof m.busqueda === 'object' && m.busqueda !== null;
}

export async function paginaDesdeMetaStd(meta: MetaListadoStd, pagina: number): Promise<TablaDocumentosStd> {
  const parametros = await leerParametros(stdRagSequelize);
  const desde = (pagina - 1) * FILAS_POR_PAGINA_STD;
  const tramo = meta.documentos.slice(desde, desde + FILAS_POR_PAGINA_STD);
  const filas = await detallePaginaStd(tramo, meta.busqueda.terminos, parametros.mesesActual);
  return {
    filas,
    pagina,
    porPagina: FILAS_POR_PAGINA_STD,
    total: meta.documentos.length,
    nivel1: meta.busqueda.nivel1,
    nivel2: meta.busqueda.nivel2,
    hayMas: desde + FILAS_POR_PAGINA_STD < meta.documentos.length,
  };
}

/** Para el historial: totales sin filas (la página 1 se pide al pintarla). */
export function resumenTablaStd(meta: MetaListadoStd): TablaDocumentosStd {
  return {
    filas: [],
    pagina: 0,
    porPagina: FILAS_POR_PAGINA_STD,
    total: meta.documentos.length,
    nivel1: meta.busqueda.nivel1,
    nivel2: meta.busqueda.nivel2,
    hayMas: meta.documentos.length > 0,
  };
}

export async function ejecutarListadoStd(
  intencion: 'listar' | 'contar',
  plan: PlanConsulta,
  opciones: { dentroDe?: number[] } = {},
): Promise<RespuestaListadoStd | null> {
  const parametros = await leerParametros(stdRagSequelize);
  let dentroDe = opciones.dentroDe && opciones.dentroDe.length > 0 ? opciones.dentroDe : undefined;
  let resultado = await buscarDocumentosStdPorPlan(plan, parametros, { dentroDe, soloActuales: plan.filtros.actual });
  // Misma red de seguridad que el SGD: nada dentro del listado anterior → toda la base, y se dice.
  let anteriorSinResultados: number | undefined;
  if (resultado.total === 0 && dentroDe) {
    anteriorSinResultados = dentroDe.length;
    dentroDe = undefined;
    resultado = await buscarDocumentosStdPorPlan(plan, parametros, { soloActuales: plan.filtros.actual });
  }
  if (resultado.total === 0) return null;

  const { candidatos, ...busqueda } = resultado;

  let estados: EstadosListado | undefined;
  if (intencion === 'contar') {
    const vivos = await estadoVivoDocumentosStd(candidatos.map(idDeCandidato), parametros.mesesActual).catch(() => null);
    if (vivos) {
      let enTramite = 0;
      let archivados = 0;
      for (const c of candidatos) {
        const e = vivos.get(idDeCandidato(c));
        if (!e) continue;
        if (e.archivado) archivados++;
        else enTramite++;
      }
      estados = { enTramite, archivados, sinDato: candidatos.length - enTramite - archivados };
    }
  }

  const meta: MetaListadoStd = { version: 1, sistema: 'std', plan, busqueda, documentos: candidatos, estados };
  const tabla = await paginaDesdeMetaStd(meta, 1);
  return {
    texto: textoListado(
      intencion, plan, busqueda, parametros.mesesActual, estados, dentroDe?.length, anteriorSinResultados,
      UNIDAD_DOCUMENTO_STD,
    ),
    tabla,
    meta,
  };
}
