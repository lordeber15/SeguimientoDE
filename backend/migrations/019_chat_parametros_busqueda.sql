-- Parámetros de la búsqueda de expedientes del chat (docs/PLAN-CHAT-CONSULTAS.md, Fase 3). Se
-- siembran con los mismos valores por defecto que `busquedaExpedientesService.leerParametros`, para
-- que se puedan calibrar desde la BD sin redesplegar.
INSERT INTO app.config (clave, valor, descripcion) VALUES
  ('chat.peso_asunto', '3',
   'Peso de una coincidencia en metadatos (asunto, remitente, emisor) frente a una en el contenido.'),
  ('chat.peso_contenido', '1',
   'Peso de una coincidencia dentro del contenido de los documentos (se amortigua con log).'),
  ('chat.tope_docs_por_termino', '5',
   'Tope de documentos por término en el contador "asunto (n doc.)" de cada fila.'),
  ('chat.meses_actual', '3',
   '"Actualmente" = movimiento en los últimos N meses, aunque el expediente esté archivado.'),
  ('chat.max_candidatos', '1000',
   'Máximo de expedientes guardados por listado (y consultados al SGD para "actual" / contar).')
ON CONFLICT (clave) DO NOTHING;
