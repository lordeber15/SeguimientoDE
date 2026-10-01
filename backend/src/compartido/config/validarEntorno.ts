import { z } from 'zod';

/**
 * Validación del `.env` al arrancar, antes de escuchar.
 *
 * Sin esto, un `JWT_SECRET` ausente no se nota hasta que alguien intenta entrar, y un
 * `SGD_SECRET_KEY_PASSWORD` equivocado se manifiesta como "contraseña incorrecta" para todo el
 * mundo — un fallo de configuración disfrazado de fallo de credenciales, que es de los que
 * cuestan una tarde de diagnóstico.
 */
const esquemaBase = z.object({
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

/**
 * El STD (Sistema de Trámite Documentario de UE118/PMESUT) es OPCIONAL: un sistema legado que ya
 * casi no se usa, y el backend debe poder arrancar igual aunque el usuario todavía no tenga sus
 * credenciales a mano. Por eso este esquema solo se exige cuando `STD_HABILITADO=true` — con el
 * interruptor apagado (o sin definir), ninguna de estas variables se valida ni hace falta.
 */
const esquemaStd = z.object({
  STD_DB_HOST: z.string().min(1, 'STD_DB_HOST es obligatorio cuando STD_HABILITADO=true'),
  STD_DB_NAME: z.string().min(1, 'STD_DB_NAME es obligatorio cuando STD_HABILITADO=true'),
  STD_DB_USER: z.string().min(1, 'STD_DB_USER es obligatorio cuando STD_HABILITADO=true'),
  STD_DB_PASS: z.string().min(1, 'STD_DB_PASS es obligatorio cuando STD_HABILITADO=true'),
});

function stdHabilitado(): boolean {
  return (process.env.STD_HABILITADO ?? 'false').toLowerCase() === 'true';
}

export function validarEntorno(): void {
  const problemas: string[] = [];

  const base = esquemaBase.safeParse(process.env);
  if (!base.success) {
    problemas.push(...base.error.issues.map((i) => `  - ${String(i.path[0])}: ${i.message}`));
  }

  if (stdHabilitado()) {
    const std = esquemaStd.safeParse(process.env);
    if (!std.success) {
      problemas.push(...std.error.issues.map((i) => `  - ${String(i.path[0])}: ${i.message}`));
    }
  }

  if (problemas.length > 0) {
    console.error(`Configuración inválida en el .env:\n${problemas.join('\n')}`);
    process.exit(1);
  }
}
