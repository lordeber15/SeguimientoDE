-- Permiso de gestión del RAG. Va aparte de `usuarios.gestionar` porque son responsabilidades
-- distintas: quien administra cuentas no tiene por qué decidir cuánto se gasta en LLM.

INSERT INTO app.permiso (codigo, descripcion) VALUES
  ('rag.gestionar', 'Administrar la base de conocimientos: barrido, ingesta y proveedores'),
  ('rag.consultar', 'Usar el chat sobre la base de conocimientos')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO app.rol_permiso (rol_codigo, permiso_codigo) VALUES
  ('admin', 'rag.gestionar'),
  ('admin', 'rag.consultar'),
  ('jefe',  'rag.consultar')
ON CONFLICT DO NOTHING;
