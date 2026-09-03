import type { Request, Response } from 'express';
import { QueryTypes, type InferAttributes } from 'sequelize';
import { Dependencia, Empleado, sequelize } from '../models';

interface CodigoDescripcion {
  codigo: string;
  descripcion: string | null;
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

    const plains = dependencias.map((dep) => dep.toJSON() as DependenciaConRelaciones);

    const codigosTipoEnc = plains.map((d) => d.coTipoEncargatura).filter((c): c is string => Boolean(c));
    const codigosCargo = plains.map((d) => d.coCargo).filter((c): c is string => Boolean(c));

    const [tipoEncargaturaMap, cargoMap] = await Promise.all([
      resolverDominio('pk_sgd_descripcion_de_dominios', 'CO_TIPO_ENC', codigosTipoEnc),
      resolverDominio('pk_sgd_descripcion_de_cargo', null, codigosCargo),
    ]);

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
      };
    });

    res.json(data);
  } catch (error) {
    console.error('Error al obtener dependencias:', error);
    res.status(500).json({ message: 'Error al obtener dependencias' });
  }
}
