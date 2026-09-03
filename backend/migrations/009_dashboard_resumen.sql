-- Espejo materializado del dashboard de desempeño, en la BD PROPIA (no en el SGD, de solo
-- lectura). Ver docs/PLAN-DASHBOARD-DESEMPENO.md §5 — "hallazgo de rendimiento 2026-08-28": con
-- ~42 000 remitos, la consulta en vivo contra el SGD (LATERAL JOIN emparejando cada recepción con
-- su respuesta) tardaba 8-10 s porque ese emparejamiento es, por naturaleza, un bucle anidado que
-- escala con el volumen — no es un problema de estadísticas ni de índices faltantes.
--
-- La mitigación, ya anticipada en el plan: materializar aquí, con un refresco periódico en
-- background, el resultado YA EMPAREJADO — una fila por participación (recepción) y una fila por
-- emisión — para que `dashboardService.ts` agregue (GROUP BY, percentiles, ventanas) sobre una
-- tabla LOCAL e indexable, en vez de recalcular el emparejamiento en cada carga del dashboard.
--
-- Nombres/dependencias van DESNORMALIZADOS en la propia fila (copiados del SGD en el momento del
-- refresco): así la consulta local no necesita ningún JOIN contra el SGD. Se desactualizan como
-- máximo lo que tarde en correr el próximo refresco (cadencia por defecto: 15 min) si alguien
-- cambia de nombre en el SGD — aceptable, no es un dato que cambie con frecuencia.

CREATE SCHEMA IF NOT EXISTS dashboard;

-- Una fila por RECEPCIÓN dentro del rango histórico completo (no acotado a 12 meses: la pestaña
-- "Pendientes" necesita ver todo el backlog, sin importar cuándo se recibió). `atendido` ya es el
-- resultado final de la lógica de Fase 1 (fe_respuesta emparejada O es_doc_rec IN ('2','3')) —
-- unificado como la única definición de "resuelto" en todo el dashboard, incluida la pestaña
-- Pendientes (que en Fase 2 usaba un `NOT EXISTS` sin ventana, ligeramente distinto en casos muy
-- extremos de re-participación; se unifica aquí a propósito para no mantener dos nociones de
-- "atendido").
CREATE TABLE IF NOT EXISTS dashboard.participacion (
  co_emp_des         text        NOT NULL,
  nombre_empleado     text,
  co_dep_des         text        NOT NULL,
  nombre_dependencia text,
  co_tip_doc         text,
  es_informativo     boolean     NOT NULL,
  fe_envio           timestamp   NOT NULL,
  atendido           boolean     NOT NULL,
  segundos_corridos  numeric,
  segundos_habiles   numeric,
  nu_ann_exp         text        NOT NULL,
  nu_sec_exp         text        NOT NULL
);

CREATE INDEX IF NOT EXISTS participacion_dep_fecha_idx ON dashboard.participacion (co_dep_des, fe_envio);
CREATE INDEX IF NOT EXISTS participacion_emp_dep_fecha_idx ON dashboard.participacion (co_emp_des, co_dep_des, fe_envio);
CREATE INDEX IF NOT EXISTS participacion_expediente_idx ON dashboard.participacion (nu_ann_exp, nu_sec_exp);
-- Pendientes antiguos filtra por "no atendido" y ordena/agrupa por antigüedad — index parcial,
-- mucho más chico que el total porque la mayoría de las recepciones SÍ se atienden.
CREATE INDEX IF NOT EXISTS participacion_pendientes_idx ON dashboard.participacion (co_dep_des, fe_envio) WHERE NOT atendido;

-- Una fila por DOCUMENTO EMITIDO (sin importar si tuvo destino) — base de la tasa de anulación de
-- Fase 2. Dimensión de EMISIÓN (co_dep_emi/co_emp_emi), independiente de `participacion`.
CREATE TABLE IF NOT EXISTS dashboard.emision (
  co_dep_emi text,
  co_emp_emi text,
  co_tip_doc text,
  es_doc_emi text      NOT NULL,
  fe_emi     timestamp NOT NULL
);

CREATE INDEX IF NOT EXISTS emision_dep_fecha_idx ON dashboard.emision (co_dep_emi, fe_emi);
CREATE INDEX IF NOT EXISTS emision_emp_fecha_idx ON dashboard.emision (co_emp_emi, fe_emi);

-- Bitácora de refrescos — de aquí sale el "datos actualizados hace X min" de la UI y, si algo
-- falla, el motivo queda visible sin tener que ir a los logs del contenedor.
CREATE TABLE IF NOT EXISTS dashboard.resumen_refresco (
  id              bigserial PRIMARY KEY,
  fe_inicio       timestamptz NOT NULL DEFAULT now(),
  fe_fin          timestamptz,
  participaciones integer,
  emisiones       integer,
  ms_sgd          integer,
  ms_total        integer,
  disparo         text,
  error           text
);

CREATE INDEX IF NOT EXISTS resumen_refresco_fe_fin_idx ON dashboard.resumen_refresco (fe_fin DESC);

-- ── Configuración y permisos ────────────────────────────────────────────────

INSERT INTO app.config (clave, valor, descripcion) VALUES
  ('dashboard.resumen.activo', 'true',
   'Si está activo, refresca periódicamente el espejo local del dashboard de desempeño'),
  ('dashboard.resumen.cadencia_min', '15',
   'Minutos mínimos entre refrescos automáticos del espejo del dashboard')
ON CONFLICT (clave) DO NOTHING;

-- Separado de `dashboard.ver` — administra la infraestructura del dashboard (forzar un refresco;
-- en la Fase 3, también los pesos de complejidad), mismo patrón que `rag.consultar`/`rag.gestionar`.
INSERT INTO app.permiso (codigo, descripcion) VALUES
  ('dashboard.gestionar', 'Administrar el dashboard de desempeño: forzar refrescos y pesos de complejidad')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO app.rol_permiso (rol_codigo, permiso_codigo) VALUES
  ('admin', 'dashboard.gestionar')
ON CONFLICT DO NOTHING;
