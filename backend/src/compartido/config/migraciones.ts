import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { QueryTypes, type Sequelize } from 'sequelize';
import { appSequelize } from './appDatabase';

/**
 * Migraciones en SQL versionado, aplicadas al arrancar.
 *
 * Sin librería: son unos pocos ficheros y añadir una dependencia de migraciones para esto
 * complicaría más de lo que resuelve. Lo que sí se conserva de una herramienta seria:
 * registro de lo aplicado, verificación por hash y ejecución dentro de una transacción.
 *
 * `db` y `dir` son opcionales (por defecto: la BD propia del SGD y `backend/migrations`). El
 * módulo STD reusa esta misma función para su base `std_rag`, pasando su propia conexión y su
 * propia carpeta (`backend/migrations/std`) — son bases físicamente distintas, así que
 * `public.migracion` de una nunca ve ni interfiere con la de la otra.
 */

const DIR_SGD = path.resolve(__dirname, '../../../migrations');

interface FilaAplicada {
  nombre: string;
  hash: string;
}

export async function aplicarMigraciones(db: Sequelize = appSequelize, dir: string = DIR_SGD): Promise<string[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.migracion (
      nombre     text PRIMARY KEY,
      hash       text NOT NULL,
      fe_aplicada timestamptz NOT NULL DEFAULT now()
    )
  `);

  const aplicadas = await db.query<FilaAplicada>(
    'SELECT nombre, hash FROM public.migracion',
    { type: QueryTypes.SELECT },
  );
  const porNombre = new Map(aplicadas.map((f) => [f.nombre, f.hash]));

  const archivos = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort(); // el prefijo numérico define el orden

  const nuevas: string[] = [];

  for (const archivo of archivos) {
    const sql = fs.readFileSync(path.join(dir, archivo), 'utf8');
    const hash = crypto.createHash('sha256').update(sql).digest('hex');
    const hashPrevio = porNombre.get(archivo);

    if (hashPrevio) {
      // Una migración ya aplicada que cambia de contenido significa que alguien editó el
      // fichero en vez de añadir uno nuevo: la BD y el repositorio han divergido en silencio.
      if (hashPrevio !== hash) {
        throw new Error(
          `La migración ${archivo} cambió después de aplicarse. Cree una migración nueva en vez `
            + 'de editar una existente.',
        );
      }
      continue;
    }

    await db.transaction(async (tx) => {
      await db.query(sql, { transaction: tx });
      await db.query(
        'INSERT INTO public.migracion (nombre, hash) VALUES ($1, $2)',
        { bind: [archivo, hash], transaction: tx },
      );
    });

    nuevas.push(archivo);
  }

  return nuevas;
}
