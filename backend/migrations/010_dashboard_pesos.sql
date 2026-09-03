-- Fase 3 — Complejidad documental configurable (ver PLAN-DASHBOARD-DESEMPENO.md §9).
--
-- No hay FK real a SI_MAE_TIPO_DOC: ese catálogo vive en el SGD (servidor distinto, de solo
-- lectura), así que `co_tip_doc` aquí es solo texto, igual que en `dashboard.participacion`.
--
-- No se agrega ningún permiso nuevo: `dashboard.gestionar` ya existe desde la migración 009
-- (refresco manual del espejo) y se reutiliza para administrar los pesos.
CREATE TABLE IF NOT EXISTS dashboard.tipo_documento_peso (
  co_tip_doc      text        PRIMARY KEY,
  peso            numeric     NOT NULL DEFAULT 1 CHECK (peso > 0),
  actualizado_por text,
  fe_actualizado  timestamptz NOT NULL DEFAULT now()
);
