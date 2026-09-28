import type { Request, Response } from 'express';
import { QueryTypes, type InferAttributes } from 'sequelize';
import { DB_SCHEMA } from '../config/database';
import { Dependencia, Empleado, sequelize } from '../models';

const S = DB_SCHEMA;

interface CodigoDescripcion {
  codigo: string;
  descripcion: string | null;
}

interface FilaMiembro {
  coDependencia: string;
  coEmpleado: string;
  nombreCompleto: string | null;
  coCargo: string | null;
}

interface Miembro {
  coEmpleado: string;
  nombreCompleto: string | null;
  cargoDescripcion: string | null;
}

type DependenciaConRelaciones = InferAttributes<Dependencia> & {
  jefe: (InferAttributes<Empleado> & { nombreCompleto?: string }) | null;
  padre: { coDependencia: string; deDependencia: string | null } | null;
};

// idosgd.pk_sgd_descripcion_de_dominios / pk_sgd_descripcion_de_cargo son las mismas funciones
// PL/pgSQL que usa el sistema legado para resolver códigos a texto (ver DependenciaDaoImp.java).
// Se invocan sobre los códigos únicos presentes en el resultado, no por fila, para no repetir
// la llamada a función 37+ veces.
async function resolverDominio(funcion: string, argExtra: string | null, codigos: string[]): Promise<Record<string, string>> {
  const unicos = [...new Set(codigos)];
  if (unicos.length === 0) return {};

  const llamada = argExtra ? `"idosgd"."${funcion}"('${argExtra}', t.codigo)` : `"idosgd"."${funcion}"(t.codigo)`;

  // `bind` (no `replacements`) para que pg mande el array como un único parámetro nativo:
  // con `replacements` Sequelize expande el array en una lista de valores separados por coma,
  // lo cual rompe el cast a ::text[] que unnest() necesita.
  const filas = await sequelize.query<CodigoDescripcion>(
    `SELECT t.codigo, ${llamada} AS descripcion FROM unnest($1::text[]) AS t(codigo)`,
    { bind: [unicos], type: QueryTypes.SELECT },
  );

  return Object.fromEntries(filas.map((f) => [f.codigo, f.descripcion ?? '']));
}

/**
 * Miembros (empleados activos, CEMP_EST_EMP = '1') de cada dependencia activa. La fuente depende
 * del tipo, verificado contra la BD real 2026-09-28:
 *  - Institución (TI_DEPENDENCIA <> '1'): la ficha del empleado, RHTM_PER_EMPLEADOS.CEMP_CO_DEPEND.
 *    Ningún comité aparece ahí.
 *  - Comité (TI_DEPENDENCIA = '1'): TDTX_DEPENDENCIA_EMPLEADO, que cubre los 43 comités activos y
 *    ninguna institución. El presidente (RHTM_DEPENDENCIA.CO_EMPLEADO, el `jefe`) no se repite
 *    ahí, así que presidente y miembros no se solapan. ES_EMP vale '0' en todas las filas: no filtra.
 */
async function obtenerMiembros(): Promise<FilaMiembro[]> {
  return sequelize.query<FilaMiembro>(
    `SELECT d.co_dependencia AS "coDependencia",
            e.cemp_codemp AS "coEmpleado",
            NULLIF(TRIM(CONCAT_WS(' ', e.cemp_apepat, e.cemp_apemat, e.cemp_denom)), '') AS "nombreCompleto",
            NULLIF(TRIM(e.cemp_co_cargo), '') AS "coCargo"
       FROM ${S}.rhtm_dependencia d
       JOIN ${S}.rhtm_per_empleados e
         ON e.cemp_est_emp = '1'
        AND (
              (d.ti_dependencia = '1' AND e.cemp_codemp IN (
                 SELECT de.co_emp FROM ${S}.tdtx_dependencia_empleado de WHERE de.co_dep = d.co_dependencia))
           OR (d.ti_dependencia IS DISTINCT FROM '1' AND e.cemp_co_depend = d.co_dependencia)
            )
      WHERE d.in_baja = '0'
      ORDER BY 1, 3`,
    { type: QueryTypes.SELECT },
  );
}

export async function getAllDependencias(_req: Request, res: Response) {
  try {
    const dependencias = await Dependencia.findAll({
      where: { inBaja: '0' },
      include: [
        { model: Empleado, as: 'jefe', attributes: ['cempCodemp', 'cempApepat', 'cempApemat', 'cempDenom'] },
        { model: Dependencia, as: 'padre', attributes: ['coDependencia', 'deDependencia'] },
      ],
      order: [['deDependencia', 'ASC']],
    });

    const [plains, filasMiembros] = await Promise.all([
      Promise.resolve(dependencias.map((dep) => dep.toJSON() as DependenciaConRelaciones)),
      obtenerMiembros(),
    ]);

    const codigosTipoEnc = plains.map((d) => d.coTipoEncargatura).filter((c): c is string => Boolean(c));
    // Cargos de jefes y de miembros en una sola llamada: mismo dominio, una ida menos al SGD.
    const codigosCargo = [...plains.map((d) => d.coCargo), ...filasMiembros.map((m) => m.coCargo)].filter(
      (c): c is string => Boolean(c),
    );

    const [tipoEncargaturaMap, cargoMap] = await Promise.all([
      resolverDominio('pk_sgd_descripcion_de_dominios', 'CO_TIPO_ENC', codigosTipoEnc),
      resolverDominio('pk_sgd_descripcion_de_cargo', null, codigosCargo),
    ]);

    const miembrosPorDependencia = new Map<string, Miembro[]>();
    for (const fila of filasMiembros) {
      const lista = miembrosPorDependencia.get(fila.coDependencia) ?? [];
      lista.push({
        coEmpleado: fila.coEmpleado,
        nombreCompleto: fila.nombreCompleto,
        cargoDescripcion: fila.coCargo ? (cargoMap[fila.coCargo] || null) : null,
      });
      miembrosPorDependencia.set(fila.coDependencia, lista);
    }

    const data = plains.map((plain) => {
      const jefe = plain.jefe
        ? {
            ...plain.jefe,
            nombreCompleto: [plain.jefe.cempApepat, plain.jefe.cempApemat, plain.jefe.cempDenom].filter(Boolean).join(' '),
          }
        : null;

      return {
        ...plain,
        jefe,
        tipoEncargaturaDescripcion: plain.coTipoEncargatura ? (tipoEncargaturaMap[plain.coTipoEncargatura] ?? null) : null,
        cargoDescripcion: plain.coCargo ? (cargoMap[plain.coCargo] ?? null) : null,
        // Fase 6 del dashboard usa la misma regla: TI_DEPENDENCIA = '1' es comité de evaluación.
        esComite: plain.tiDependencia === '1',
        miembros: miembrosPorDependencia.get(plain.coDependencia) ?? [],
      };
    });

    res.json(data);
  } catch (error) {
    console.error('Error al obtener dependencias:', error);
    res.status(500).json({ message: 'Error al obtener dependencias' });
  }
}
