-- Fase 5: retrieval híbrido y chat sobre el corpus RAG. Ver docs/PLAN-RAG.md §9-10 y
-- docs/PLAN-RAG-IMPLEMENTACION.md (sección de Fase 5).
--
-- Las citas se persisten ANTES de llamar al proveedor de chat, con el `numero` que verá el
-- usuario como "[Dn]": así un marcador siempre resuelve a una fila real, aunque el modelo
-- alucine un número que no se ofreció. Guardan `documento_id`, nunca solo `chunk_id`: con el
-- ~13 % de contenido compartido entre documentos (D3/D7), citar solo el chunk puede señalar un
-- documento que el usuario que hizo la pregunta no tiene permiso de ver.

CREATE TABLE IF NOT EXISTS rag.chat_sesion (
  id            bigserial PRIMARY KEY,
  usuario_id    text NOT NULL REFERENCES app.usuario(cod_user),
  modo          text NOT NULL CHECK (modo IN ('general','expediente')),
  -- NULL en modo 'general'. Igual que rag.documento: cadena vacía, nunca NULL, para "sin expediente".
  nu_ann_exp    text,
  nu_sec_exp    text,
  fe_alta       timestamptz NOT NULL DEFAULT now(),
  fe_ultimo_msg timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_sesion_usuario_idx
  ON rag.chat_sesion (usuario_id, fe_ultimo_msg DESC);

CREATE TABLE IF NOT EXISTS rag.chat_mensaje (
  id          bigserial PRIMARY KEY,
  sesion_id   bigint NOT NULL REFERENCES rag.chat_sesion(id) ON DELETE CASCADE,
  rol         text NOT NULL CHECK (rol IN ('user','assistant')),
  texto       text NOT NULL,
  tokens_in   integer,
  tokens_out  integer,
  fe_alta     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_mensaje_sesion_idx ON rag.chat_mensaje (sesion_id, id);

CREATE TABLE IF NOT EXISTS rag.cita (
  id            bigserial PRIMARY KEY,
  mensaje_id    bigint  NOT NULL REFERENCES rag.chat_mensaje(id) ON DELETE CASCADE,
  -- El "n" de "[Dn]", asignado antes de llamar al proveedor de chat.
  numero        integer NOT NULL,
  chunk_id      bigint  NOT NULL REFERENCES rag.chunk(id),
  -- Por CUÁL documento se ofreció la cita (nunca solo el chunk: ver comentario de cabecera).
  documento_id  bigint  NOT NULL REFERENCES rag.documento(id),
  -- true si el modelo citó de verdad ese "[Dn]" en su respuesta; false = se ofreció como
  -- contexto pero no se usó. Distingue "no se citó" de "se citó y era falso" (ver retrieval_log).
  usada         boolean NOT NULL DEFAULT false,
  UNIQUE (mensaje_id, numero)
);

CREATE TABLE IF NOT EXISTS rag.retrieval_log (
  id                     bigserial PRIMARY KEY,
  sesion_id              bigint REFERENCES rag.chat_sesion(id) ON DELETE SET NULL,
  consulta               text NOT NULL,
  modo                   text NOT NULL,
  candidatos_vec         integer NOT NULL,
  candidatos_fts         integer NOT NULL,
  fusionados             integer NOT NULL,
  escaneo_exacto         boolean NOT NULL,
  marcadores_alucinados  integer NOT NULL DEFAULT 0,
  ms                     integer NOT NULL,
  fe                     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS retrieval_log_fe_idx ON rag.retrieval_log USING brin (fe);

-- Permiso de consulta del chat: ya existe desde la migración 003 (`rag.consultar`, concedido a
-- admin y jefe). No hace falta tocarlo aquí.
