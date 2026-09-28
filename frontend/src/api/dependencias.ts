import { apiJson } from './cliente';

export interface Jefe {
  cempCodemp: string;
  cempApepat: string | null;
  cempApemat: string | null;
  cempDenom: string | null;
  nombreCompleto: string | null;
}

export interface DependenciaPadre {
  coDependencia: string;
  deDependencia: string | null;
}

export interface Miembro {
  coEmpleado: string;
  nombreCompleto: string | null;
  cargoDescripcion: string | null;
}

export interface Dependencia {
  coDependencia: string;
  deDependencia: string | null;
  deSigla: string | null;
  coTipoEncargatura: string | null;
  jefe: Jefe | null;
  padre: DependenciaPadre | null;
  tipoEncargaturaDescripcion: string | null;
  cargoDescripcion: string | null;
  /** `true` cuando `RHTM_DEPENDENCIA.TI_DEPENDENCIA = '1'` (comité de evaluación); `false` para
   *  una unidad institucional. Misma regla que usa el dashboard (Fase 6). */
  esComite: boolean;
  miembros: Miembro[];
}

export function fetchDependencias(): Promise<Dependencia[]> {
  return apiJson('/api/dependencias', 'obtener la lista de dependencias');
}
