-- Identidad de rag.documento: del ARCHIVO (id_adjunto) al ENLACE (adjunto + documento + origen +
-- derivación).
--
-- La 001 asumía que un id_adjunto aparece en un solo sitio del STD. En la práctica un mismo
-- tbl_adjunto está enlazado varias veces: el principal que también figura como anexo, el mismo PDF
-- adjunto en varias derivaciones, o en documentos distintos. Con UNIQUE (id_adjunto) eso abortaba el
-- barrido ("ON CONFLICT DO UPDATE command cannot affect row a second time") cuando dos enlaces caían
-- en el mismo lote, y cuando caían en lotes distintos el último pisaba en silencio al anterior —
-- se perdía a qué documento/origen pertenecía el archivo.
--
-- Ahora cada enlace es una fila. El costo de cómputo no se duplica: conversión, chunks y embeddings
-- se deduplican por sha256 en rag.contenido, y retrieval/citas ya trabajan por d.id/contenido_sha256.

ALTER TABLE rag.documento DROP CONSTRAINT IF EXISTS documento_unico;

-- COALESCE: id_documento_mov es NULL en principal/anexo, y en un UNIQUE dos NULL no colisionan.
CREATE UNIQUE INDEX IF NOT EXISTS documento_enlace_uidx
  ON rag.documento (id_adjunto, id_documento, origen, (COALESCE(id_documento_mov, 0)));

-- El visor de citas sigue buscando por id_adjunto (documentoPorIdAdjunto).
CREATE INDEX IF NOT EXISTS documento_adjunto_idx ON rag.documento (id_adjunto);
