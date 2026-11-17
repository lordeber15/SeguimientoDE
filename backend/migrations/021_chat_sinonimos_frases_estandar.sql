-- Calibración de la búsqueda de expedientes del chat (docs/PLAN-CHAT-CONSULTAS.md, Fase 6).
--
-- 1. `rag.tsq_alternativas('alquiler|arrendamiento')`: un término con alternativas separadas por "|"
--    se cumple si se cumple CUALQUIERA. Con una sola alternativa equivale a phraseto_tsquery, así que
--    reemplaza a ese llamado en las consultas por término sin cambiar su resultado. NULL si ninguna
--    alternativa deja lexemas (todo palabras vacías): `tsv @@ NULL` no coincide con nada.
CREATE OR REPLACE FUNCTION rag.tsq_alternativas(t text) RETURNS tsquery
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT string_agg('(' || q::text || ')', ' | ')::tsquery
    FROM (SELECT phraseto_tsquery('es_unaccent', btrim(a)) AS q
            FROM unnest(string_to_array(t, '|')) AS a) x
   WHERE numnode(q) > 0
$$;

-- 2. Sinónimos (JSON: término → alternativas) y frases de cláusula estándar (JSON: lista). Las
--    claves se comparan sin tildes ni mayúsculas.
--    - Los usuarios dicen "alquiler de computadoras"; los documentos, "arrendamiento de equipos de
--      cómputo": sin sinónimos, ningún expediente cumplía los tres términos en el asunto.
--    - "controversia" aparece sobre todo en la cláusula estándar de los contratos ("VIGÉSIMA SEGUNDA:
--      SOLUCIÓN DE CONTROVERSIAS…"), que no indica que el expediente trate una controversia. Un
--      fragmento que contiene una de estas frases no cuenta como coincidencia DEL TÉRMINO que la frase
--      contiene (los demás términos del mismo fragmento sí cuentan).
INSERT INTO app.config (clave, valor, descripcion) VALUES
  ('chat.sinonimos',
   '{"alquiler":["arrendamiento"],"arrendamiento":["alquiler"],"alquileres":["arrendamiento"],'
   '"computadora":["equipos de cómputo","equipo de cómputo"],"computadoras":["equipos de cómputo","equipo de cómputo"],'
   '"equipos de computo":["computadoras"],"in house":["inhouse"]}',
   'Sinónimos de la búsqueda de expedientes del chat (JSON: término → lista de alternativas).'),
  ('chat.frases_estandar',
   '["solución de controversias","someter las controversias","controversias que surjan",'
   '"prevención de controversias","prevenir controversias","generar controversias contractuales",'
   '"resolver en primera instancia cualquier controversia"]',
   'Frases de cláusulas estándar que NO cuentan como coincidencia del término que contienen (JSON: lista).')
ON CONFLICT (clave) DO NOTHING;
