-- Corrige la 022 (docs/PLAN-CHAT-CONSULTAS.md, Fase 6). "sin controversia" y "no hay controversia"
-- quedan reducidas por es_unaccent a un solo lexema ('controversi': "sin", "no" y "hay" son palabras
-- vacías), así que como frase estándar excluían TODOS los fragmentos con "controversia" — medido:
-- "controversia + Junín" pasó de cientos de coincidencias en contenido a cero.
--
-- 1. `rag.tsq_frases`: como `rag.tsq_alternativas` pero solo con las frases de dos o más lexemas.
--    Es lo que se usa para las exclusiones: una frase estándar de un lexema nunca puede excluir.
CREATE OR REPLACE FUNCTION rag.tsq_frases(t text) RETURNS tsquery
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT string_agg('(' || q::text || ')', ' | ')::tsquery
    FROM (SELECT phraseto_tsquery('es_unaccent', btrim(a)) AS q
            FROM unnest(string_to_array(t, '|')) AS a) x
   WHERE numnode(q) >= 3
$$;

-- 2. Quita esas dos frases del valor sembrado (solo si nadie lo ajustó desde la 022).
UPDATE app.config
   SET valor = '["solución de controversias","someter las controversias","controversias que surjan",'
               '"prevención de controversias","prevenir controversias","generar controversias contractuales",'
               '"resolver en primera instancia cualquier controversia","resolución pacífica de controversias",'
               '"no existe controversia"]',
       fe_mod = now()
 WHERE clave = 'chat.frases_estandar'
   AND valor = '["solución de controversias","someter las controversias","controversias que surjan",'
               '"prevención de controversias","prevenir controversias","generar controversias contractuales",'
               '"resolver en primera instancia cualquier controversia","resolución pacífica de controversias",'
               '"no existe controversia","no hay controversia","sin controversia"]';
