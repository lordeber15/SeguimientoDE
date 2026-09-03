import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize, DB_SCHEMA } from '../config/database';

export class Empleado extends Model<InferAttributes<Empleado>, InferCreationAttributes<Empleado>> {
  declare cempCodemp: string;
  declare cempApepat: CreationOptional<string | null>;
  declare cempApemat: CreationOptional<string | null>;
  declare cempDenom: CreationOptional<string | null>;
}

// Las tablas del SGD se crearon sin comillas en Oracle/PostgreSQL, por lo que Postgres
// pliega los identificadores a minúsculas. Sequelize sí cita los identificadores que genera,
// así que tableName/field deben ir en minúsculas para calzar con el catálogo real.
Empleado.init(
  {
    cempCodemp: { type: DataTypes.STRING, primaryKey: true, field: 'cemp_codemp' },
    cempApepat: { type: DataTypes.STRING, field: 'cemp_apepat' },
    cempApemat: { type: DataTypes.STRING, field: 'cemp_apemat' },
    cempDenom: { type: DataTypes.STRING, field: 'cemp_denom' },
  },
  {
    sequelize,
    schema: DB_SCHEMA,
    modelName: 'Empleado',
    tableName: 'rhtm_per_empleados',
    timestamps: false,
  },
);
