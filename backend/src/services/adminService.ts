import { QueryTypes } from 'sequelize';
import { appSequelize } from '../config/appDatabase';
import { DB_SCHEMA, sequelize } from '../config/database';

const S = DB_SCHEMA;

export class AdminError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'AdminError';
    this.status = status;
  }
}

export interface UsuarioAdmin {
  codUser: string;
  nombre: string | null;
  nuDni: string | null;
  coDependencia: string | null;
  deDependencia: string | null;
  habilitado: boolean;
  feUltimoAcceso: string | null;
  roles: string[];
  /** Estado en el SGD: puede ser distinto del nuestro y hay que verlo antes de dar acceso. */
  estadoSgd: string | null;
  existeEnSgd: boolean;
}

/**
 * Usuarios que este sistema conoce, cruzados con su estado actual en el SGD.
 *
 * El cruce no se puede hacer con un JOIN: son dos servidores distintos. Se traen las dos listas y
 * se combinan en memoria — son 188 usuarios, no hay problema de escala.
 */
export async function listarUsuarios(): Promise<UsuarioAdmin[]> {
  const locales = await appSequelize.query<{
    cod_user: string;
    nombre: string | null;
    nu_dni: string | null;
    co_dependencia: string | null;
    de_dependencia: string | null;
    habilitado: boolean;
    fe_ultimo_acceso: string | null;
    roles: string[] | null;
  }>(
    `SELECT u.cod_user, u.nombre, u.nu_dni, u.co_dependencia, u.de_dependencia, u.habilitado,
            u.fe_ultimo_acceso::text,
            coalesce(array_agg(ur.rol_codigo) FILTER (WHERE ur.rol_codigo IS NOT NULL), '{}') AS roles
       FROM app.usuario u
       LEFT JOIN app.usuario_rol ur ON ur.cod_user = u.cod_user
      GROUP BY u.cod_user
      ORDER BY u.nombre NULLS LAST, u.cod_user`,
    { type: QueryTypes.SELECT },
  );

  const estados = await sequelize.query<{ cod_user: string; es_usuario: string | null }>(
    `SELECT cod_user, TRIM(es_usuario) AS es_usuario FROM ${S}.seg_usuarios1`,
    { type: QueryTypes.SELECT },
  );
  const porCodigo = new Map(estados.map((e) => [e.cod_user.trim().toLowerCase(), e.es_usuario]));

  return locales.map((u) => {
    const clave = u.cod_user.trim().toLowerCase();
    return {
      codUser: u.cod_user,
      nombre: u.nombre,
      nuDni: u.nu_dni,
      coDependencia: u.co_dependencia,
      deDependencia: u.de_dependencia,
      habilitado: u.habilitado,
      feUltimoAcceso: u.fe_ultimo_acceso,
      roles: u.roles ?? [],
      estadoSgd: porCodigo.get(clave) ?? null,
      existeEnSgd: porCodigo.has(clave),
    };
  });
}

export async function listarRoles() {
  return appSequelize.query(
    `SELECT r.codigo, r.nombre, r.descripcion, r.del_sistema AS "delSistema",
            coalesce(array_agg(rp.permiso_codigo) FILTER (WHERE rp.permiso_codigo IS NOT NULL), '{}')
              AS permisos,
            (SELECT count(*) FROM app.usuario_rol ur WHERE ur.rol_codigo = r.codigo)::int
              AS usuarios
       FROM app.rol r
       LEFT JOIN app.rol_permiso rp ON rp.rol_codigo = r.codigo
      GROUP BY r.codigo
      ORDER BY r.codigo`,
    { type: QueryTypes.SELECT },
  );
}

async function auditar(actor: string, accion: string, detalle: unknown) {
  await appSequelize.query(
    'INSERT INTO app.auditoria (actor, accion, detalle) VALUES ($1, $2, $3::jsonb)',
    { bind: [actor, accion, JSON.stringify(detalle)], type: QueryTypes.INSERT },
  );
}

/**
 * Reemplaza los roles de un usuario.
 *
 * Protege el caso que deja el sistema inservible: quitarle el rol `admin` al último
 * administrador. Se comprueba dentro de la transacción para que dos peticiones simultáneas no
 * puedan dejar cero administradores entre las dos.
 */
export async function asignarRoles(codUser: string, roles: string[], actor: string) {
  const unicos = [...new Set(roles.map((r) => r.trim()).filter(Boolean))];

  await appSequelize.transaction(async (tx) => {
    const existe = await appSequelize.query<{ n: string }>(
      'SELECT count(*) AS n FROM app.usuario WHERE cod_user = $1',
      { bind: [codUser], type: QueryTypes.SELECT, transaction: tx },
    );
    if (Number(existe[0]?.n ?? 0) === 0) {
      throw new AdminError('El usuario no existe. Debe entrar al menos una vez.', 404);
    }

    const validos = await appSequelize.query<{ codigo: string }>(
      'SELECT codigo FROM app.rol WHERE codigo = ANY($1::text[])',
      { bind: [unicos], type: QueryTypes.SELECT, transaction: tx },
    );
    if (validos.length !== unicos.length) {
      const conocidos = new Set(validos.map((r) => r.codigo));
      const malos = unicos.filter((r) => !conocidos.has(r));
      throw new AdminError(`Rol desconocido: ${malos.join(', ')}`, 400);
    }

    await appSequelize.query('DELETE FROM app.usuario_rol WHERE cod_user = $1', {
      bind: [codUser],
      type: QueryTypes.DELETE,
      transaction: tx,
    });

    if (unicos.length > 0) {
      await appSequelize.query(
        `INSERT INTO app.usuario_rol (cod_user, rol_codigo, asignado_por)
         SELECT $1, unnest($2::text[]), $3`,
        { bind: [codUser, unicos, actor], type: QueryTypes.INSERT, transaction: tx },
      );
    }

    await verificarQuedaAdmin(tx);
  });

  await auditar(actor, 'roles.asignar', { codUser, roles: unicos });
}

export async function cambiarHabilitado(codUser: string, habilitado: boolean, actor: string) {
  if (!habilitado && codUser === actor) {
    throw new AdminError('No puede deshabilitarse a sí mismo.', 400);
  }

  await appSequelize.transaction(async (tx) => {
    const filas = await appSequelize.query(
      'UPDATE app.usuario SET habilitado = $2 WHERE cod_user = $1 RETURNING cod_user',
      { bind: [codUser, habilitado], type: QueryTypes.SELECT, transaction: tx },
    );
    if (filas.length === 0) throw new AdminError('El usuario no existe.', 404);

    await verificarQuedaAdmin(tx);
  });

  await auditar(actor, habilitado ? 'usuario.habilitar' : 'usuario.deshabilitar', { codUser });
}

/**
 * Impide dejar el sistema sin ningún administrador **activo**. Un admin deshabilitado no cuenta:
 * no podría entrar a arreglarlo.
 */
async function verificarQuedaAdmin(tx: unknown) {
  const filas = await appSequelize.query<{ n: string }>(
    `SELECT count(*) AS n
       FROM app.usuario_rol ur
       JOIN app.usuario u ON u.cod_user = ur.cod_user
      WHERE ur.rol_codigo = 'admin' AND u.habilitado`,
    { type: QueryTypes.SELECT, transaction: tx as never },
  );

  if (Number(filas[0]?.n ?? 0) === 0) {
    throw new AdminError(
      'La operación dejaría el sistema sin ningún administrador activo.',
      409,
    );
  }
}

export async function listarAccesos(limite = 100) {
  return appSequelize.query(
    `SELECT cod_user AS "codUser", ip, exito, motivo, fe_intento::text AS "feIntento"
       FROM app.login_intento
      ORDER BY fe_intento DESC
      LIMIT $1`,
    { bind: [Math.min(limite, 500)], type: QueryTypes.SELECT },
  );
}
