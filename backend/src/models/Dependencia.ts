import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize, DB_SCHEMA } from '../config/database';

export class Dependencia extends Model<InferAttributes<Dependencia>, InferCreationAttributes<Dependencia>> {
  declare coDependencia: string;
  declare deDependencia: CreationOptional<string | null>;
  declare deSigla: CreationOptional<string | null>;
  declare inBaja: CreationOptional<string | null>;
  declare coNivel: CreationOptional<string | null>;
  declare deCortaDepen: CreationOptional<string | null>;
  declare coDepenPadre: CreationOptional<string | null>;
  declare coEmpleado: CreationOptional<string | null>;
  declare tiDependencia: CreationOptional<string | null>;
  declare coCargo: CreationOptional<string | null>;
  declare coTipoEncargatura: CreationOptional<string | null>;
  declare tituloDep: CreationOptional<string | null>;
  declare deCargoCompleto: CreationOptional<string | null>;
  declare inMesaPartes: CreationOptional<string | null>;
}

Dependencia.init(
  {
    coDependencia: { type: DataTypes.STRING, primaryKey: true, field: 'co_dependencia' },
    deDependencia: { type: DataTypes.STRING, field: 'de_dependencia' },
    deSigla: { type: DataTypes.STRING, field: 'de_sigla' },
    inBaja: { type: DataTypes.STRING, field: 'in_baja' },
    coNivel: { type: DataTypes.STRING, field: 'co_nivel' },
    deCortaDepen: { type: DataTypes.STRING, field: 'de_corta_depen' },
    coDepenPadre: { type: DataTypes.STRING, field: 'co_depen_padre' },
    coEmpleado: { type: DataTypes.STRING, field: 'co_empleado' },
    tiDependencia: { type: DataTypes.STRING, field: 'ti_dependencia' },
    coCargo: { type: DataTypes.STRING, field: 'co_cargo' },
    coTipoEncargatura: { type: DataTypes.STRING, field: 'co_tipo_encargatura' },
    tituloDep: { type: DataTypes.STRING, field: 'titulo_dep' },
    deCargoCompleto: { type: DataTypes.STRING, field: 'de_cargo_completo' },
    inMesaPartes: { type: DataTypes.STRING, field: 'in_mesa_partes' },
  },
  {
    sequelize,
    schema: DB_SCHEMA,
    modelName: 'Dependencia',
    tableName: 'rhtm_dependencia',
    timestamps: false,
  },
);
