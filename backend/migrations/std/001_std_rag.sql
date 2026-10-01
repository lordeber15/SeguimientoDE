-- Base de conocimientos RAG del STD (Sistema de Trámite Documentario de UE118/PMESUT).
--
-- Vive en una base de datos FÍSICAMENTE SEPARADA de `seguimiento_app` (el RAG del SGD), aunque
-- esté en el mismo servidor Postgres — así el corpus del STD nunca se mezcla con el del SGD, ni
-- siquiera por accidente en un JOIN. La creación de esta base ("std_rag") la hace
-- `asegurarBaseStdRag()` en el backend antes de aplicar esta migración; aquí se asume que ya
-- existe y que la conexión apunta a ella.
--
-- Mismo "motor" genérico que el RAG del SGD (compartido/rag/*: chunking, conversión, embeddings,
-- cola de ingesta, config en caliente) sobre un esquema equivalente — ver
-- backend/migrations/002_rag.sql y siguientes para el original. Lo que cambia es la identidad del
-- documento: aquí no hay expediente ni `nu_ann/nu_emi/nu_ane`, hay `tbl_adjunto.id_adjunto` del
-- STD (ver la skill `std-database` para el esquema completo de origen).

-- ── Config y auditoría propias de esta base ──────────────────────────────────
--
-- Solo lo mínimo que el motor compartido necesita escribir (configService, embeddingModelService
-- vía activarModelo). Los usuarios, roles y permisos del STD siguen viviendo en `seguimiento_app`
-- (el login es el mismo del SGD): NO se replica aquí `app.usuario` ni `app.rol`, por eso
-- `rag.chat_sesion.usuario_id` más abajo no tiene FK — referenciar una tabla de OTRA base de
-- datos no es posible en Postgres.

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.config (
  clave       text PRIMARY KEY,
  valor       text NOT NULL,
  descripcion text,
  fe_mod      timestamptz NOT NULL DEFAULT now(),
  mod_por     text
);

CREATE TABLE IF NOT EXISTS app.auditoria (
  id      bigserial PRIMARY KEY,
  actor   text,
  accion  text NOT NULL,
  detalle jsonb,
  fe      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auditoria_fe_brin_idx ON app.auditoria USING brin (fe);

-- ── Esquema rag ───────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE SCHEMA IF NOT EXISTS rag;

-- Misma configuración de texto en español sin tildes que el SGD (docs escaneados/OCR y nombres
-- con y sin acentos conviven igual aquí).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'es_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION es_unaccent (COPY = spanish);
    ALTER TEXT SEARCH CONFIGURATION es_unaccent
      ALTER MAPPING FOR hword, hword_part, word WITH unaccent, spanish_stem;
  END IF;
END
$$;

-- ── Documento STD: el ancla del barrido incremental ──────────────────────────
--
-- Reemplaza a `rag.expediente` del SGD: el STD no tiene expedientes, tiene documentos
-- (`tbl_documento`), cada uno con 0..N archivos PDF repartidos entre el principal, sus anexos y
-- las derivaciones que lo acompañan.

CREATE TABLE IF NOT EXISTS rag.documento_std (
  id_documento      bigint PRIMARY KEY,   -- tbl_documento.id_documento del STD ("N° STD")
  documento         text,                 -- tbl_documento.documento, copiado para mostrar sin ir al STD
  -- Watermark de lo último visto en el STD (mismo cedazo que el SGD): si no cambió, no se mira.
  adjuntos_pdf_std  integer     NOT NULL DEFAULT 0,
  watermark_std     timestamptz,
  docs_ingestados   integer     NOT NULL DEFAULT 0,
  docs_pendientes   integer     NOT NULL DEFAULT 0,
  docs_sin_texto    integer     NOT NULL DEFAULT 0,
  fe_ultimo_barrido    timestamptz,
  fe_ultimo_embedding  timestamptz
);

-- ── Contenido: la unidad de deduplicación (idéntico al SGD) ─────────────────

CREATE TABLE IF NOT EXISTS rag.contenido (
  sha256        text PRIMARY KEY,
  bytes         bigint,
  mime          text,
  markdown      text,
  chars         integer,
  paginas       integer,
  metodo        text,
  ms_conversion integer,
  fe_conversion timestamptz,
  chunks_generados integer NOT NULL DEFAULT 0,
  fe_chunking   timestamptz,
  -- Desde cuándo quedó sin ningún documento vivo que lo referencie (recolector de basura, Fase 6
  -- del SGD replicada aquí). NULL = nunca huérfano o ya vuelto a estar referenciado.
  fe_huerfano   timestamptz
);

-- ── Documento (versión STD): apunta al contenido VIGENTE de UN adjunto ──────
--
-- Identidad real: `id_adjunto` (UNIQUE), la clave primaria de `tbl_adjunto` en el STD — un
-- archivo físico concreto. `origen` dice de dónde salió ese adjunto (documento principal, anexo
-- del documento, o adjunto de una derivación); `id_documento_mov` solo tiene sentido cuando
-- `origen='derivacion'`.

CREATE TABLE IF NOT EXISTS rag.documento (
  id                bigserial PRIMARY KEY,
  id_adjunto        bigint  NOT NULL,       -- tbl_adjunto.id_adjunto del STD
  id_documento      bigint  NOT NULL REFERENCES rag.documento_std(id_documento),
  origen            text    NOT NULL,        -- 'principal' | 'anexo' | 'derivacion'
  id_documento_mov  bigint,                  -- tbl_documento_mov.id_documento_mov; solo si origen='derivacion'

  -- Metadatos desnormalizados del STD (misma razón que el SGD: dos bases en servidores
  -- distintos, sin JOIN posible).
  nro_std           text,     -- "N° STD" = id_documento, para mostrar (ej. "STD 48683")
  documento         text,     -- tbl_documento.documento (número formal, ej. "001-2020-MINEDU/...")
  tipo_doc          text,     -- tbl_tipo_documento.tipo_documento (CARTA, OFICIO, INFORME, ...)
  origen_doc        text,     -- tbl_origen_documento.origen_documento (EXTERNO/INTERNO/SALIENTE)
  asunto            text,
  fecha             date,
  remitente         text,     -- nombre resuelto de tbl_persona (remitente, u origen de la derivación)
  area_origen       text,     -- área/unidad relacionada con este archivo concreto
  flg_confidencial  boolean NOT NULL DEFAULT false,
  nombre_archivo    text,     -- tbl_adjunto.nombre (nombre original, con extensión)
  sha1_std          text,     -- tbl_adjunto.hash (sha1 del contenido tal como lo calculó el STD)

  contenido_sha256  text REFERENCES rag.contenido(sha256),
  sha256_anterior   text,

  estado        text    NOT NULL DEFAULT 'pendiente',
  motivo_error  text,
  intentos      integer NOT NULL DEFAULT 0,
  paginas       integer,

  vigente       boolean NOT NULL DEFAULT true,
  fe_descubierto      timestamptz NOT NULL DEFAULT now(),
  fe_cambio_detectado timestamptz,

  CONSTRAINT documento_estado_ck CHECK (estado IN
    ('pendiente','en_proceso','convertido','ok','sin_texto','error','omitido','no_soportado')),
  CONSTRAINT documento_origen_ck CHECK (origen IN ('principal','anexo','derivacion')),
  -- Un mismo id_adjunto nunca necesita más de una fila: es la clave primaria real de tbl_adjunto
  -- en el STD, así que identifica un único archivo físico sin importar en cuántos sitios (anexo Y
  -- derivación a la vez, en teoría) esté enlazado allá.
  CONSTRAINT documento_unico UNIQUE (id_adjunto)
);

CREATE INDEX IF NOT EXISTS documento_std_doc_idx ON rag.documento (id_documento) WHERE vigente;
CREATE INDEX IF NOT EXISTS documento_std_estado_idx ON rag.documento (estado) WHERE vigente;
CREATE INDEX IF NOT EXISTS documento_std_contenido_idx ON rag.documento (contenido_sha256);
CREATE INDEX IF NOT EXISTS documento_std_anterior_idx ON rag.documento (sha256_anterior)
  WHERE sha256_anterior IS NOT NULL;
CREATE INDEX IF NOT EXISTS documento_std_largos_idx ON rag.documento (paginas)
  WHERE vigente AND paginas IS NOT NULL;

-- ── Chunks (idéntico al SGD) ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rag.chunk (
  id            bigserial PRIMARY KEY,
  sha256        text NOT NULL REFERENCES rag.contenido(sha256) ON DELETE CASCADE,
  ord           integer NOT NULL,
  texto         text NOT NULL,
  ruta_titulos  text,
  cabecera_ctx  text,
  car_inicio    integer,
  car_fin       integer,
  tokens        integer,
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('es_unaccent', texto)) STORED,
  UNIQUE (sha256, ord)
);

CREATE INDEX IF NOT EXISTS chunk_tsv_idx ON rag.chunk USING gin (tsv);

-- ── Modelos de embedding (idéntico al SGD) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS rag.embedding_model (
  id          serial PRIMARY KEY,
  proveedor   text NOT NULL,
  modelo      text NOT NULL,
  dimension   integer NOT NULL,
  activo      boolean NOT NULL DEFAULT false,
  backfill_pct numeric(5,2) NOT NULL DEFAULT 0,
  fe_alta     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proveedor, modelo)
);

CREATE UNIQUE INDEX IF NOT EXISTS embedding_model_activo_idx
  ON rag.embedding_model ((activo)) WHERE activo;

-- ── Vectores: una tabla por dimensión, particionada por modelo (idéntico al SGD) ─

CREATE TABLE IF NOT EXISTS rag.embedding_1024 (
  chunk_id  bigint  NOT NULL REFERENCES rag.chunk(id) ON DELETE CASCADE,
  modelo_id integer NOT NULL REFERENCES rag.embedding_model(id),
  vec       vector(1024) NOT NULL,
  PRIMARY KEY (modelo_id, chunk_id)
) PARTITION BY LIST (modelo_id);

CREATE TABLE IF NOT EXISTS rag.embedding_1536 (
  chunk_id  bigint  NOT NULL REFERENCES rag.chunk(id) ON DELETE CASCADE,
  modelo_id integer NOT NULL REFERENCES rag.embedding_model(id),
  vec       vector(1536) NOT NULL,
  PRIMARY KEY (modelo_id, chunk_id)
) PARTITION BY LIST (modelo_id);

CREATE TABLE IF NOT EXISTS rag.embedding_h3072 (
  chunk_id  bigint  NOT NULL REFERENCES rag.chunk(id) ON DELETE CASCADE,
  modelo_id integer NOT NULL REFERENCES rag.embedding_model(id),
  vec       halfvec(3072) NOT NULL,
  PRIMARY KEY (modelo_id, chunk_id)
) PARTITION BY LIST (modelo_id);

-- ── Cola de ingesta (idéntico al SGD, incluido el índice de la 007) ──────────

CREATE TABLE IF NOT EXISTS rag.ingest_job (
  id          bigserial PRIMARY KEY,
  tipo        text NOT NULL,
  estado      text NOT NULL DEFAULT 'pendiente',
  filtro      jsonb,
  total       integer NOT NULL DEFAULT 0,
  procesados  integer NOT NULL DEFAULT 0,
  errores     integer NOT NULL DEFAULT 0,
  creado_por  text,
  fe_inicio   timestamptz NOT NULL DEFAULT now(),
  fe_fin      timestamptz,
  mensaje     text,
  CONSTRAINT ingest_job_estado_ck CHECK (estado IN ('pendiente','en_curso','pausado','completado','error','cancelado'))
);

CREATE TABLE IF NOT EXISTS rag.ingest_item (
  id           bigserial PRIMARY KEY,
  job_id       bigint NOT NULL REFERENCES rag.ingest_job(id) ON DELETE CASCADE,
  documento_id bigint NOT NULL REFERENCES rag.documento(id) ON DELETE CASCADE,
  estado       text NOT NULL DEFAULT 'pendiente',
  intentos     integer NOT NULL DEFAULT 0,
  lease_hasta  timestamptz,
  motivo_error text,
  fe_alta      timestamptz NOT NULL DEFAULT now(),
  fe_fin       timestamptz,
  CONSTRAINT ingest_item_estado_ck CHECK (estado IN ('pendiente','en_proceso','ok','error','omitido')),
  UNIQUE (job_id, documento_id)
);

CREATE INDEX IF NOT EXISTS ingest_item_cola_idx
  ON rag.ingest_item (job_id, id) WHERE estado = 'pendiente';

-- Búsqueda "¿hay ya un ítem vivo de este documento en algún job en curso?" (reparación manual).
CREATE INDEX IF NOT EXISTS ingest_item_documento_idx
  ON rag.ingest_item (documento_id) WHERE estado IN ('pendiente', 'en_proceso');

-- ── Consumo de tokens (idéntico al SGD) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS rag.uso_token (
  id           bigserial PRIMARY KEY,
  job_id       bigint REFERENCES rag.ingest_job(id) ON DELETE SET NULL,
  proveedor    text NOT NULL,
  modelo       text NOT NULL,
  operacion    text NOT NULL,
  tokens_in    integer NOT NULL DEFAULT 0,
  tokens_out   integer NOT NULL DEFAULT 0,
  estimado     boolean NOT NULL DEFAULT false,
  coste_usd    numeric(12,6),
  exito        boolean NOT NULL DEFAULT true,
  fe           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS uso_token_fe_brin_idx ON rag.uso_token USING brin (fe);

-- ── Bitácora del barrido (idéntico al SGD) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS rag.barrido (
  id          bigserial PRIMARY KEY,
  tipo        text NOT NULL,
  disparo     text NOT NULL,
  fe_inicio   timestamptz NOT NULL DEFAULT now(),
  fe_fin      timestamptz,
  cursor      text,
  expedientes_revisados integer NOT NULL DEFAULT 0,   -- aquí: "documentos del STD revisados"
  documentos_nuevos     integer NOT NULL DEFAULT 0,
  documentos_cambiados  integer NOT NULL DEFAULT 0,
  documentos_baja       integer NOT NULL DEFAULT 0,
  error       text
);

CREATE INDEX IF NOT EXISTS barrido_fe_idx ON rag.barrido (fe_inicio DESC);

-- ── Mantenimiento: retención y recolector de basura (idéntico al SGD) ───────

CREATE TABLE IF NOT EXISTS rag.mantenimiento (
  id              bigserial PRIMARY KEY,
  tipo            text NOT NULL,
  fe_inicio       timestamptz NOT NULL DEFAULT now(),
  fe_fin          timestamptz,
  filas_afectadas integer NOT NULL DEFAULT 0,
  detalle         jsonb,
  error           text,
  CONSTRAINT mantenimiento_tipo_ck CHECK (tipo IN ('retencion', 'gc'))
);

CREATE INDEX IF NOT EXISTS mantenimiento_tipo_fe_idx ON rag.mantenimiento (tipo, fe_inicio DESC);

-- ── Chat (equivalente a la 005, sin FK a app.usuario: vive en OTRA base) ────

CREATE TABLE IF NOT EXISTS rag.chat_sesion (
  id            bigserial PRIMARY KEY,
  -- Sin FK: el usuario (cod_user) vive en app.usuario de `seguimiento_app`, una base DISTINTA —
  -- Postgres no admite claves foráneas entre bases de datos. La integridad la garantiza el
  -- backend (requiereAuth ya valida la sesión antes de llegar aquí).
  usuario_id    text NOT NULL,
  modo          text NOT NULL CHECK (modo IN ('general','documento')),
  -- NULL en modo 'general'. id_documento del STD cuando modo='documento'.
  id_documento  bigint,
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
  numero        integer NOT NULL,
  chunk_id      bigint  NOT NULL REFERENCES rag.chunk(id),
  documento_id  bigint  NOT NULL REFERENCES rag.documento(id),
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

-- ── Configuración: arranca DESACTIVADO, igual criterio que el SGD ───────────
--
-- Mismas claves que usa compartido/rag/configService.ts para el SGD (`rag.barrido.activo`, etc.):
-- no hace falta prefijo `std.` porque esta es una base de datos APARTE — la separación ya la da
-- la conexión, no el nombre de la clave. La cadencia del barrido es mucho más laxa que la del SGD
-- (24 h en vez de 15 min): el STD casi no cambia.

INSERT INTO app.config (clave, valor, descripcion) VALUES
  ('rag.barrido.activo', 'false',
   'Interruptor maestro del barrido de detección del STD. Arranca desactivado a propósito.'),
  ('rag.barrido.cadencia_min', '1440',
   'Minutos entre barridos. 1440 = 24 h: el STD casi no cambia, a diferencia del SGD.'),
  ('rag.ingesta.activa', 'false',
   'Interruptor del worker de ingesta del STD. El barrido detecta; la ingesta la dispara el usuario.'),
  ('rag.retencion.activa', 'true',
   'Purga uso_token/retrieval_log más viejos que rag.retencion.dias.'),
  ('rag.retencion.dias', '180',
   'Antigüedad, en días, a partir de la cual se purgan uso_token/retrieval_log.'),
  ('rag.gc.activo', 'false',
   'Recolector de basura de contenidos huérfanos: borra chunks y embeddings (nunca el markdown) '
   'de contenidos que ya no referencia ningún documento vivo.'),
  ('rag.gc.gracia_dias', '30',
   'Días de margen entre que un contenido se detecta huérfano y se recolecta de verdad.')
ON CONFLICT (clave) DO NOTHING;
