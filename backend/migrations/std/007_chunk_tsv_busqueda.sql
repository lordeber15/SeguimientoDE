-- Igual que la migración 028 del SGD: FTS del retrieval de contenido con la cabecera del fragmento
-- (título · número · área · fecha · asunto · ruta). Columna nueva para no mezclar, en los listados
-- (`busquedaDocumentosStdService`), los niveles "metadatos" y "contenido" que usan `tsv`.
-- Pesos: texto = A, cabecera = D. Reescribe rag.chunk: tarda en un corpus grande.
ALTER TABLE rag.chunk
  ADD COLUMN IF NOT EXISTS tsv_busqueda tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('es_unaccent', texto), 'A')
    || setweight(to_tsvector('es_unaccent', coalesce(cabecera_ctx, '')), 'D')
  ) STORED;

CREATE INDEX IF NOT EXISTS chunk_tsv_busqueda_idx ON rag.chunk USING gin (tsv_busqueda);
