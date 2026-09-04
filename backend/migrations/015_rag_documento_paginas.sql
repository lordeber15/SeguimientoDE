-- Nº de páginas del documento, para poder seleccionar los "largos" que necesitan troceo en la
-- conversión (ver conversionLargaService.ts). `rag.contenido.paginas` ya existía desde 002_rag.sql
-- pero nunca se escribía; esta es la copia por documento, poblada ANTES de convertir (no depende
-- de que la conversión termine bien) para que el job de largos pueda encontrarlos aunque hayan
-- quedado en 'error' o 'pendiente'.
ALTER TABLE rag.documento ADD COLUMN IF NOT EXISTS paginas integer;

CREATE INDEX IF NOT EXISTS documento_largos_idx ON rag.documento (paginas)
  WHERE vigente AND paginas IS NOT NULL;
