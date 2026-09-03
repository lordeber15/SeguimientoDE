-- Permiso del dashboard de evaluación de desempeño documental. Mismo alcance abierto que
-- `seguimiento.ver` hoy (admin/jefe pueden consultar el desempeño de cualquier empleado u
-- oficina) — no hay modelo de "solo mis datos" en esta fase.

INSERT INTO app.permiso (codigo, descripcion) VALUES
  ('dashboard.ver', 'Consultar el dashboard de evaluación de desempeño documental')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO app.rol_permiso (rol_codigo, permiso_codigo) VALUES
  ('admin', 'dashboard.ver'),
  ('jefe',  'dashboard.ver')
ON CONFLICT DO NOTHING;
