import { QueryTypes } from 'sequelize';
import { appSequelize } from '../config/appDatabase';

/**
 * Configuración en caliente, en `app.config`.
 *
 * Vive en la BD y no en el `.env` porque el interruptor del barrido debe poder cambiarse desde la
 * interfaz sin reconstruir ni reiniciar el contenedor — que es justo lo contrario de "mantener el
 * control". Una sola fuente de verdad: no hay override por entorno, para que nunca haya duda de
 * por qué el barrido está apagado.
 */

export async function leerConfig(clave: string): Promise<string | null> {
  const filas = await appSequelize.query<{ valor: string }>(
    'SELECT valor FROM app.config WHERE clave = $1',
    { bind: [clave], type: QueryTypes.SELECT },
  );
  return filas[0]?.valor ?? null;
}

export async function leerBooleano(clave: string, porDefecto = false): Promise<boolean> {
  const valor = await leerConfig(clave);
  if (valor === null) return porDefecto;
  return valor === 'true' || valor === '1';
}

/**
 * Ojo con el `null`: `Number(null)` es `0`, no `NaN`, así que una clave AUSENTE devolvía `0` en vez
 * del valor por defecto. Con `rag.retencion.dias` eso sería "retener 0 días", con
 * `*.cadencia_min` "correr en cada tick", y con `calidad.proceso.similitud_min` "agrupar todos los
 * procesos en uno". El caso solo aparece si falta la fila que siembra la migración, pero el modo de
 * fallo es lo bastante silencioso como para no dejarlo librado a eso.
 */
export async function leerNumero(clave: string, porDefecto: number): Promise<number> {
  const crudo = await leerConfig(clave);
  if (crudo === null || crudo.trim() === '') return porDefecto;
  const valor = Number(crudo);
  return Number.isFinite(valor) ? valor : porDefecto;
}

export async function escribirConfig(clave: string, valor: string, actor: string): Promise<void> {
  await appSequelize.query(
    `INSERT INTO app.config (clave, valor, mod_por, fe_mod) VALUES ($1, $2, $3, now())
     ON CONFLICT (clave) DO UPDATE SET valor = $2, mod_por = $3, fe_mod = now()`,
    { bind: [clave, valor, actor], type: QueryTypes.INSERT },
  );

  // Un interruptor que gobierna cuánto se gasta en LLM debe dejar rastro de quién lo tocó.
  await appSequelize.query(
    `INSERT INTO app.auditoria (actor, accion, detalle) VALUES ($1, 'config.cambiar', $2::jsonb)`,
    { bind: [actor, JSON.stringify({ clave, valor })], type: QueryTypes.INSERT },
  );
}

export async function listarConfig(): Promise<
  { clave: string; valor: string; descripcion: string | null; feMod: string | null; modPor: string | null }[]
> {
  return appSequelize.query(
    `SELECT clave, valor, descripcion, fe_mod::text AS "feMod", mod_por AS "modPor"
       FROM app.config ORDER BY clave`,
    { type: QueryTypes.SELECT },
  );
}
