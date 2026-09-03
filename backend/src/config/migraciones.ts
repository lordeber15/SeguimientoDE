import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { QueryTypes } from 'sequelize';
import { appSequelize } from './appDatabase';

/**
 * Migraciones en SQL versionado, aplicadas al arrancar.
 *
 * Sin librería: son unos pocos ficheros y añadir una dependencia de migraciones para esto
 * complicaría más de lo que resuelve. Lo que sí se conserva de una herramienta seria:
 * registro de lo aplicado, verificación por hash y ejecución dentro de una transacción.
 */

const DIR = path.resolve(__dirname, '../../migrations');

interface FilaAplicada {
  nombre: string;
  hash: string;
}

export async function aplicarMigraciones(): Promise<string[]> {
  await appSequelize.query(`
    CREATE TABLE IF NOT EXISTS public.migracion (
      nombre     text PRIMARY KEY,
      hash       text NOT NULL,
      fe_aplicada timestamptz NOT NULL DEFAULT now()
    )
  `);

  const aplicadas = await appSequelize.query<FilaAplicada>(
    'SELECT nombre, hash FROM public.migracion',
    { type: QueryTypes.SELECT },
  );
  const porNombre = new Map(aplicadas.map((f) => [f.nombre, f.hash]));

  const archivos = fs
    .readdirSync(DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort(); // el prefijo numérico define el orden

  const nuevas: string[] = [];

  for (const archivo of archivos) {
    const sql = fs.readFileSync(path.join(DIR, archivo), 'utf8');
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

    await appSequelize.transaction(async (tx) => {
      await appSequelize.query(sql, { transaction: tx });
      await appSequelize.query(
        'INSERT INTO public.migracion (nombre, hash) VALUES ($1, $2)',
        { bind: [archivo, hash], transaction: tx },
      );
    });

    nuevas.push(archivo);
  }

  return nuevas;
}
