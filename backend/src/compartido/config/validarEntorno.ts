import { z } from 'zod';

/**
 * Validación del `.env` al arrancar, antes de escuchar.
 *
 * Sin esto, un `JWT_SECRET` ausente no se nota hasta que alguien intenta entrar, y un
 * `SGD_SECRET_KEY_PASSWORD` equivocado se manifiesta como "contraseña incorrecta" para todo el
 * mundo — un fallo de configuración disfrazado de fallo de credenciales, que es de los que
 * cuestan una tarde de diagnóstico.
 */
const esquema = z.object({
  DB_HOST: z.string().min(1, 'DB_HOST es obligatorio'),
  DB_NAME: z.string().min(1, 'DB_NAME es obligatorio'),
  DB_USER: z.string().min(1, 'DB_USER es obligatorio'),
  DB_PASS: z.string().min(1, 'DB_PASS es obligatorio'),

  APP_DB_HOST: z.string().min(1, 'APP_DB_HOST es obligatorio (BD propia)'),
  APP_DB_NAME: z.string().min(1, 'APP_DB_NAME es obligatorio (BD propia)'),
  APP_DB_USER: z.string().min(1, 'APP_DB_USER es obligatorio (BD propia)'),
  APP_DB_PASS: z.string().min(1, 'APP_DB_PASS es obligatorio (BD propia)'),

  // 128 hex = 64 bytes. Se exige longitud para que nadie lo deje en un valor de ejemplo.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  SGD_SECRET_KEY_PASSWORD: z
    .string()
    .min(1, 'SGD_SECRET_KEY_PASSWORD es obligatorio para validar las credenciales del SGD'),
});

export function validarEntorno(): void {
  const resultado = esquema.safeParse(process.env);

  if (!resultado.success) {
    const problemas = resultado.error.issues
      .map((i) => `  - ${String(i.path[0])}: ${i.message}`)
      .join('\n');
    console.error(`Configuración inválida en el .env:\n${problemas}`);
    process.exit(1);
  }
}
