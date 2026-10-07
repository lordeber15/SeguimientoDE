-- Calidad del chat en producción (docs/PLAN-RAG-AVANZADO.md, Fase 5): veredictos del juez LLM sobre una
-- muestra de turnos y valoraciones 👍/👎 de los usuarios. Ambas se borran con el mensaje (y este, con su
-- sesión): no sobreviven a la conversación que juzgan.

-- Un veredicto por mensaje del asistente. Puntajes en [0, 1]; `error` si el juez falló (se guarda igual,
-- para no reintentar en bucle el mismo turno ni ocultar que el juez está caído).
CREATE TABLE IF NOT EXISTS rag.juicio_turno (
  id                  bigserial PRIMARY KEY,
  mensaje_id          bigint NOT NULL UNIQUE REFERENCES rag.chat_mensaje(id) ON DELETE CASCADE,
  traza_id            text,
  fe                  timestamptz NOT NULL DEFAULT now(),
  proveedor           text,
  modelo              text,
  -- ¿Cada afirmación de la respuesta está sostenida por los fragmentos? (alucinación = baja)
  fidelidad           real CHECK (fidelidad BETWEEN 0 AND 1),
  -- ¿Responde lo que se preguntó?
  relevancia          real CHECK (relevancia BETWEEN 0 AND 1),
  -- ¿Las citas [Dn] apuntan al fragmento que sostiene cada afirmación?
  uso_citas           real CHECK (uso_citas BETWEEN 0 AND 1),
  -- La respuesta dice que la información no está en la base…
  se_abstiene         boolean,
  -- …y tiene razón (los fragmentos de verdad no la contienen). NULL si no se abstuvo.
  abstencion_correcta boolean,
  comentario          text,
  tokens_in           integer,
  tokens_out          integer,
  error               text
);
CREATE INDEX IF NOT EXISTS juicio_turno_fe_idx ON rag.juicio_turno (fe);

-- Una valoración por mensaje (la última gana). Solo puede valorar el dueño de la sesión.
CREATE TABLE IF NOT EXISTS rag.valoracion_mensaje (
  mensaje_id  bigint PRIMARY KEY REFERENCES rag.chat_mensaje(id) ON DELETE CASCADE,
  usuario_id  text NOT NULL,
  valor       smallint NOT NULL CHECK (valor IN (-1, 1)),
  comentario  text,
  fe          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS valoracion_mensaje_fe_idx ON rag.valoracion_mensaje (fe);

INSERT INTO app.config (clave, valor, descripcion) VALUES
  ('chat.juez.activo', 'false',
   'Juez LLM: evalúa en segundo plano una muestra de las respuestas del chat (fidelidad a los fragmentos, '
   'relevancia, uso de citas, abstención). No demora la respuesta, pero cada turno juzgado cuesta una '
   'llamada al modelo del juez.'),
  ('chat.juez.muestreo', '0.1',
   'Fracción de los turnos con respuesta del modelo que se juzgan (0–1). 0.1 = uno de cada diez.'),
  ('chat.juez.umbral_fidelidad', '0.7',
   'Alerta si la fidelidad media de los últimos juicios (7 días, mínimo 5) cae por debajo de este valor.')
ON CONFLICT (clave) DO NOTHING;
