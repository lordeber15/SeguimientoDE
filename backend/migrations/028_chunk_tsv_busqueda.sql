-- FTS del retrieval de contenido con la cabecera del fragmento (título · expediente · dependencia ·
-- fecha · asunto · ruta de títulos). Hasta ahora la cabecera solo entraba al EMBEDDING: la rama
-- vectorial sabía que un fragmento "se aprueba lo solicitado" era de la obra de Junín, pero la rama
-- FTS no, y una consulta por número de expediente o por palabra del asunto no lo encontraba por texto.
--
-- Columna NUEVA y no un cambio de `tsv`: los listados (`busquedaExpedientesService`,
-- `consultasExpedienteService`) separan a propósito "aparece en los metadatos" de "aparece en el
-- contenido", y con la cabecera dentro de `tsv` esos dos niveles se mezclarían.
--
-- Pesos para ts_rank_cd: texto = A (la evidencia), cabecera = D (solo desempata y da contexto).
-- Añadir una columna generada STORED reescribe rag.chunk: la migración tarda en un corpus grande.
ALTER TABLE rag.chunk
  ADD COLUMN IF NOT EXISTS tsv_busqueda tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('es_unaccent', texto), 'A')
    || setweight(to_tsvector('es_unaccent', coalesce(cabecera_ctx, '')), 'D')
  ) STORED;

CREATE INDEX IF NOT EXISTS chunk_tsv_busqueda_idx ON rag.chunk USING gin (tsv_busqueda);
