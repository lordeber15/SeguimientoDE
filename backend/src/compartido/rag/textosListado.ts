import type { ResumenBusqueda } from './busquedaTerminos';
import type { PlanConsulta } from './planificadorService';

/**
 * Frase de plantilla de las respuestas tabla (listar / contar), común al SGD y al STD
 * (docs/PLAN-CHAT-CONSULTAS.md, Fases 3 y 7). Sin modelo: la escribe el código a partir de la
 * búsqueda, así que nunca afirma algo que la tabla no muestre.
 */

export interface EstadosListado { enTramite: number; archivados: number; sinDato: number }

/** Cómo se nombra la unidad listada y sus datos en la frase. */
export interface UnidadListado {
  uno: string;
  varios: string;
  femenino?: boolean;
  /** Qué son "sus datos" (nivel 1). */
  datos: string;
  /** Dónde está el contenido (nivel 2). */
  contenido: string;
}

export const UNIDAD_EXPEDIENTE: UnidadListado = {
  uno: 'expediente', varios: 'expedientes', datos: 'asunto, remitente o emisor', contenido: 'sus documentos',
};

export const UNIDAD_DOCUMENTO_STD: UnidadListado = {
  uno: 'documento', varios: 'documentos', datos: 'asunto, remitente, tipo o contrato', contenido: 'sus archivos',
};

const comillas = (terminos: string[]) => terminos.map((t) => `«${t}»`).join(' + ');

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** " relacionados con «a» + «b», con documentos remitidos por «X»" (o vacío si no hay criterio). */
function descripcionCriterio(plan: PlanConsulta, terminos: string[], total: number, u: UnidadListado): string {
  const f = plan.filtros;
  const filtros: string[] = [];
  if (f.remitente) filtros.push(`con documentos remitidos por «${f.remitente}»`);
  if (f.emisor) filtros.push(`con documentos emitidos por «${f.emisor}»`);
  if (f.dependencia) filtros.push(`con documentos de «${f.dependencia}»`);
  if (f.tipoDoc) filtros.push(`con documentos tipo ${f.tipoDoc.toUpperCase()}`);
  if (f.desde || f.hasta) filtros.push(`con documentos entre ${f.desde ?? '…'} y ${f.hasta ?? 'hoy'}`);

  const partes: string[] = [];
  if (terminos.length > 0) {
    const rel = u.femenino ? (total === 1 ? 'relacionada' : 'relacionadas') : (total === 1 ? 'relacionado' : 'relacionados');
    partes.push(`${rel} con ${comillas(terminos)}`);
  }
  partes.push(...filtros);
  return partes.length > 0 ? ` ${partes.join(', ')}` : '';
}

/** Frase de plantilla de la respuesta. Pura: se prueba sin BD. */
export function textoListado(
  intencion: 'listar' | 'contar',
  plan: PlanConsulta,
  b: ResumenBusqueda,
  mesesActual: number,
  estados?: EstadosListado,
  /** Tamaño del conjunto anterior si se buscó dentro de él ("de esos…"). */
  dentroDe?: number,
  /** Tamaño del conjunto anterior si se buscó en él SIN resultados y se pasó a toda la base. */
  anteriorSinResultados?: number,
  u: UnidadListado = UNIDAD_EXPEDIENTE,
): string {
  const criterio = descripcionCriterio(plan, b.terminos, b.total, u);
  const actual = plan.filtros.actual ? ` con movimiento en los últimos ${plural(mesesActual, 'mes', 'meses')}` : '';
  const lineas: string[] = [];

  if (b.modoTerminos === 'alguno') {
    lineas.push(`Ningún ${u.uno} cumple todos los términos (${comillas(b.terminos)}); muestro los que cumplen al menos uno.`);
  }

  const verbo = intencion === 'contar' ? 'Hay' : 'Encontré';
  const ambito = dentroDe
    ? `Dentro de los ${plural(dentroDe, u.uno, u.varios)} del listado anterior, `
    : anteriorSinResultados
      ? `Ninguno de los ${plural(anteriorSinResultados, u.uno, u.varios)} del listado anterior cumple esto; en toda la base `
      : '';
  const cabeza = ambito
    ? `${ambito}${verbo.toLowerCase()} ${plural(b.total, u.uno, u.varios)}${criterio}${actual}.`
    : `${verbo} ${plural(b.total, u.uno, u.varios)}${criterio}${actual}.`;
  lineas.push(cabeza);

  if (b.terminos.length > 0 && b.total > 0) {
    lineas.push(
      `${plural(b.nivel1, 'coincide', 'coinciden')} con todos los términos en sus datos (${u.datos}) y `
      + `${plural(b.nivel2, 'lo menciona', 'lo mencionan')} solo dentro del contenido de ${u.contenido}.`,
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

