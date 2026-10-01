import { Sequelize } from 'sequelize';

/**
 * Conexión a la BD PROPIA de la aplicación (contenedor `db-app`).
 *
 * Deliberadamente separada de `config/database.ts`, que apunta al SGD. Son dos servidores
 * distintos y dos políticas distintas: sobre `idosgd` no se escribe nunca; aquí sí. Tenerlas en
 * instancias separadas evita el error de escribir en la conexión equivocada.
 */
export const appSequelize = new Sequelize(
  process.env.APP_DB_NAME ?? 'seguimiento_app',
  process.env.APP_DB_USER ?? 'seguimiento',
  process.env.APP_DB_PASS ?? '',
  {
    host: process.env.APP_DB_HOST ?? 'db-app',
    port: Number(process.env.APP_DB_PORT ?? 5432),
    dialect: 'postgres',
    logging: false,
    pool: { max: 10, min: 0, idle: 10_000 },
  },
);
