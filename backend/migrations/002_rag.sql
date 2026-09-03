-- Base de conocimientos RAG. Ver docs/PLAN-RAG.md.
--
-- Tres niveles de identidad (D7): el expediente NO posee chunks, los alcanza por join.
--   expediente 1─N documento N─1 contenido 1─N chunk 1─N embedding
-- El contenido se identifica por el sha256 del ARCHIVO, así que un mismo PDF adjunto a varios
-- documentos se convierte y se embebe una sola vez (D3).

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE SCHEMA IF NOT EXISTS rag;

-- Configuración de texto en español SIN tildes: en el SGD conviven "ADJUDICACIÓN" y
-- "ADJUDICACION" (el escritor sanitiza los acentos al guardar en disco), así que una búsqueda
-- que distinga tildes encuentra unos documentos y no otros.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'es_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION es_unaccent (COPY = spanish);
    ALTER TEXT SEARCH CONFIGURATION es_unaccent
      ALTER MAPPING FOR hword, hword_part, word WITH unaccent, spanish_stem;
  END IF;
END
$$;

-- ── Expediente: el ancla del barrido incremental ────────────────────────────

CREATE TABLE IF NOT EXISTS rag.expediente (
  nu_ann_exp        text NOT NULL,
  nu_sec_exp        text NOT NULL,
  numero_sgd        text,           -- el identificador que ve el usuario: OGAUL020260000058
  -- Watermark de lo último visto en el SGD (cedazo 1). Si el par no cambia, no se mira.
  doc_count_sgd     integer     NOT NULL DEFAULT 0,
  watermark_sgd     timestamptz,
  docs_ingestados   integer     NOT NULL DEFAULT 0,
  docs_pendientes   integer     NOT NULL DEFAULT 0,
  docs_sin_texto    integer     NOT NULL DEFAULT 0,
  fe_ultimo_barrido    timestamptz,
  fe_ultimo_embedding  timestamptz,
  fe_primer_documento  timestamptz,
  fe_ultimo_documento  timestamptz,
  PRIMARY KEY (nu_ann_exp, nu_sec_exp)
);

-- ── Contenido: la unidad de deduplicación ───────────────────────────────────

CREATE TABLE IF NOT EXISTS rag.contenido (
  sha256        text PRIMARY KEY,
  bytes         bigint,
  mime          text,
  markdown      text,
  chars         integer,
  paginas       integer,
  -- Cómo se obtuvo el texto: interesa para medir cuánto del corpus depende del OCR lento.
  metodo        text,          -- 'markitdown' | 'markitdown-ocr'
  ms_conversion integer,
  fe_conversion timestamptz,
  chunks_generados integer NOT NULL DEFAULT 0,
  fe_chunking   timestamptz
);

-- ── Documento: apunta al contenido VIGENTE ──────────────────────────────────

CREATE TABLE IF NOT EXISTS rag.documento (
  id            bigserial PRIMARY KEY,
  nu_ann        text NOT NULL,
  nu_emi        text NOT NULL,
  -- NULL = documento principal; un número = anexo con ese nu_ane literal del SGD.
  nu_ane        integer,

  -- Expediente. NULLABLE a propósito: en esta BD 306 documentos (5 %) no tienen expediente
  -- —`nu_ann_exp` es cadena vacía, no NULL— y hay que poder ingestarlos igual.
  nu_ann_exp    text,
  nu_sec_exp    text,

  -- Metadatos desnormalizados del SGD (D4): las dos bases están en servidores distintos y no
  -- hay JOIN posible, así que sin copiarlos el "chat con el expediente" es imposible.
  titulo        text,
  tipo_doc      text,
  co_tip_doc    text,
  asunto        text,
  fe_emi        timestamptz,
  co_dep_emi    text,
  de_dep_emi    text,

  contenido_sha256 text REFERENCES rag.contenido(sha256),
  sha256_anterior  text,   -- una generación de historial (decisión I2)

  estado        text NOT NULL DEFAULT 'pendiente',
  motivo_error  text,
  intentos      integer NOT NULL DEFAULT 0,

  vigente       boolean NOT NULL DEFAULT true,  -- false si es_eli='1' en el SGD
  fe_descubierto      timestamptz NOT NULL DEFAULT now(),
  fe_cambio_detectado timestamptz,

  CONSTRAINT documento_estado_ck CHECK (estado IN
    ('pendiente','en_proceso','convertido','ok','sin_texto','error','omitido','no_soportado')),
  CONSTRAINT documento_unico UNIQUE (nu_ann, nu_emi, nu_ane)
);

CREATE INDEX IF NOT EXISTS documento_expediente_idx
  ON rag.documento (nu_ann_exp, nu_sec_exp) WHERE vigente;
CREATE INDEX IF NOT EXISTS documento_estado_idx ON rag.documento (estado) WHERE vigente;
CREATE INDEX IF NOT EXISTS documento_contenido_idx ON rag.documento (contenido_sha256);
CREATE INDEX IF NOT EXISTS documento_anterior_idx ON rag.documento (sha256_anterior)
  WHERE sha256_anterior IS NOT NULL;

-- ── Chunks ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rag.chunk (
  id            bigserial PRIMARY KEY,
  sha256        text NOT NULL REFERENCES rag.contenido(sha256) ON DELETE CASCADE,
  ord           integer NOT NULL,
  texto         text NOT NULL,
  -- Ruta de títulos del Markdown ("VISTOS > CONSIDERANDO") y cabecera de contexto que se
  -- antepone SOLO al embeber. Lo que se cita es `texto`; lo que se embebe es cabecera + texto:
  -- sin ella, un chunk que dice "se aprueba lo solicitado" no lo recupera ninguna consulta.
  ruta_titulos  text,
  cabecera_ctx  text,
  car_inicio    integer,
  car_fin       integer,
  tokens        integer,
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('es_unaccent', texto)) STORED,
  UNIQUE (sha256, ord)
);

CREATE INDEX IF NOT EXISTS chunk_tsv_idx ON rag.chunk USING gin (tsv);

-- ── Modelos de embedding ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rag.embedding_model (
  id          serial PRIMARY KEY,
  proveedor   text NOT NULL,        -- ollama | openai | azure
  modelo      text NOT NULL,
  dimension   integer NOT NULL,
  activo      boolean NOT NULL DEFAULT false,
  backfill_pct numeric(5,2) NOT NULL DEFAULT 0,
  fe_alta     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proveedor, modelo)
);

-- Un solo modelo activo: mezclar vectores de dos espacios semánticos rompe la búsqueda en
-- silencio, que es el fallo más caro y más difícil de detectar del sistema.
CREATE UNIQUE INDEX IF NOT EXISTS embedding_model_activo_idx
  ON rag.embedding_model ((activo)) WHERE activo;

-- ── Vectores: una tabla por dimensión, particionada por modelo ──────────────
--
-- Por qué no una sola tabla con una columna `vector` sin dimensión: HNSW e IVFFlat EXIGEN
-- dimensión fija, así que esa columna no se podría indexar y la búsqueda sería secuencial.
-- Y una tabla única con índice global obligaría a post-filtrar por modelo, destrozando el recall.
--
-- Los índices HNSW NO se crean aquí: se construyen después del backfill masivo, que es ~10×
-- más rápido que insertar con el índice vivo (ver PLAN-RAG.md §3).

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

-- 3072 dimensiones obliga a `halfvec`: el índice HNSW sobre `vector` está limitado a 2000.
CREATE TABLE IF NOT EXISTS rag.embedding_h3072 (
  chunk_id  bigint  NOT NULL REFERENCES rag.chunk(id) ON DELETE CASCADE,
  modelo_id integer NOT NULL REFERENCES rag.embedding_model(id),
  vec       halfvec(3072) NOT NULL,
  PRIMARY KEY (modelo_id, chunk_id)
) PARTITION BY LIST (modelo_id);

-- ── Cola de ingesta ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rag.ingest_job (
  id          bigserial PRIMARY KEY,
  tipo        text NOT NULL,        -- 'conversion' | 'embedding' | 'reembedding'
  estado      text NOT NULL DEFAULT 'pendiente',
  filtro      jsonb,                -- qué se pidió ingestar (expediente, dependencia, todo…)
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
  -- Lease: da visibility timeout y recuperación tras un reinicio sin ninguna librería de colas
  -- (FOR UPDATE SKIP LOCKED + lease_hasta). Ver PLAN-RAG.md §4.
  lease_hasta  timestamptz,
  motivo_error text,
  fe_alta      timestamptz NOT NULL DEFAULT now(),
  fe_fin       timestamptz,
  CONSTRAINT ingest_item_estado_ck CHECK (estado IN ('pendiente','en_proceso','ok','error','omitido')),
  UNIQUE (job_id, documento_id)
);

CREATE INDEX IF NOT EXISTS ingest_item_cola_idx
  ON rag.ingest_item (job_id, id) WHERE estado = 'pendiente';

-- ── Consumo de tokens ───────────────────────────────────────────────────────
-- Se registra TODO intento, exitoso o no: los tokens de una llamada fallida también se cobran,
-- y contarlos es la única forma de que el panel cuadre con la factura.

CREATE TABLE IF NOT EXISTS rag.uso_token (
  id           bigserial PRIMARY KEY,
  job_id       bigint REFERENCES rag.ingest_job(id) ON DELETE SET NULL,
  proveedor    text NOT NULL,
  modelo       text NOT NULL,
  operacion    text NOT NULL,       -- 'embedding' | 'chat'
  tokens_in    integer NOT NULL DEFAULT 0,
  tokens_out   integer NOT NULL DEFAULT 0,
  estimado     boolean NOT NULL DEFAULT false,
  coste_usd    numeric(12,6),
  exito        boolean NOT NULL DEFAULT true,
  fe           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS uso_token_fe_brin_idx ON rag.uso_token USING brin (fe);

-- ── Bitácora del barrido ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rag.barrido (
  id          bigserial PRIMARY KEY,
  tipo        text NOT NULL,   -- 'inventario_inicial' | 'watermark' | 'anexos' | 'hash'
  disparo     text NOT NULL,   -- 'automatico' | 'manual'
  fe_inicio   timestamptz NOT NULL DEFAULT now(),
  fe_fin      timestamptz,
  cursor      text,            -- para reanudar un inventario inicial interrumpido
  expedientes_revisados integer NOT NULL DEFAULT 0,
  documentos_nuevos     integer NOT NULL DEFAULT 0,
  documentos_cambiados  integer NOT NULL DEFAULT 0,
  documentos_baja       integer NOT NULL DEFAULT 0,
  error       text
);

CREATE INDEX IF NOT EXISTS barrido_fe_idx ON rag.barrido (fe_inicio DESC);

-- ── Configuración del barrido: arranca DESACTIVADO (decisión I1) ────────────

INSERT INTO app.config (clave, valor, descripcion) VALUES
  ('rag.barrido.activo', 'false',
   'Interruptor maestro del barrido de detección. Arranca desactivado a propósito.'),
  ('rag.barrido.cadencia_min', '15',
   'Minutos entre barridos de watermark y anexos (cedazos 1 y 2)'),
  ('rag.barrido.cadencia_hash_min', '10080',
   'Minutos entre barridos de sha256 completo (cedazo 3). 10080 = 7 días'),
  ('rag.ingesta.activa', 'false',
   'Interruptor del worker de ingesta. El barrido detecta; la ingesta la dispara el usuario.')
ON CONFLICT (clave) DO NOTHING;
