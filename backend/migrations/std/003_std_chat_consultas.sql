-- Chat del STD con consultas estructuradas, respuestas cerradas y contexto
-- (docs/PLAN-CHAT-CONSULTAS.md, Fase 7). Equivale a las migraciones 017–023 del SGD, adaptadas a
-- que aquí la unidad es el DOCUMENTO STD (`rag.documento_std`), no el expediente.

-- ── 1. Metadatos por documento ────────────────────────────────────────────────
--
-- `rag.documento` tiene una fila por ENLACE de archivo (principal, anexo, derivación: ~5 por
-- documento) y sin `etiquetas`; buscar "documentos de X" ahí obligaría a deduplicar cada vez y
-- dejaría fuera el número de contrato. Una fila por documento, con lo que identifica al documento
-- en el STD (`tbl_documento` + remitente + área de origen del primer movimiento), la llena
-- `sincronizarMetadatosStd` desde MariaDB. Aquí solo se precarga lo que ya estaba copiado.
ALTER TABLE rag.documento_std
  ADD COLUMN IF NOT EXISTS tipo_doc          text,
  ADD COLUMN IF NOT EXISTS origen_doc        text,       -- EXTERNO / INTERNO / SALIENTE
  ADD COLUMN IF NOT EXISTS asunto            text,
  ADD COLUMN IF NOT EXISTS fecha             date,
  ADD COLUMN IF NOT EXISTS remitente         text,       -- tbl_persona.nombre del remitente (interno = quien firma)
  ADD COLUMN IF NOT EXISTS remitente_entidad text,       -- razón social / entidad del remitente, si la tiene
  ADD COLUMN IF NOT EXISTS etiquetas         text,       -- en la práctica, N° de contrato ("113-2022-MCEBS")
  ADD COLUMN IF NOT EXISTS area_origen       text,       -- sigla del área que originó el primer movimiento
  ADD COLUMN IF NOT EXISTS flg_confidencial  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fe_metadatos      timestamptz;

ALTER TABLE rag.documento_std
  ADD COLUMN IF NOT EXISTS tsv_meta tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('es_unaccent', coalesce(asunto, '')), 'A')
    || setweight(to_tsvector('es_unaccent', coalesce(remitente, '') || ' ' || coalesce(remitente_entidad, '')), 'B')
    || setweight(to_tsvector('es_unaccent',
         coalesce(documento, '') || ' ' || coalesce(tipo_doc, '') || ' ' || coalesce(etiquetas, '')
         || ' ' || coalesce(area_origen, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS documento_std_tsv_meta_idx ON rag.documento_std USING gin (tsv_meta);
CREATE INDEX IF NOT EXISTS documento_std_fecha_idx ON rag.documento_std (fecha);

-- Precarga desde los enlaces ya copiados: el principal o un anexo llevan el remitente del
-- documento (`tbl_documento.id_remitente`); una derivación, el de quien derivó, así que solo se usa
-- si el documento no tiene otro enlace. `etiquetas` y `area_origen` quedan para la sincronización.
UPDATE rag.documento_std ds SET
  tipo_doc = x.tipo_doc, origen_doc = x.origen_doc, asunto = x.asunto, fecha = x.fecha,
  remitente = CASE WHEN x.origen <> 'derivacion' THEN x.remitente END,
  flg_confidencial = x.flg_confidencial
FROM (
  SELECT DISTINCT ON (d.id_documento)
         d.id_documento, d.origen, d.tipo_doc, d.origen_doc, d.asunto, d.fecha, d.remitente, d.flg_confidencial
    FROM rag.documento d
   WHERE d.vigente
   ORDER BY d.id_documento, (d.origen = 'principal') DESC, (d.origen = 'anexo') DESC, d.id
) x
WHERE ds.id_documento = x.id_documento AND ds.asunto IS NULL;

-- ── 2. Búsqueda por términos con alternativas (igual que la 021/023 del SGD) ──
CREATE OR REPLACE FUNCTION rag.tsq_alternativas(t text) RETURNS tsquery
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT string_agg('(' || q::text || ')', ' | ')::tsquery
    FROM (SELECT phraseto_tsquery('es_unaccent', btrim(a)) AS q
            FROM unnest(string_to_array(t, '|')) AS a) x
   WHERE numnode(q) > 0
$$;

CREATE OR REPLACE FUNCTION rag.tsq_frases(t text) RETURNS tsquery
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT string_agg('(' || q::text || ')', ' | ')::tsquery
    FROM (SELECT phraseto_tsquery('es_unaccent', btrim(a)) AS q
            FROM unnest(string_to_array(t, '|')) AS a) x
   WHERE numnode(q) >= 3
$$;

-- ── 3. Chat: tipo de respuesta, meta y telemetría (igual que la 018/020 del SGD) ─
ALTER TABLE rag.chat_mensaje
  ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'texto'
    CONSTRAINT chat_mensaje_tipo_check CHECK (tipo IN ('texto', 'tabla', 'fijo', 'documento', 'participantes')),
  ADD COLUMN IF NOT EXISTS meta jsonb;

ALTER TABLE rag.retrieval_log
  ADD COLUMN IF NOT EXISTS intencion             text,
  ADD COLUMN IF NOT EXISTS consulta_reescrita    text,
  ADD COLUMN IF NOT EXISTS planificador_respaldo boolean,
  ADD COLUMN IF NOT EXISTS ms_planificador       integer,
  ADD COLUMN IF NOT EXISTS respuesta_fija        text;

-- ── 4. Configuración: mismas claves que el SGD, con textos del STD ────────────
INSERT INTO app.config (clave, valor, descripcion) VALUES
  ('chat.planificador.activo', 'true',
   'Clasifica cada pregunta del chat antes de buscar (una llamada corta al modelo). Apagado, el '
   'chat vuelve al comportamiento anterior: toda pregunta va a la búsqueda de contenido.'),
  ('chat.mensaje_ayuda',
   'Respondo solo sobre la información del STD: documentos, remitentes, movimientos, observaciones '
   'y su contenido. Por ejemplo: "dame los documentos del contrato 113-2022-MCEBS" o "¿quiénes '
   'participaron en los documentos de controversia de la obra Junín?".',
   'Respuesta fija a saludos, agradecimientos y "¿qué puedes hacer?" (sin llamar al modelo).'),
  ('chat.mensaje_fuera_alcance',
   'Esa consulta no es sobre la información del STD, así que no puedo responderla. Pregúnteme por '
   'documentos, remitentes, movimientos o su contenido.',
   'Respuesta fija cuando el planificador clasifica la pregunta como ajena a los datos.'),
  ('chat.mensaje_sin_resultados',
   'No encontré información sobre eso en el STD.',
   'Respuesta fija cuando la búsqueda no devuelve nada relevante (no se llama al modelo).'),
  ('chat.peso_asunto', '3',
   'Peso de una coincidencia en metadatos (asunto, remitente, tipo, contrato) frente a una en el contenido.'),
  ('chat.peso_contenido', '1',
   'Peso de una coincidencia dentro del contenido de los archivos (se amortigua con log).'),
  ('chat.tope_docs_por_termino', '5',
   'Tope del contador de coincidencias en metadatos por término.'),
  ('chat.meses_actual', '3',
   '"Actualmente" = movimiento en los últimos N meses, aunque el documento esté archivado.'),
  ('chat.max_candidatos', '1000',
   'Máximo de documentos guardados por listado (y consultados al STD para "actual" / contar).'),
  ('chat.sinonimos',
   '{"alquiler":["arrendamiento"],"arrendamiento":["alquiler"],"alquileres":["arrendamiento"],'
   '"computadora":["equipos de cómputo","equipo de cómputo"],"computadoras":["equipos de cómputo","equipo de cómputo"],'
   '"equipos de computo":["computadoras"],"in house":["inhouse"]}',
   'Sinónimos de la búsqueda de documentos del chat (JSON: término → lista de alternativas).'),
  ('chat.frases_estandar',
   '["solución de controversias","someter las controversias","controversias que surjan",'
   '"prevención de controversias","prevenir controversias","generar controversias contractuales",'
   '"resolver en primera instancia cualquier controversia","resolución pacífica de controversias",'
   '"no existe controversia"]',
   'Frases de cláusulas estándar que NO cuentan como coincidencia del término que contienen (JSON: lista).')
ON CONFLICT (clave) DO NOTHING;
