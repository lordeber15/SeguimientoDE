-- Reparación manual de documentos: el reintento por documento necesita saber si YA hay un ítem
-- vivo de algún job en curso para ese documento (para devolver un 409 útil, nombrando el job, en
-- vez de dejar que la acción manual pise el trabajo en segundo plano). El UNIQUE (job_id,
-- documento_id) que ya existe no sirve para esa búsqueda: solo indexa por la pareja completa.
CREATE INDEX IF NOT EXISTS ingest_item_documento_idx
  ON rag.ingest_item (documento_id) WHERE estado IN ('pendiente', 'en_proceso');
