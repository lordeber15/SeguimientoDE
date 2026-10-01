import path from 'path';
import { QueryTypes, Sequelize } from 'sequelize';
import { aplicarMigraciones } from '../../../compartido/config/migraciones';

/**
 * Conexión a la base RAG PROPIA del módulo STD (`std_rag`): el corpus, los chunks, los
 * embeddings, las sesiones de chat y la cola de ingesta del STD, en una base de datos
 * FÍSICAMENTE SEPARADA de `seguimiento_app` (el RAG del SGD) — así nunca se mezclan, ni por un
 * JOIN accidental. Vive en el MISMO servidor Postgres (contenedor `db-app`), porque no hace
 * falta un servidor aparte solo por la separación de datos.
 *
 * Por defecto usa las MISMAS credenciales que `APP_DB_*` (mismo servidor, mismo superusuario de
 * la imagen pgvector): `STD_RAG_DB_HOST/PORT/USER/PASS` solo hacen falta si se quiere un usuario
 * o un servidor Postgres distinto para esta base. `STD_RAG_DB_NAME` sí tiene su propio valor por
 * defecto (`std_rag`), porque es lo único que de verdad debe ser distinto de `APP_DB_NAME`.
 */
export const stdRagSequelize = new Sequelize(
  process.env.STD_RAG_DB_NAME ?? 'std_rag',
  process.env.STD_RAG_DB_USER ?? process.env.APP_DB_USER ?? 'seguimiento',
  process.env.STD_RAG_DB_PASS ?? process.env.APP_DB_PASS ?? '',
  {
    host: process.env.STD_RAG_DB_HOST ?? process.env.APP_DB_HOST ?? 'db-app',
    port: Number(process.env.STD_RAG_DB_PORT ?? process.env.APP_DB_PORT ?? 5432),
    dialect: 'postgres',
    logging: false,
    pool: { max: 10, min: 0, idle: 10_000 },
  },
);

/** Nombre de base de datos válido como identificador de Postgres sin comillas dobles ni ';'. */
const NOMBRE_BASE_VALIDO = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Crea la base `std_rag` si no existe todavía. Se conecta a la base de mantenimiento `postgres`
 * del mismo servidor con las credenciales de `APP_DB_*` (el superusuario de la imagen
 * `pgvector/pgvector`, ya necesario para el resto de la app) porque `CREATE DATABASE` no se puede
 * ejecutar dentro de una transacción ni contra la propia base que se está creando.
 *
 * Si falla (por ejemplo, el usuario no tiene privilegio `CREATEDB`), no tumba el arranque: deja
 * la instrucción manual en el log y relanza, para que quien llame decida qué hacer con el resto
 * del arranque del módulo STD.
 */
export async function asegurarBaseStdRag(): Promise<void> {
  const nombre = process.env.STD_RAG_DB_NAME ?? 'std_rag';
  if (!NOMBRE_BASE_VALIDO.test(nombre)) {
    throw new Error(`STD_RAG_DB_NAME="${nombre}" no es un identificador de base de datos válido`);
  }

  const admin = new Sequelize('postgres', process.env.APP_DB_USER ?? 'seguimiento', process.env.APP_DB_PASS ?? '', {
    host: process.env.APP_DB_HOST ?? 'db-app',
    port: Number(process.env.APP_DB_PORT ?? 5432),
    dialect: 'postgres',
    logging: false,
  });

  try {
    const existe = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = :nombre',
      { replacements: { nombre }, type: QueryTypes.SELECT },
    );
    if (existe.length === 0) {
      // No admite bind/replacements (CREATE DATABASE no acepta parámetros); el nombre ya se
      // validó arriba contra NOMBRE_BASE_VALIDO.
      await admin.query(`CREATE DATABASE "${nombre}"`);
      console.log(`Base de datos "${nombre}" creada para el módulo STD.`);
    }
  } catch (error) {
    console.error(
      `No se pudo crear/verificar la base "${nombre}" automáticamente. Créela a mano con: `
        + `CREATE DATABASE "${nombre}";`,
      error,
    );
    throw error;
  } finally {
    await admin.close();
  }
}

const STD_MIGRATIONS_DIR = path.resolve(__dirname, '../../../../migrations/std');

/** Aplica las migraciones de `std_rag` (carpeta `backend/migrations/std/`), aparte de las del SGD. */
export async function aplicarMigracionesStd(): Promise<string[]> {
  return aplicarMigraciones(stdRagSequelize, STD_MIGRATIONS_DIR);
}
