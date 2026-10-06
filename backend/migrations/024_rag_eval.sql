-- Evaluación automatizada del RAG (docs/PLAN-RAG-AVANZADO.md, Fase 1).
--
-- El DATASET no vive aquí: es `backend/evals/casos.<modulo>.json`, versionado con el código (igual
-- que `casosPlanificador.json`), porque un caso se revisa a mano y debe viajar con el commit que lo
-- hace pasar. Aquí solo quedan las CORRIDAS, para comparar contra la línea base y ver la tendencia.
-- Ambos módulos (SGD y STD) guardan sus corridas en esta base: es tooling, no corpus.

CREATE TABLE IF NOT EXISTS rag.eval_corrida (
  id             bigserial PRIMARY KEY,
  modulo         text        NOT NULL CHECK (modulo IN ('sgd', 'std')),
  fe             timestamptz NOT NULL DEFAULT now(),
  commit_git     text,
  -- Proveedor/modelo de chat y embeddings, constantes del retrieval, flags de la corrida.
  config         jsonb       NOT NULL,
  casos          integer     NOT NULL,
  -- Métricas deterministas calculadas en TS (Hit Rate, MRR, precisión etiquetada, recall de evidencias…).
  metricas       jsonb       NOT NULL,
  -- Métricas LLM de Ragas (faithfulness, answer_relevancy, context_precision, context_recall),
  -- importadas después desde el contenedor `rag-evals`. NULL hasta entonces.
  metricas_ragas jsonb,
  -- Línea base: la última corrida aceptada de cada módulo es contra la que se compara la siguiente.
  aceptada       boolean     NOT NULL DEFAULT false,
  archivo        text
);

CREATE INDEX IF NOT EXISTS eval_corrida_modulo_idx ON rag.eval_corrida (modulo, fe DESC);

CREATE TABLE IF NOT EXISTS rag.eval_resultado (
  corrida_id   bigint  NOT NULL REFERENCES rag.eval_corrida(id) ON DELETE CASCADE,
  caso_id      text    NOT NULL,
  metricas     jsonb   NOT NULL,
  metricas_ragas jsonb,
  intencion    text,
  consulta     text,
  respuesta    text,
  ms           integer NOT NULL,
  error        text,
  PRIMARY KEY (corrida_id, caso_id)
);
