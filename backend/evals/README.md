# Evaluación del RAG

Fase 1 de `docs/PLAN-RAG-AVANZADO.md`. Mide el pipeline REAL del chat (planificador → híbrido + RRF →
rerank → presupuesto → respuesta) con un dataset versionado, y frena los cambios que lo empeoran.

## Archivos

| Archivo | Qué es |
|---|---|
| `casos.sgd.json`, `casos.std.json` | Dataset. Solo entran a la corrida los casos con `"revisado": true`. |
| `salidas/` | Corridas exportadas para Ragas (ignorado por git: contiene texto de documentos). |
| `ragas/` | Contenedor Python con Ragas v0.4 (servicio `rag-evals`, perfil `evals`). |

Esquema de un caso:

```jsonc
{
  "id": "sint-0dff113d8b",
  "pregunta": "¿Cuál es el monto de la carta fianza de fiel cumplimiento de China Civil?",
  "historial": [],                       // turnos previos, para casos de seguimiento
  "expediente": { "nuAnnExp": "2026", "nuSecExp": "0000123" },  // opcional (SGD, chat por expediente)
  "idDocumento": 48683,                  // opcional (STD, chat por documento)
  "ground_truth": "S/ 1 234 567,89",
  "relevantes": {
    "documentos": [{ "nuAnn": "2026", "nuEmi": "0001234", "nuAne": 0 }],  // STD: { "idAdjunto": n } o { "idDocumento": n }
    "evidencias": ["carta fianza de fiel cumplimiento por S/ 1 234 567,89"]  // frases LITERALES del documento
  },
  "sin_respuesta": false,                // true = lo correcto es "no está en la base de conocimiento"
  "tipo": "factual",                     // factual | jerga | compuesta | codigo | seguimiento | resumen | sin_respuesta
  "origen": "sintetico",                 // sintetico | historial | manual
  "revisado": false
}
```

Un fragmento recuperado cuenta como **relevante** si sale de un documento esperado y, si hay
`evidencias`, además contiene alguna (sin tildes ni mayúsculas).

## Flujo

Desde `backend/`, en el host. Use `127.0.0.1` y no `localhost`: Node resuelve `localhost` a `::1` y el
proxy IPv6 de Docker Desktop a veces se cuelga.

```bash
# 1. Sembrar borradores (sintéticos desde chunks reales + preguntas reales del chat)
APP_DB_HOST=127.0.0.1 APP_DB_PORT=5442 OLLAMA_URL=http://127.0.0.1:11434 \
  npm run eval:rag:semilla -- --modulo sgd --sinteticos 30 --historial

# 2. Revisar casos.sgd.json a mano: corregir la pregunta o el ground_truth, borrar los ambiguos,
#    agregar casos de jerga, compuestos, de seguimiento y sin_respuesta, y marcar "revisado": true.

# 3. Correr la evaluación (métricas deterministas + exportación para Ragas)
APP_DB_HOST=127.0.0.1 APP_DB_PORT=5442 OLLAMA_URL=http://127.0.0.1:11434 \
  npm run eval:rag -- --modulo sgd            # --aceptar la primera vez, para fijar la línea base

# 4. Métricas LLM con Ragas (desde la raíz del repo) e importarlas. En Git Bash de Windows anteponer
#    MSYS_NO_PATHCONV=1, o convierte /evals/... en C:/Program Files/Git/evals/...
docker compose --profile evals run --rm rag-evals /evals/salidas/sgd-<id>.json
npm run eval:rag:importar -- evals/salidas/sgd-<id>.ragas.json
```

`eval:rag` y `eval:rag:importar` salen con código 1 si alguna métrica cae más de 5 puntos frente a la
última corrida aceptada del módulo (`--tolerancia`, `--no-fallar`).

## Métricas

| Métrica | Dónde | Qué mide |
|---|---|---|
| Hit Rate @N | TS | Algún relevante entre los 20 candidatos de RRF (antes del rerank). |
| Hit Rate @K | TS | Algún relevante en el contexto final que ve el modelo. |
| MRR | TS | 1 / posición del primer relevante en el contexto final. |
| Precisión etiquetada @K | TS | Fracción del contexto final que es relevante. |
| Recall de evidencias @K | TS | Fracción de las evidencias del caso presentes en el contexto final. |
| Abstención correcta / indebida | TS | Casos `sin_respuesta` que se abstienen / casos normales que se abstienen sin deber. |
| faithfulness | Ragas | Afirmaciones de la respuesta sostenidas por el contexto. |
| answer_relevancy | Ragas | 3 preguntas generadas desde la respuesta vs. la original (coseno). |
| context_precision | Ragas | Lo útil para el ground_truth, ¿está arriba en el ranking? |
| context_recall | Ragas | Afirmaciones del ground_truth cubiertas por el contexto. |

Hit@N alto con Hit@K bajo = el relevante se recupera pero el rerank o el presupuesto lo descartan.
Hit@N bajo = falla la recuperación misma (búsqueda vectorial, FTS o reescritura de la consulta).

El juez de Ragas usa por defecto el mismo modelo de chat del backend (`OPENAI_*`) y los embeddings de
Ollama (`bge-m3`). Para cambiarlo: `EVAL_LLM_BASE_URL`, `EVAL_LLM_API_KEY`, `EVAL_LLM_MODEL`,
`EVAL_EMBED_BASE_URL`, `EVAL_EMBED_MODEL`; con modelos de Ollama como juez, `EVAL_LLM_MODO=md_json`.
