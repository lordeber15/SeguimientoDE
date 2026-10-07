-- Trazas del chat y recuperación de turnos fallidos (docs/PLAN-RAG-AVANZADO.md, Fase 2).
-- Misma estructura en std_rag (migrations/std/004_chat_trazas.sql): cada módulo guarda sus trazas
-- junto a su chat.

-- Un turno del chat = una traza. `id` es el trace id de OpenTelemetry (32 hex), el mismo que se
-- exporta a Langfuse si está configurado, para poder cruzar ambos. Un reintento de un turno fallido
-- CONTINÚA la misma traza: suma ms y tokens y deja el estado del último intento.
CREATE TABLE IF NOT EXISTS rag.traza (
  id          text PRIMARY KEY,
  modulo      text        NOT NULL CHECK (modulo IN ('sgd', 'std')),
  nombre      text        NOT NULL,
  usuario_id  text        NOT NULL,
  sesion_id   bigint,
  mensaje_id  bigint,
  entrada     jsonb,
  salida      jsonb,
  estado      text        NOT NULL CHECK (estado IN ('ok', 'error')),
  error       text,
  ms          integer     NOT NULL,
  tokens_in   integer     NOT NULL DEFAULT 0,
  tokens_out  integer     NOT NULL DEFAULT 0,
  reintentos  integer     NOT NULL DEFAULT 0,
  fe_inicio   timestamptz NOT NULL,
  fe_fin      timestamptz
);

CREATE INDEX IF NOT EXISTS traza_fe_idx ON rag.traza USING brin (fe_inicio);
CREATE INDEX IF NOT EXISTS traza_sesion_idx ON rag.traza (sesion_id) WHERE sesion_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS traza_error_idx ON rag.traza (fe_inicio DESC) WHERE estado = 'error';

-- Pasos (spans): planificador, retrieval, rerank, generación, llamadas al modelo, embeddings y
-- eventos (reintentos, degradación). `padre_id` NULL = raíz de una ejecución de la traza.
CREATE TABLE IF NOT EXISTS rag.traza_paso (
  traza_id   text        NOT NULL REFERENCES rag.traza(id) ON DELETE CASCADE,
  id         text        NOT NULL,
  padre_id   text,
  nombre     text        NOT NULL,
  tipo       text        NOT NULL CHECK (tipo IN ('paso', 'recuperacion', 'generacion', 'embedding', 'evento')),
  fe_inicio  timestamptz NOT NULL,
  ms         integer,
  entrada    jsonb,
  salida     jsonb,
  modelo     text,
  tokens_in  integer,
  tokens_out integer,
  nivel      text        NOT NULL CHECK (nivel IN ('DEFAULT', 'WARNING', 'ERROR')),
  error      text,
  PRIMARY KEY (traza_id, id)
);

-- Turno fallido: antes el mensaje pendiente se BORRABA si la llamada de respuesta fallaba, y con él
-- todo lo calculado (plan, retrieval, rerank, citas). Ahora queda 'fallido' y se puede reintentar
-- desde las citas ya guardadas (POST /mensajes/:id/reintentar).
ALTER TABLE rag.chat_mensaje
  ADD COLUMN IF NOT EXISTS estado text NOT NULL DEFAULT 'ok' CHECK (estado IN ('ok', 'fallido')),
  ADD COLUMN IF NOT EXISTS traza_id text;

ALTER TABLE rag.retrieval_log ADD COLUMN IF NOT EXISTS traza_id text;
