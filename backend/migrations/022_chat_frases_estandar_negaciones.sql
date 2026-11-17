-- Más frases que no indican que un expediente trate una controversia (docs/PLAN-CHAT-CONSULTAS.md,
-- Fase 6), vistas al revisar los primeros resultados de "controversia + Huancavelica" tras la 021:
-- negaciones ("no existe controversia respecto de…", "no hay controversia en las opiniones") y la
-- partida de capacitación laboral "resolución pacífica de controversias".
--
-- Solo reemplaza el valor sembrado por la 021: si alguien ya lo ajustó desde la BD, se respeta.
UPDATE app.config
   SET valor = '["solución de controversias","someter las controversias","controversias que surjan",'
               '"prevención de controversias","prevenir controversias","generar controversias contractuales",'
               '"resolver en primera instancia cualquier controversia","resolución pacífica de controversias",'
               '"no existe controversia","no hay controversia","sin controversia"]',
       fe_mod = now()
 WHERE clave = 'chat.frases_estandar'
   AND valor = '["solución de controversias","someter las controversias","controversias que surjan",'
               '"prevención de controversias","prevenir controversias","generar controversias contractuales",'
               '"resolver en primera instancia cualquier controversia"]';
