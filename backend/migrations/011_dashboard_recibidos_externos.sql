-- Fase 8 — distingue, dentro de `recibidos`, cuánto llegó de OTRA oficina vs. cuánto llegó de la
-- MISMA oficina de destino (típicamente la respuesta a algo que ese mismo empleado/oficina había
-- emitido antes, dentro del mismo expediente). Sin esta columna, un jefe que reenvía un expediente
-- y luego recibe la contestación de su propia oficina aparecía con la misma "carga" que si ese
-- documento hubiera llegado de una oficina distinta — ver docs/PLAN-DASHBOARD-DESEMPENO.md §9,
-- regla de "Carga alta".
--
-- `co_dep_emi` YA se traía del SGD (join contra `tdtv_remitos` en `leerParticipacionesSgd`), pero
-- no se guardaba en el espejo — agregarla no suma ningún join nuevo contra el SGD.
ALTER TABLE dashboard.participacion ADD COLUMN IF NOT EXISTS co_dep_emi text;
