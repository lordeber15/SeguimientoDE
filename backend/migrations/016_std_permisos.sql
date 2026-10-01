-- Permisos del módulo STD (Sistema de Trámite Documentario de UE118/PMESUT).
--
-- A diferencia del RAG del SGD (rag.gestionar/rag.consultar, abierto también a "jefe"), el STD
-- queda SOLO para "admin": es un sistema legado, casi sin uso activo, y la decisión tomada fue no
-- abrirlo a más roles hasta que haya una necesidad real de hacerlo.
--
-- Los permisos viven aquí, en `seguimiento_app` (junto con el resto de app.rol/app.usuario_rol),
-- aunque los datos que gobiernan vivan en la base aparte `std_rag`: el login y los roles siguen
-- siendo los mismos del SGD, no hay una identidad de usuario distinta para el STD.

INSERT INTO app.permiso (codigo, descripcion) VALUES
  ('std.gestionar', 'Administrar la base de conocimientos del STD: barrido, ingesta y proveedores'),
  ('std.consultar', 'Usar el chat y la búsqueda sobre el STD')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO app.rol_permiso (rol_codigo, permiso_codigo) VALUES
  ('admin', 'std.gestionar'),
  ('admin', 'std.consultar')
ON CONFLICT DO NOTHING;
