-- Vista "Calidad de procesos" — minería de procesos sobre el SGD.
-- Ver docs/PLAN-CALIDAD-PROCESOS.md. Tres piezas nuevas, todas en la BD PROPIA:
--
--  1. `dashboard.paso`     — el mismo emparejamiento recepción→respuesta del espejo, pero a nivel
--                            OFICINA en vez de empleado (ver más abajo por qué no alcanza con
--                            `dashboard.participacion`).
--  2. `dashboard.proceso`  — las familias de proceso descubiertas automáticamente agrupando el
--                            asunto de ORIGEN de cada expediente por similitud de trigramas.
--  3. `dashboard.proceso_alias` — el renombre manual de una familia, que sobrevive al refresco.

-- ── 1. Pasos a nivel oficina ────────────────────────────────────────────────────────────────────
--
-- ¿Por qué una tabla nueva y no columnas más en `dashboard.participacion`? Por dos motivos que no
-- se pueden resolver ahí sin cambiar los KPIs que ya están en producción:
--
--   a) `participacion` descarta las derivaciones sin empleado nombrado
--      (`COALESCE(co_emp_des,'') <> ''`) — 1 354 de 48 281 destinos (2,8%) verificado ✅ 2026-09-02.
--      Son documentos derivados a la oficina, no a una persona. Para un KPI por empleado sobran;
--      para reconstruir el recorrido de un expediente son agujeros en la cadena.
--   b) `participacion` empareja la respuesta por EMPLEADO (`co_emp_emi = co_emp_des`). Si un
--      expediente entra a Logística por el jefe y sale firmado por un especialista, ese reloj se
--      parte en dos tramos. El reloj de la OFICINA tiene que correr de la llegada a la salida, así
--      que aquí el emparejamiento es `co_dep_emi = co_dep_des`.
--
-- `fe_apertura` (`tdtv_destinos.fe_rec_doc`) permite partir el tiempo del nodo en espera (llegó →
-- lo abrieron) y trabajo (lo abrieron → respondieron). Verificado ✅ 2026-09-02: 91,9% de cobertura
-- y el 100% de esas filas trae hora real, no medianoche — a diferencia de `fe_ate_doc`, que se
-- descartó en su momento justamente por tener solo precisión de día.
CREATE TABLE IF NOT EXISTS dashboard.paso (
  nu_ann_exp         text      NOT NULL,
  nu_sec_exp         text      NOT NULL,
  -- Desempate del orden dentro del expediente, igual que `getInteraccionesExpediente`: dos remitos
  -- pueden compartir `fe_envio` al segundo, y sin esto la traza saldría en un orden arbitrario.
  nu_emi             text      NOT NULL,
  nu_des             text      NOT NULL,
  co_dep_emi         text,
  co_dep_des         text      NOT NULL,
  nombre_dependencia text,
  co_mot             text,
  co_tip_doc         text,
  es_informativo     boolean   NOT NULL,
  es_doc_rec         text,
  fe_envio           timestamp NOT NULL,
  fe_apertura        timestamp,
  segundos_total     numeric,
  segundos_espera    numeric,
  segundos_trabajo   numeric,
  asunto_norm        text
);

CREATE INDEX IF NOT EXISTS paso_expediente_idx ON dashboard.paso (nu_ann_exp, nu_sec_exp, fe_envio, nu_emi, nu_des);
-- Universo comparable de la propuesta de mejora: "mismo tipo de tarea sobre mismo tipo de
-- documento", sin importar el área ni el proceso.
CREATE INDEX IF NOT EXISTS paso_equivalencia_idx ON dashboard.paso (co_mot, co_tip_doc) WHERE NOT es_informativo;
CREATE INDEX IF NOT EXISTS paso_dep_fecha_idx ON dashboard.paso (co_dep_des, fe_envio);

-- ── 2. Familias de proceso descubiertas ─────────────────────────────────────────────────────────
--
-- `clave` es un hash del esqueleto del asunto líder, NO un id secuencial: cada refresco vuelve a
-- agrupar desde cero y los ids cambiarían, pero el hash del mismo texto no — así el renombre
-- manual de `proceso_alias` sigue apuntando a la misma familia después de un refresco.
CREATE TABLE IF NOT EXISTS dashboard.proceso (
  clave        text        PRIMARY KEY,
  nombre_auto  text        NOT NULL,
  expedientes  integer     NOT NULL,
  fe_calculado timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dashboard.proceso_expediente (
  nu_ann_exp    text NOT NULL,
  nu_sec_exp    text NOT NULL,
  proceso_clave text NOT NULL,
  asunto_origen text,
  PRIMARY KEY (nu_ann_exp, nu_sec_exp)
);

CREATE INDEX IF NOT EXISTS proceso_expediente_clave_idx ON dashboard.proceso_expediente (proceso_clave);

-- Deliberadamente SIN FK contra `dashboard.proceso`: el refresco reemplaza esa tabla entera, y un
-- alias que apunte a una familia que este refresco no volvió a descubrir (porque cambió el volumen
-- de datos) debe sobrevivir por si reaparece, no romper el refresco ni borrarse en cascada.
CREATE TABLE IF NOT EXISTS dashboard.proceso_alias (
  proceso_clave   text        PRIMARY KEY,
  nombre          text        NOT NULL,
  actualizado_por text,
  fe_actualizado  timestamptz NOT NULL DEFAULT now()
);

-- ── Configuración ───────────────────────────────────────────────────────────────────────────────
--
-- `similitud_min` calibrado ✅ 2026-09-02 contra la BD real (1 501 esqueletos de asunto distintos
-- sobre 1 981 expedientes cerrados): 0.45 mezcla trámites distintos, 0.65 fragmenta de más; 0.55
-- deja 506 familias, 58 con muestra suficiente, y recupera "PRESENTACIÓN DE DOCUMENTACIÓN PARA PAGO
-- DE CONSULTORÍA" (427 expedientes) como una sola familia.
--
-- `objetivo.percentil` NO es el mínimo absoluto a propósito: el caso más rápido de cualquier paso
-- suele ser alguien que derivó el documento sin leerlo, y como meta no se sostiene. p10 = "el menor
-- tiempo que alguien realmente sostiene". Ponerlo en 0 da el mínimo estricto.
INSERT INTO app.config (clave, valor, descripcion) VALUES
  ('calidad.proceso.similitud_min', '0.55',
   'Similitud de trigramas mínima (0-1) para que dos asuntos de origen caigan en la misma familia de proceso'),
  ('calidad.proceso.muestra_minima', '5',
   'Expedientes mínimos para que una familia de proceso se muestre y para que un paso sirva de referencia'),
  ('calidad.objetivo.percentil', '10',
   'Percentil del universo comparable que se toma como tiempo objetivo en la propuesta de mejora')
ON CONFLICT (clave) DO NOTHING;

-- ── Permisos ────────────────────────────────────────────────────────────────────────────────────
--
-- Mismo alcance abierto que `dashboard.ver`. Para renombrar una familia se reutiliza
-- `dashboard.gestionar` en vez de crear un permiso más, igual que hizo la Fase 3 con los pesos por
-- tipo de documento.
INSERT INTO app.permiso (codigo, descripcion) VALUES
  ('calidad.ver', 'Consultar la vista de calidad de procesos (flujogramas y propuesta de mejora)')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO app.rol_permiso (rol_codigo, permiso_codigo) VALUES
  ('admin', 'calidad.ver'),
  ('jefe',  'calidad.ver')
ON CONFLICT DO NOTHING;
