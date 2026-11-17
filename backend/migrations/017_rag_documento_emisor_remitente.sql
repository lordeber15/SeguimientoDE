-- Emisor, remitente externo y búsqueda por metadatos para el chat de consultas
-- (docs/PLAN-CHAT-CONSULTAS.md, Fase 1).
--
-- De dónde sale cada campo (validado contra el SGD real, ver "Hallazgos de la Fase 0"):
--   ti_emi '01'/'05' → interno: emisor_empleado = empleado emisor (co_emp_emi).
--   ti_emi '02'      → empresa: remitente_externo = razón social (lg_pro_proveedor por RUC),
--                      remitente_doc = RUC.
--   ti_emi '03'      → persona natural: remitente_externo = de_ori_emi, remitente_doc = DNI.
-- En externos, co_emp_emi es quien REGISTRÓ el documento en mesa de partes, no su autor: va a
-- `registrado_por` y nunca a `emisor_empleado`.
ALTER TABLE rag.documento
  ADD COLUMN IF NOT EXISTS ti_emi            text,
  ADD COLUMN IF NOT EXISTS emisor_empleado   text,
  ADD COLUMN IF NOT EXISTS remitente_externo text,
  ADD COLUMN IF NOT EXISTS remitente_doc     text,
  ADD COLUMN IF NOT EXISTS registrado_por    text;

-- Búsqueda por metadatos (cubre todo lo inventariado, esté o no ingestado). Pesos para ts_rank:
-- A = asunto (la señal más fuerte), B = quién (remitente/emisor), C = título y dependencia.
ALTER TABLE rag.documento
  ADD COLUMN IF NOT EXISTS tsv_meta tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('es_unaccent', coalesce(asunto, '')), 'A')
    || setweight(to_tsvector('es_unaccent',
         coalesce(remitente_externo, '') || ' ' || coalesce(remitente_doc, '') || ' '
         || coalesce(emisor_empleado, '')), 'B')
    || setweight(to_tsvector('es_unaccent', coalesce(titulo, '') || ' ' || coalesce(de_dep_emi, '')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS documento_tsv_meta_idx ON rag.documento USING gin (tsv_meta);

-- Re-barrido único de metadatos: sin watermark, el siguiente barrido ve todos los expedientes
-- como cambiados y re-lee sus documentos del SGD. El upsert de `sincronizarDocumentos` solo
-- refresca metadatos — no devuelve nada a 'pendiente' ni re-embebe.
UPDATE rag.expediente SET watermark_sgd = NULL;
