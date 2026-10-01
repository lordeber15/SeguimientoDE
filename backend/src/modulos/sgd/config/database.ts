import { types as pgTypes } from 'pg';
import { Sequelize } from 'sequelize';

// Postgres pliega a minúsculas los identificadores no citados. El .env trae IDOSGD en
// mayúsculas (convención usada en el resto del ecosistema SGD), pero Sequelize sí cita los
// identificadores que genera, así que aquí hay que normalizar a minúsculas para que calce
// con el nombre real del esquema en el catálogo (confirmado contra information_schema.schemata).
export const DB_SCHEMA = (process.env.DB_SCHEMA ?? 'IDOSGD').toLowerCase();

// OID 1114 = TIMESTAMP (sin zona horaria), que es el tipo de TODAS las fechas del SGD.
// Por defecto node-postgres construye un Date interpretando ese valor con la zona horaria del
// proceso: el contenedor corre en UTC y el host en UTC-5, así que el MISMO dato se serializaba
// con 5 horas de diferencia según dónde corriera el backend (un documento emitido 09:08 se veía
// 04:08 en el navegador). Estas fechas son "hora de pared" de Lima sin zona asociada, así que se
// devuelven como string tal cual las guardó el SGD y nadie las reinterpreta.
pgTypes.setTypeParser(pgTypes.builtins.TIMESTAMP, (value) => value);

export const sequelize = new Sequelize(
  process.env.DB_NAME ?? '',
  process.env.DB_USER ?? '',
  process.env.DB_PASS,
  {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    dialect: 'postgres',
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
  },
);
