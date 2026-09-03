-- Fase 6: retención de logs sin límite y recolector de basura de contenidos huérfanos.
-- Ver docs/PLAN-RAG.md §6.6 (diseño del recolector) y riesgo #12 (retención de login_intento /
-- uso_token, pendiente "desde el día 1").

-- El recolector necesita saber DESDE CUÁNDO un contenido está huérfano para aplicar el margen de
-- gracia (§6.6: "candidato, con un margen de gracia por si un barrido posterior lo vuelve a
-- necesitar"). NULL = nunca detectado como huérfano (o ya vuelto a estar referenciado).
ALTER TABLE rag.contenido ADD COLUMN IF NOT EXISTS fe_huerfano timestamptz;

CREATE TABLE IF NOT EXISTS rag.mantenimiento (
  id              bigserial PRIMARY KEY,
  tipo            text NOT NULL,   -- 'retencion' | 'gc'
  fe_inicio       timestamptz NOT NULL DEFAULT now(),
  fe_fin          timestamptz,
  filas_afectadas integer NOT NULL DEFAULT 0,
  detalle         jsonb,
  error           text,
  CONSTRAINT mantenimiento_tipo_ck CHECK (tipo IN ('retencion', 'gc'))
);

CREATE INDEX IF NOT EXISTS mantenimiento_tipo_fe_idx ON rag.mantenimiento (tipo, fe_inicio DESC);

INSERT INTO app.config (clave, valor, descripcion) VALUES
  ('rag.retencion.activa', 'true',
   'Purga login_intento/uso_token/retrieval_log más viejos que rag.retencion.dias. Son datos de '
   'auditoría/depuración sin valor a largo plazo, no contenido ingerido — arranca ACTIVADO, a '
   'diferencia del barrido y el recolector de basura.'),
  ('rag.retencion.dias', '180',
   'Antigüedad, en días, a partir de la cual se purgan login_intento/uso_token/retrieval_log.'),
  ('rag.gc.activo', 'false',
   'Recolector de basura de contenidos huérfanos (PLAN-RAG.md §6.6): borra chunks y embeddings '
   '(nunca el markdown) de contenidos que ya no referencia ningún documento vivo. Arranca '
   'DESACTIVADO a propósito, igual que el barrido: borra datos ya ingeridos, aunque sean baratos '
   'de reconstruir.'),
  ('rag.gc.gracia_dias', '30',
   'Días de margen entre que un contenido se detecta huérfano y se recolecta de verdad, por si '
   'un barrido posterior lo vuelve a necesitar.')
ON CONFLICT (clave) DO NOTHING;
