-- Esquema de la aplicación: usuarios, roles, permisos, intentos de login y auditoría.
--
-- Nada de esto vive en la BD del SGD. La política de solo lectura sobre `idosgd` obliga a
-- llevar aquí todo lo que el sistema necesita escribir — incluido el contador de intentos
-- fallidos, que el proyecto de referencia guardaba con un UPDATE sobre `seg_usuarios1`.

CREATE SCHEMA IF NOT EXISTS app;

-- Espejo local del usuario del SGD. No guarda contraseñas: la credencial se valida siempre
-- contra `idosgd.seg_usuarios1`. Existe para poder colgar roles y auditoría de una FK estable
-- y para que el administrador vea a quién ha entrado sin consultar el SGD.
CREATE TABLE IF NOT EXISTS app.usuario (
  cod_user          text PRIMARY KEY,
  cemp_codemp       text,
  nombre            text,
  nu_dni            text,
  co_dependencia    text,
  de_dependencia    text,
  -- Bloqueo LOCAL, independiente del `es_usuario` del SGD: un administrador puede vetar el
  -- acceso a esta aplicación sin tocar la cuenta del SGD.
  habilitado        boolean     NOT NULL DEFAULT true,
  fe_alta           timestamptz NOT NULL DEFAULT now(),
  fe_ultimo_acceso  timestamptz
);

CREATE INDEX IF NOT EXISTS usuario_nu_dni_idx ON app.usuario (nu_dni);

CREATE TABLE IF NOT EXISTS app.rol (
  codigo      text PRIMARY KEY,
  nombre      text NOT NULL,
  descripcion text,
  -- Los roles base no se pueden borrar: sin `admin` nadie podría volver a administrar.
  del_sistema boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS app.permiso (
  codigo      text PRIMARY KEY,
  descripcion text NOT NULL
);

CREATE TABLE IF NOT EXISTS app.rol_permiso (
  rol_codigo     text NOT NULL REFERENCES app.rol(codigo)     ON DELETE CASCADE,
  permiso_codigo text NOT NULL REFERENCES app.permiso(codigo) ON DELETE CASCADE,
  PRIMARY KEY (rol_codigo, permiso_codigo)
);

CREATE TABLE IF NOT EXISTS app.usuario_rol (
  cod_user       text        NOT NULL REFERENCES app.usuario(cod_user) ON DELETE CASCADE,
  rol_codigo     text        NOT NULL REFERENCES app.rol(codigo)       ON DELETE CASCADE,
  asignado_por   text,
  fe_asignacion  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cod_user, rol_codigo)
);

-- Intentos de login. Es la fuente del bloqueo por fuerza bruta y la bitácora de accesos.
-- `cod_user` NO es FK: hay que poder registrar intentos con usuarios inexistentes, que son
-- justo los que interesa vigilar.
CREATE TABLE IF NOT EXISTS app.login_intento (
  id         bigserial PRIMARY KEY,
  cod_user   text        NOT NULL,
  ip         text,
  exito      boolean     NOT NULL,
  motivo     text,
  fe_intento timestamptz NOT NULL DEFAULT now()
);

-- Índice para la consulta del bloqueo: "fallos de este usuario desde tal instante".
CREATE INDEX IF NOT EXISTS login_intento_user_fe_idx
  ON app.login_intento (cod_user, fe_intento DESC) WHERE NOT exito;

-- BRIN para la retención por fecha: la tabla crece sin límite y solo se recorre por rangos.
CREATE INDEX IF NOT EXISTS login_intento_fe_brin_idx
  ON app.login_intento USING brin (fe_intento);

CREATE TABLE IF NOT EXISTS app.auditoria (
  id      bigserial PRIMARY KEY,
  actor   text,
  accion  text NOT NULL,
  detalle jsonb,
  fe      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auditoria_fe_brin_idx ON app.auditoria USING brin (fe);

-- Configuración en caliente. La usará el interruptor del barrido RAG (Fase 3) y cualquier
-- ajuste que deba cambiarse sin reiniciar el contenedor.
CREATE TABLE IF NOT EXISTS app.config (
  clave       text PRIMARY KEY,
  valor       text NOT NULL,
  descripcion text,
  fe_mod      timestamptz NOT NULL DEFAULT now(),
  mod_por     text
);

-- ── Datos base ──────────────────────────────────────────────────────────────

INSERT INTO app.rol (codigo, nombre, descripcion, del_sistema) VALUES
  ('admin',    'Administrador', 'Acceso total, incluida la gestión de usuarios y roles', true),
  ('jefe',     'Jefe',          'Consulta de todas las dependencias', true),
  ('consulta', 'Consulta',      'Consulta limitada a su propia dependencia', true)
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO app.permiso (codigo, descripcion) VALUES
  ('seguimiento.ver',   'Consultar expedientes y tiempos de atención'),
  ('documentos.ver',    'Ver documentos y anexos'),
  ('pdf.unificar',      'Generar el PDF unificado de un expediente'),
  ('usuarios.gestionar','Administrar usuarios y roles'),
  ('auditoria.ver',     'Consultar la auditoría y los intentos de acceso')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO app.rol_permiso (rol_codigo, permiso_codigo) VALUES
  ('admin',    'seguimiento.ver'),
  ('admin',    'documentos.ver'),
  ('admin',    'pdf.unificar'),
  ('admin',    'usuarios.gestionar'),
  ('admin',    'auditoria.ver'),
  ('jefe',     'seguimiento.ver'),
  ('jefe',     'documentos.ver'),
  ('jefe',     'pdf.unificar'),
  ('consulta', 'seguimiento.ver'),
  ('consulta', 'documentos.ver')
ON CONFLICT DO NOTHING;
