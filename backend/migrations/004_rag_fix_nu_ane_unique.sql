-- Corrige un bug de la migración 002: la unicidad (nu_ann, nu_emi, nu_ane) nunca actuaba sobre
-- los documentos principales porque `nu_ane` quedaba NULL, y en PostgreSQL un UNIQUE trata
-- NULL <> NULL — cada barrido insertaba una fila nueva en vez de actualizar la existente.
-- Verificado en caliente: dos barridos seguidos dejaron 11.416 filas para 5.708 documentos reales.
--
-- Arreglo: `nu_ane` pasa a NOT NULL con centinela 0 para "documento principal". Es seguro:
-- verificado que en esta BD `tdtv_anexos.nu_ane` va de 1 a 156, nunca 0.

-- 1. Borra los duplicados que ya se generaron, conservando la fila más antigua de cada clave real.
DELETE FROM rag.documento d
WHERE d.id NOT IN (
  SELECT min(id) FROM rag.documento GROUP BY nu_ann, nu_emi, COALESCE(nu_ane, -1)
);

-- 2. El centinela: NULL -> 0.
UPDATE rag.documento SET nu_ane = 0 WHERE nu_ane IS NULL;

ALTER TABLE rag.documento ALTER COLUMN nu_ane SET NOT NULL;
ALTER TABLE rag.documento ALTER COLUMN nu_ane SET DEFAULT 0;

COMMENT ON COLUMN rag.documento.nu_ane IS
  '0 = documento principal (centinela; el SGD nunca usa nu_ane=0 para un anexo real). '
  'Un número >0 es el nu_ane literal del anexo.';
