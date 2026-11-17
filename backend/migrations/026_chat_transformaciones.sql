-- Transformación de consultas del chat (docs/PLAN-RAG-AVANZADO.md, Fase 4). Interruptores editables
-- desde el panel del RAG, igual que el resto de `app.config`.
INSERT INTO app.config (clave, valor, descripcion) VALUES
  ('chat.descomposicion.activa', 'true',
   'Preguntas compuestas ("¿el monto del contrato y quién firmó la adenda?"): el planificador las '
   'divide en subconsultas y cada una se busca por separado antes de fusionar los resultados. Solo '
   'actúa cuando el planificador detecta 2 o más partes; cuesta una búsqueda extra por parte, no tokens.'),
  ('chat.hyde.activo', 'false',
   'HyDE: el modelo rápido redacta un párrafo hipotético con el estilo de los documentos y se busca '
   'también por su parecido. Suma una llamada corta al modelo (y su latencia) en cada pregunta de '
   'contenido; actívelo solo si la evaluación (npm run eval:rag -- --hyde) muestra que mejora.')
ON CONFLICT (clave) DO NOTHING;
