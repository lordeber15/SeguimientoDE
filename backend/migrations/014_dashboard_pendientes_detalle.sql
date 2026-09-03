-- Drill-down de "Pendientes": hasta ahora `dashboard.participacion` solo servía para AGREGAR
-- (GROUP BY oficina/empleado); no guardaba la identidad del documento, así que no había forma de
-- responder "¿cuáles son los pendientes detrás de este número?". Se agregan las columnas que
-- faltan, alimentadas de los mismos JOIN que `leerParticipacionesSgd` ya hace contra el SGD — igual
-- que las migraciones 011 y 012.
--
-- `fe_archivo_expediente` es la pieza nueva de lógica, no solo un dato más: guarda el MAX(fe_emi)
-- entre los destinos ARCHIVADOS (es_doc_rec = '3') del mismo expediente. El archivado no tiene un
-- timestamp propio distinto de fe_emi — fe_ate_doc solo tiene precisión de día y ya está
-- descartado en el resto del sistema (ver seguimientoService.ts) — así que se toma el fe_emi del
-- destino que quedó en estado archivado. Con esto, `dashboardService.ts` puede excluir del backlog
-- los pendientes cuyo expediente YA se cerró después de que ese documento llegara: si el trámite
-- está archivado, nadie va a responder esa recepción, y contarla como "pendiente" es lo que hoy
-- infla el backlog a más del doble (2.847 → 1.076 tras esta y la exclusión de informativos).
--
-- Hasta el primer refresco (`POST /api/dashboard/resumen/refrescar`) estas columnas quedan en
-- NULL en todas las filas — el filtro de archivado no descarta nada y el detalle sale vacío; se
-- corrige solo en el próximo refresco automático. Forzar un refresco manual justo después de
-- desplegar para no esperar hasta 15 min con el detalle vacío.
ALTER TABLE dashboard.participacion
  ADD COLUMN IF NOT EXISTS nu_ann                text,
  ADD COLUMN IF NOT EXISTS nu_emi                text,
  ADD COLUMN IF NOT EXISTS nu_des                text,
  ADD COLUMN IF NOT EXISTS es_doc_rec            text,
  ADD COLUMN IF NOT EXISTS asunto                text,
  ADD COLUMN IF NOT EXISTS nu_expediente         text,
  ADD COLUMN IF NOT EXISTS nu_doc                text,
  ADD COLUMN IF NOT EXISTS fe_archivo_expediente timestamp;

-- El índice parcial de la migración 009 filtraba solo `NOT atendido`; el predicado real del
-- backlog ahora suma `NOT es_informativo` (y la comparación con fe_archivo_expediente, que no es
-- indexable de forma útil aquí). Se reemplaza por uno que sí cubre el WHERE que arma
-- `pendientesAntiguosPorOficina`/`pendientesDetalleOficina`.
DROP INDEX IF EXISTS dashboard.participacion_pendientes_idx;
CREATE INDEX IF NOT EXISTS participacion_backlog_idx
  ON dashboard.participacion (co_dep_des, fe_envio)
  WHERE NOT atendido AND NOT es_informativo;
