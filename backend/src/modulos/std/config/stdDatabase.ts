import { QueryTypes, Sequelize } from 'sequelize';

/**
 * Conexión al STD (Sistema de Trámite Documentario de UE118/PMESUT): MariaDB en un servidor
 * aparte del SGD. Ver la skill `std-database` (`.claude/skills/std-database/STD_DATABASE.md`)
 * para el mapa completo del esquema, las consultas canónicas y la regla de archivos.
 *
 * **Solo lectura, en tres capas — ninguna basta por sí sola:**
 *   1. `STD_DB_USER` debe ser un usuario de MariaDB con únicamente `GRANT SELECT` (se documenta
 *      en el `.env`; esta app no puede verificarlo desde aquí, es responsabilidad de quien
 *      aprovisiona la base).
 *   2. `SET SESSION TRANSACTION READ ONLY` en cada conexión nueva del pool (`afterConnect`): si
 *      el usuario tuviera permisos de escritura por error de configuración, MariaDB rechaza
 *      igual cualquier INSERT/UPDATE/DELETE/DDL dentro de esa sesión.
 *   3. `consultarStd()` es el ÚNICO punto de acceso que el resto del módulo STD usa, y rechaza
 *      en el propio proceso Node cualquier sentencia que no empiece por SELECT/WITH, antes de
 *      mandarla al servidor.
 *
 * `STD_HABILITADO` es el interruptor general: el STD es un sistema que ya casi no se usa y el
 * usuario puede no tener sus credenciales a mano todavía. Con `STD_HABILITADO=false` (o sin
 * configurar), ningún código de este módulo intenta conectarse — ver `stdDisponible()`.
 */

export const STD_HABILITADO = (process.env.STD_HABILITADO ?? 'false').toLowerCase() === 'true';

/**
 * `false` si el módulo está apagado por `.env`, o si falta alguna variable imprescindible para
 * conectarse pese a estar "encendido" — evita que el backend entero no arranque por un STD a
 * medio configurar (ver `validarEntorno.ts`, donde STD es opcional incluso con el interruptor en
 * `true`, siempre que esta función sea la que decide si de verdad hay con qué conectarse).
 */
export function stdDisponible(): { disponible: boolean; motivo: string | null } {
  if (!STD_HABILITADO) return { disponible: false, motivo: 'STD_HABILITADO no está activado' };
  if (!process.env.STD_DB_HOST) return { disponible: false, motivo: 'Falta STD_DB_HOST' };
  if (!process.env.STD_DB_USER) return { disponible: false, motivo: 'Falta STD_DB_USER' };
  if (!process.env.STD_DB_PASS) return { disponible: false, motivo: 'Falta STD_DB_PASS' };
  return { disponible: true, motivo: null };
}

/**
 * `dateStrings: true` evita que `mysql2` reconvierta los DATE/DATETIME/TIMESTAMP del STD con la
 * zona horaria del proceso Node: se guardan como `America/Lima` en MariaDB (igual razón que
 * `config/database.ts` del SGD con el type parser de `pg`), así que se leen y se devuelven como
 * el string literal que hay en la BD, sin que nadie los reinterprete por el camino.
 */
export const stdSequelize = new Sequelize(
  process.env.STD_DB_NAME ?? 'stdpmesut_db_pmesut',
  process.env.STD_DB_USER ?? '',
  process.env.STD_DB_PASS,
  {
    host: process.env.STD_DB_HOST,
    port: Number(process.env.STD_DB_PORT ?? 3306),
    dialect: 'mysql',
    timezone: '-05:00',
    dialectOptions: { dateStrings: true },
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
    pool: { max: 5, min: 0, idle: 10_000 },
    hooks: {
      // El objeto que llega aquí es la conexión `mysql2` interna de Sequelize, de API callback
      // (no `mysql2/promise`): hay que envolverla en una Promise a mano para poder `await`la.
      afterConnect: (connection: unknown) =>
        new Promise<void>((resolve, reject) => {
          (connection as { query: (sql: string, cb: (err: Error | null) => void) => void }).query(
            'SET SESSION TRANSACTION READ ONLY',
            (err) => (err ? reject(err) : resolve()),
          );
        }),
    },
  },
);

export class ConsultaStdNoPermitida extends Error {
  constructor() {
    super('consultarStd solo admite SELECT/WITH: la base del STD es de solo lectura.');
    this.name = 'ConsultaStdNoPermitida';
  }
}

const SENTENCIA_PERMITIDA = /^\s*(SELECT|WITH)\b/i;

/**
 * Único punto de acceso a la BD del STD. Reemplazos CON NOMBRE (`:clave`), igual que el SQL
 * original de la app PHP legada (`lib/MySqlQuery.php`) — así las consultas canónicas documentadas
 * en la skill `std-database` se pueden reutilizar casi literalmente, sin traducir a `$1`/`?`.
 */
export async function consultarStd<T extends object = Record<string, unknown>>(
  sql: string,
  replacements?: Record<string, unknown>,
): Promise<T[]> {
  if (!SENTENCIA_PERMITIDA.test(sql)) throw new ConsultaStdNoPermitida();
  return stdSequelize.query<T>(sql, { replacements, type: QueryTypes.SELECT });
}
