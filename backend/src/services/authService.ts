import { QueryTypes } from 'sequelize';
import { appSequelize } from '../config/appDatabase';
import { DB_SCHEMA, sequelize } from '../config/database';
import { verificarClaveSgd } from './sgdCipher';

const S = DB_SCHEMA;

const MAX_INTENTOS = Number(process.env.LOGIN_MAX_INTENTOS ?? 10);
const BLOQUEO_MINUTOS = Number(process.env.LOGIN_BLOQUEO_MINUTOS ?? 15);

export interface UsuarioAutenticado {
  codUser: string;
  cempCodemp: string | null;
  nombre: string;
  nuDni: string | null;
  coDependencia: string | null;
  deDependencia: string | null;
  roles: string[];
  permisos: string[];
}

export class AuthError extends Error {
  readonly status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

interface FilaUsuarioSgd {
  cod_user: string;
  cclave: string | null;
  es_usuario: string | null;
  in_ad: string | null;
  cemp_codemp: string | null;
  nombre: string | null;
  nu_dni: string | null;
  co_dependencia: string | null;
  de_dependencia: string | null;
}

/**
 * Lee la credencial del SGD. **SOLO SELECT**: a diferencia del proyecto de referencia, que hace
 * tres UPDATE sobre `seg_usuarios1` (contador de intentos, bloqueo y reset), aquí no se escribe
 * nunca en `idosgd`. Todo el estado de sesión vive en nuestra base.
 */
async function leerUsuarioSgd(codUser: string): Promise<FilaUsuarioSgd | null> {
  const filas = await sequelize.query<FilaUsuarioSgd>(
    `SELECT u.cod_user,
            TRIM(u.cclave)      AS cclave,
            TRIM(u.es_usuario)  AS es_usuario,
            TRIM(u.in_ad)       AS in_ad,
            u.cemp_codemp,
            NULLIF(TRIM(CONCAT_WS(' ', e.cemp_apepat, e.cemp_apemat, e.cemp_denom)), '') AS nombre,
            NULLIF(TRIM(e.cemp_nu_dni), '')   AS nu_dni,
            NULLIF(TRIM(e.cemp_co_depend), '') AS co_dependencia,
            COALESCE(d.de_sigla, e.cemp_co_depend) AS de_dependencia
       FROM ${S}.seg_usuarios1 u
       LEFT JOIN ${S}.rhtm_per_empleados e ON e.cemp_codemp = u.cemp_codemp
       LEFT JOIN ${S}.rhtm_dependencia d ON d.co_dependencia = e.cemp_co_depend
      WHERE LOWER(TRIM(u.cod_user)) = LOWER(TRIM($1))
      LIMIT 1`,
    { bind: [codUser], type: QueryTypes.SELECT },
  );

  return filas[0] ?? null;
}

interface FilaBloqueo {
  fallos: string;
  ultimo: string | null;
}

/**
 * Bloqueo por fuerza bruta, contado en NUESTRA base.
 *
 * Consecuencia inevitable de no escribir en el SGD: un usuario bloqueado allí no lo está aquí y
 * viceversa. Por eso el estado `es_usuario` del SGD se sigue leyendo y respetando (§validarEstado):
 * lo que no se hereda es el contador, no la decisión.
 */
async function minutosBloqueoRestantes(codUser: string): Promise<number> {
  const filas = await appSequelize.query<FilaBloqueo>(
    `SELECT count(*) AS fallos, max(fe_intento)::text AS ultimo
       FROM app.login_intento
      WHERE lower(cod_user) = lower($1)
        AND NOT exito
        AND fe_intento > now() - ($2 || ' minutes')::interval`,
    { bind: [codUser, String(BLOQUEO_MINUTOS)], type: QueryTypes.SELECT },
  );

  const fallos = Number(filas[0]?.fallos ?? 0);
  if (fallos < MAX_INTENTOS || !filas[0]?.ultimo) return 0;

  const desbloqueo = new Date(filas[0].ultimo).getTime() + BLOQUEO_MINUTOS * 60_000;
  return Math.max(0, Math.ceil((desbloqueo - Date.now()) / 60_000));
}

async function registrarIntento(
  codUser: string,
  ip: string | undefined,
  exito: boolean,
  motivo: string | null,
) {
  await appSequelize.query(
    'INSERT INTO app.login_intento (cod_user, ip, exito, motivo) VALUES ($1, $2, $3, $4)',
    { bind: [codUser, ip ?? null, exito, motivo], type: QueryTypes.INSERT },
  );
}

/**
 * Estados de `seg_usuarios1.es_usuario` observados en esta BD ✅: `A` activo (157), `X` (24),
 * `N` debe cambiar clave (3), `B` (3), `I` bloqueado (1). Solo `A` entra; cualquier otro estado
 * —incluidos los no documentados— se rechaza. Es lo correcto por defecto: ante un estado que no
 * sabemos interpretar, no dar acceso.
 */
function validarEstado(fila: FilaUsuarioSgd): string | null {
  if (fila.in_ad === '1') {
    return 'Su cuenta usa autenticación institucional (AD). Contacte al administrador.';
  }

  switch (fila.es_usuario) {
    case 'A':
      return null;
    case 'I':
      return 'Cuenta bloqueada en el SGD. Contacte al administrador.';
    case 'N':
      return 'Debe cambiar su contraseña en el SGD antes de entrar aquí.';
    default:
      return 'Usuario inactivo en el SGD. Contacte al administrador.';
  }
}

interface FilaRol {
  roles: string[] | null;
  permisos: string[] | null;
  habilitado: boolean;
}

/**
 * Refleja el usuario en nuestra base y devuelve sus roles y permisos efectivos.
 *
 * El `INSERT ... ON CONFLICT` mantiene al día nombre y dependencia, que cambian en el SGD sin que
 * nadie nos avise. Los roles NO se tocan aquí: los gestiona el administrador.
 */
export async function sincronizarYCargarRoles(
  fila: FilaUsuarioSgd,
  registrarAcceso: boolean,
): Promise<{ roles: string[]; permisos: string[]; habilitado: boolean }> {
  await appSequelize.query(
    `INSERT INTO app.usuario
       (cod_user, cemp_codemp, nombre, nu_dni, co_dependencia, de_dependencia, fe_ultimo_acceso)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN now() END)
     ON CONFLICT (cod_user) DO UPDATE SET
       cemp_codemp    = EXCLUDED.cemp_codemp,
       nombre         = EXCLUDED.nombre,
       nu_dni         = EXCLUDED.nu_dni,
       co_dependencia = EXCLUDED.co_dependencia,
       de_dependencia = EXCLUDED.de_dependencia,
       fe_ultimo_acceso = COALESCE(EXCLUDED.fe_ultimo_acceso, app.usuario.fe_ultimo_acceso)`,
    {
      bind: [
        fila.cod_user,
        fila.cemp_codemp,
        fila.nombre,
        fila.nu_dni,
        fila.co_dependencia,
        fila.de_dependencia,
        registrarAcceso,
      ],
      type: QueryTypes.INSERT,
    },
  );

  await sembrarRolesIniciales(fila);

  const filas = await appSequelize.query<FilaRol>(
    `SELECT u.habilitado,
            coalesce(array_agg(DISTINCT ur.rol_codigo) FILTER (WHERE ur.rol_codigo IS NOT NULL), '{}')
              AS roles,
            coalesce(array_agg(DISTINCT rp.permiso_codigo) FILTER (WHERE rp.permiso_codigo IS NOT NULL), '{}')
              AS permisos
       FROM app.usuario u
       LEFT JOIN app.usuario_rol ur ON ur.cod_user = u.cod_user
       LEFT JOIN app.rol_permiso rp ON rp.rol_codigo = ur.rol_codigo
      WHERE u.cod_user = $1
      GROUP BY u.habilitado`,
    { bind: [fila.cod_user], type: QueryTypes.SELECT },
  );

  return {
    roles: filas[0]?.roles ?? [],
    permisos: filas[0]?.permisos ?? [],
    habilitado: filas[0]?.habilitado ?? true,
  };
}

/**
 * Siembra el rol inicial desde `ADMIN` / `JEFES` del `.env` la PRIMERA vez que un usuario entra.
 *
 * Solo actúa si el usuario no tiene ningún rol todavía: a partir de ahí manda la BD. Así el
 * `.env` resuelve el arranque en frío —sin esto, una instalación nueva no tendría ningún
 * administrador y nadie podría asignar el primero— sin quedarse como fuente de verdad
 * permanente, que es lo que hace el proyecto de referencia y lo que impide gestionar roles.
 */
async function sembrarRolesIniciales(fila: FilaUsuarioSgd) {
  const dni = String(fila.nu_dni ?? '').trim();
  if (!dni) return;

  const lista = (valor: string | undefined) =>
    (valor ?? '').split(',').map((d) => d.trim()).filter(Boolean);

  let rol: string | null = null;
  if (lista(process.env.ADMIN).includes(dni)) rol = 'admin';
  else if (lista(process.env.JEFES).includes(dni)) rol = 'jefe';
  else rol = 'consulta';

  await appSequelize.query(
    `INSERT INTO app.usuario_rol (cod_user, rol_codigo, asignado_por)
     SELECT $1, $2, 'siembra-inicial'
      WHERE NOT EXISTS (SELECT 1 FROM app.usuario_rol WHERE cod_user = $1)
     ON CONFLICT DO NOTHING`,
    { bind: [fila.cod_user, rol], type: QueryTypes.INSERT },
  );
}

export async function login(
  codUser: string,
  password: string,
  ip?: string,
): Promise<UsuarioAutenticado> {
  const usuario = String(codUser ?? '').trim();

  const bloqueo = await minutosBloqueoRestantes(usuario);
  if (bloqueo > 0) {
    throw new AuthError(
      `Demasiados intentos fallidos. Vuelva a intentarlo en ${bloqueo} minuto(s).`,
      429,
    );
  }

  const fila = await leerUsuarioSgd(usuario);

  // Mismo mensaje para "no existe" y "clave incorrecta": distinguirlos permite enumerar usuarios.
  // El motivo real sí queda registrado en `login_intento` para quien audite.
  if (!fila) {
    await registrarIntento(usuario, ip, false, 'usuario inexistente');
    throw new AuthError('Usuario o contraseña incorrectos.');
  }

  const problema = validarEstado(fila);
  if (problema) {
    await registrarIntento(fila.cod_user, ip, false, `estado ${fila.es_usuario}/${fila.in_ad}`);
    throw new AuthError(problema, 403);
  }

  if (!verificarClaveSgd(password, fila.cclave)) {
    await registrarIntento(fila.cod_user, ip, false, 'clave incorrecta');
    const restantes = MAX_INTENTOS - (await contarFallosRecientes(fila.cod_user));
    throw new AuthError(
      restantes > 0
        ? `Usuario o contraseña incorrectos. Intentos restantes: ${restantes}.`
        : `Demasiados intentos fallidos. Vuelva a intentarlo en ${BLOQUEO_MINUTOS} minuto(s).`,
    );
  }

  const { roles, permisos, habilitado } = await sincronizarYCargarRoles(fila, true);

  if (!habilitado) {
    await registrarIntento(fila.cod_user, ip, false, 'deshabilitado en la aplicación');
    throw new AuthError('Su acceso a esta aplicación está deshabilitado.', 403);
  }

  await registrarIntento(fila.cod_user, ip, true, null);

  return {
    codUser: fila.cod_user,
    cempCodemp: fila.cemp_codemp,
    nombre: fila.nombre ?? fila.cod_user,
    nuDni: fila.nu_dni,
    coDependencia: fila.co_dependencia,
    deDependencia: fila.de_dependencia,
    roles,
    permisos,
  };
}

async function contarFallosRecientes(codUser: string): Promise<number> {
  const filas = await appSequelize.query<{ n: string }>(
    `SELECT count(*) AS n FROM app.login_intento
      WHERE lower(cod_user) = lower($1) AND NOT exito
        AND fe_intento > now() - ($2 || ' minutes')::interval`,
    { bind: [codUser, String(BLOQUEO_MINUTOS)], type: QueryTypes.SELECT },
  );
  return Number(filas[0]?.n ?? 0);
}

/**
 * Estado actual del usuario para cada request autenticada.
 *
 * El middleware llama a esto en vez de fiarse del JWT: si a alguien se le retira el rol admin, la
 * retirada debe surtir efecto de inmediato, no cuando caduque su token ocho horas después.
 */
export async function estadoActual(codUser: string): Promise<{
  roles: string[];
  permisos: string[];
  habilitado: boolean;
} | null> {
  const filas = await appSequelize.query<FilaRol>(
    `SELECT u.habilitado,
            coalesce(array_agg(DISTINCT ur.rol_codigo) FILTER (WHERE ur.rol_codigo IS NOT NULL), '{}')
              AS roles,
            coalesce(array_agg(DISTINCT rp.permiso_codigo) FILTER (WHERE rp.permiso_codigo IS NOT NULL), '{}')
              AS permisos
       FROM app.usuario u
       LEFT JOIN app.usuario_rol ur ON ur.cod_user = u.cod_user
       LEFT JOIN app.rol_permiso rp ON rp.rol_codigo = ur.rol_codigo
      WHERE u.cod_user = $1
      GROUP BY u.habilitado`,
    { bind: [codUser], type: QueryTypes.SELECT },
  );

  if (filas.length === 0) return null;

  return {
    roles: filas[0].roles ?? [],
    permisos: filas[0].permisos ?? [],
    habilitado: filas[0].habilitado,
  };
}
