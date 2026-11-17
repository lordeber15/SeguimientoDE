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

## Comparar métodos de rerank (Fase 3)

`--rerank local|cohere|llm|ninguno` sustituye a `RAG_RERANK_PROVIDER` en esa corrida. Con `local`
desde el host: `docker compose --profile rerank up -d reranker` y `RERANK_URL=http://127.0.0.1:8082`.

```bash
npm run eval:rag -- --modulo sgd --incluir-borradores --sin-generacion --rerank llm
npm run eval:rag -- --modulo sgd --incluir-borradores --sin-generacion --rerank local
```

Al final se imprime la latencia del rerank (p50/p95; el criterio de la fase es p95 < 800 ms en local),
cuántos casos cayeron al orden de RRF y, con cross-encoder, el puntaje máximo medio de los casos con y
sin un relevante en el contexto. `RAG_RERANK_UMBRAL` útil queda entre esos dos valores; en cada línea
de caso, `rr` es su puntaje máximo (`!` = respaldo a RRF). Todo queda también en `config.rerank` de
`rag.eval_corrida` y en `metricas.rerank` de cada `rag.eval_resultado`.

## Transformación de consultas (Fase 4)

Cada interruptor del módulo (`chat.descomposicion.activa`, `chat.hyde.activo`, editables en el panel
del RAG) y el vocabulario (`chat.sinonimos`) se pueden forzar en una corrida para compararlos:

```bash
# Línea de comparación: sin ninguna transformación
npm run eval:rag -- --modulo sgd --incluir-borradores --sin-generacion --sin-vocabulario --sin-descomposicion --sin-hyde
# Vocabulario + descomposición (lo que hace el chat por defecto)
npm run eval:rag -- --modulo sgd --incluir-borradores --sin-generacion --sin-hyde
# Todo, con HyDE
npm run eval:rag -- --modulo sgd --incluir-borradores --sin-generacion --hyde
```

Además del resumen se imprime una tabla **por tipo de caso**: el criterio de la fase es que suban
`jerga` y `compuesta`, y el promedio general los diluye. En cada línea de caso, `sub N` = se buscó con
N subconsultas, `H` = con HyDE, `V` = la consulta se expandió con el vocabulario.

Casos compuestos: `npm run eval:rag:semilla -- --modulo sgd --sinteticos 0 --compuestos 10` une pares de
casos sintéticos en una sola pregunta de dos partes; su "Recall de evidencias" dice si llegaron AMBAS.
Los casos de jerga no se pueden sintetizar bien: escríbalos a mano (`"tipo": "jerga"`) con la palabra
que usan los usuarios y no los documentos.

## Del chat en producción al dataset (Fase 5)

El juez LLM (panel del RAG → "Calidad del chat") evalúa una muestra de las respuestas reales y los
usuarios pueden marcarlas 👍/👎. Las que fallaron se traen como borradores:

```bash
npm run eval:rag:semilla -- --modulo sgd --sinteticos 0 --valorados
```

Trae los turnos con 👎 o con fidelidad bajo `chat.juez.umbral_fidelidad`, con el historial previo de la
conversación (y el expediente/documento si era un chat acotado). El `ground_truth` queda en
"PENDIENTE…" — hay que escribir la respuesta correcta y etiquetar los documentos relevantes antes de
marcar `"revisado": true`; mientras tanto no se exportan a Ragas. En `nota` va el motivo (👎 y su
comentario, o el comentario del juez) y la respuesta que dio el chat.
