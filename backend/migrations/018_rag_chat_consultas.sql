-- Chat con planificador y respuestas cerradas (docs/PLAN-CHAT-CONSULTAS.md, Fase 2).

-- Tipo de respuesta del asistente: 'texto' (LLM con citas), 'tabla' (listados sin LLM, Fase 3) o
-- 'fijo' (mensaje de cierre: fuera de alcance, ayuda o sin resultados — 0 tokens de respuesta).
ALTER TABLE rag.chat_mensaje
  ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'texto'
    CHECK (tipo IN ('texto', 'tabla', 'fijo')),
  -- Plan del turno y, desde la Fase 3, el conjunto de expedientes resultante: es la memoria que
  -- permite "de esos, ¿cuál es el último?" y el paginado "ver más" sin volver a buscar.
  ADD COLUMN IF NOT EXISTS meta jsonb;

-- Telemetría para calibrar el planificador con preguntas reales.
ALTER TABLE rag.retrieval_log
  ADD COLUMN IF NOT EXISTS intencion          text,
  ADD COLUMN IF NOT EXISTS consulta_reescrita text,
  ADD COLUMN IF NOT EXISTS planificador_respaldo boolean,
  ADD COLUMN IF NOT EXISTS ms_planificador    integer,
  ADD COLUMN IF NOT EXISTS respuesta_fija     text;

INSERT INTO app.config (clave, valor, descripcion) VALUES
  ('chat.planificador.activo', 'true',
   'Clasifica cada pregunta del chat antes de buscar (una llamada corta al modelo). Apagado, el '
   'chat vuelve al comportamiento anterior: toda pregunta va a la búsqueda de contenido.'),
  ('chat.mensaje_ayuda',
   'Respondo solo sobre la información de la base de conocimiento: expedientes, documentos, '
   'remitentes, indicaciones y su contenido. Por ejemplo: "dame los expedientes de la obra '
   'Huancavelica" o "¿qué dice el último informe de controversia?".',
   'Respuesta fija a saludos, agradecimientos y "¿qué puedes hacer?" (sin llamar al modelo).'),
  ('chat.mensaje_fuera_alcance',
   'Esa consulta no es sobre la información de la base de conocimiento, así que no puedo '
   'responderla. Pregúnteme por expedientes, documentos, remitentes o su contenido.',
   'Respuesta fija cuando el planificador clasifica la pregunta como ajena a los datos.'),
  ('chat.mensaje_sin_resultados',
   'No encontré información sobre eso en la base de conocimiento.',
   'Respuesta fija cuando la búsqueda no devuelve nada relevante (no se llama al modelo).')
ON CONFLICT (clave) DO NOTHING;
