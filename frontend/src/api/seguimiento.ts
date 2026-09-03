import { apiJson } from './cliente';

export interface UsuarioDependencia {
  coEmpleado: string;
  nombreCompleto: string | null;
  recibidos: number;
  emitidos: number;
}

export interface ExpedienteSeguimiento {
  nuAnnExp: string;
  nuSecExp: string;
  numeroExpediente: string | null;
  documento: {
    nombre: string | null;
    tipo: string | null;
    numero: string | null;
    nuAnn: string;
    nuEmi: string;
    nuDes: string;
  };
  asunto: string | null;
  estado: { codigo: string | null; descripcion: string | null };
  /** Cuándo se lo enviaron (FE_EMI del documento entrante). Inicia el cronómetro. */
  fechaRecepcion: string | null;
  /** Cuándo lo abrió (FE_REC_DOC). null = nunca lo abrió. */
  fechaApertura: string | null;
  /** Cuándo emitió su respuesta. null = todavía no respondió. */
  fechaEmision: string | null;
  documentoRespuesta: string | null;
  segundosCorridos: number | null;
  segundosHabiles: number | null;
  participaciones: number;
}

export interface RespuestaExpedientes {
  total: number;
  items: ExpedienteSeguimiento[];
}

export interface ExpedienteEncontrado {
  nuAnnExp: string;
  nuSecExp: string;
  numeroExpediente: string | null;
  coDependencia: string;
  coEmpleado: string;
  nombreCompleto: string | null;
  nombreDependencia: string | null;
}

const pedir = apiJson;

export function fetchUsuarios(coDependencia: string): Promise<UsuarioDependencia[]> {
  return pedir(`/api/seguimiento/usuarios/${coDependencia}`, 'obtener los usuarios de la dependencia');
}

export function fetchExpedientes(coDependencia: string, coEmpleado: string): Promise<RespuestaExpedientes> {
  const params = new URLSearchParams({ dependencia: coDependencia, usuario: coEmpleado });
  return pedir(`/api/seguimiento/expedientes?${params}`, 'obtener los expedientes del usuario');
}

/** Busca por el número visible del expediente (ej. "OGAUL02026000058"), sin elegir antes dependencia/usuario. */
export function buscarExpediente(termino: string): Promise<ExpedienteEncontrado[]> {
  const params = new URLSearchParams({ q: termino });
  return pedir(`/api/seguimiento/expedientes/buscar?${params}`, 'buscar el expediente');
}

/**
 * "2026-05-28 09:51:48" -> `{ dia: "28/05/2026", hora: "09:51" }`. El backend manda hora de pared,
 * sin zona. `hora` viene vacía si el valor no la trae.
 *
 * Existe para que la tabla de Seguimiento pueda pintar día y hora en dos líneas — la columna cabe
 * en 124px en vez de 166 — sin cambiar la firma de `formatearFecha`, que se sigue usando en prosa.
 */
export function partirFecha(valor: string | null): { dia: string; hora: string } | null {
  if (!valor) return null;
  const [fecha, hora = ''] = valor.split(' ');
  const [anio, mes, dia] = fecha.split('-');
  return { dia: `${dia}/${mes}/${anio}`, hora: hora.slice(0, 5) };
}

/** "2026-05-28 09:51:48" -> "28/05/2026 09:51". El backend manda hora de pared, sin zona. */
export function formatearFecha(valor: string | null): string {
  const partes = partirFecha(valor);
  if (!partes) return '—';
  return `${partes.dia} ${partes.hora}`.trim();
}

/** 5528 -> "1 h 32 min". Días de 24 h: es tiempo transcurrido, no jornadas laborales. */
export function formatearDuracion(segundos: number | null): string | null {
  if (segundos === null) return null;
  if (segundos < 60) return 'menos de 1 min';

  const dias = Math.floor(segundos / 86400);
  const horas = Math.floor((segundos % 86400) / 3600);
  const minutos = Math.floor((segundos % 3600) / 60);

  if (dias > 0) return horas > 0 ? `${dias} d ${horas} h` : `${dias} d`;
  if (horas > 0) return minutos > 0 ? `${horas} h ${minutos} min` : `${horas} h`;
  return `${minutos} min`;
}
