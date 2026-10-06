"""
Métricas LLM de Ragas (v0.4) sobre una corrida exportada por `npm run eval:rag`
(docs/PLAN-RAG-AVANZADO.md, Fase 1).

    docker compose --profile evals run --rm rag-evals /evals/salidas/sgd-12.json

Entrada: {"corrida_id", "modulo", "muestras": [{"caso_id", "question", "contexts", "answer", "ground_truth"}]}
Salida:  el mismo nombre con .ragas.json -> {"corrida_id", "modulo", "metricas", "por_caso"}; se
importa a la BD con `npm run eval:rag:importar -- <archivo>`.

Métricas:
- faithfulness:      afirmaciones de la respuesta sostenidas por el contexto recuperado.
- answer_relevancy:  genera 3 preguntas desde la respuesta (strictness=3) y mide el coseno con la
                     pregunta original.
- context_precision: los fragmentos útiles para el ground_truth, ¿están arriba en el ranking?
- context_recall:    afirmaciones del ground_truth que el contexto recuperado cubre.

Juez y embeddings por API compatible con OpenAI. Por defecto, el mismo modelo de chat del backend
(OPENAI_*) y los embeddings de Ollama (OLLAMA_URL/v1, bge-m3): nada sale a un proveedor nuevo. Se
sobreescriben con EVAL_LLM_* / EVAL_EMBED_*.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable

from openai import AsyncOpenAI
from ragas.embeddings.base import embedding_factory
from ragas.llms import llm_factory
from ragas.metrics.collections import (
    AnswerRelevancy,
    ContextPrecisionWithReference,
    ContextRecall,
    Faithfulness,
)


def env(*nombres: str, defecto: str | None = None) -> str | None:
    for n in nombres:
        v = os.environ.get(n, "").strip()
        if v:
            return v
    return defecto


def construir_metricas() -> dict[str, tuple[Any, Callable[[dict], dict]]]:
    llm_base = env("EVAL_LLM_BASE_URL", "OPENAI_URL", defecto="https://api.openai.com/v1")
    llm_key = env("EVAL_LLM_API_KEY", "OPENAI_API_KEY", defecto="sin-clave")
    llm_modelo = env("EVAL_LLM_MODEL", "OPENAI_CHAT_MODEL", defecto="gpt-4o-mini")

    ollama = env("OLLAMA_URL", defecto="http://host.docker.internal:11434").rstrip("/")
    emb_base = env("EVAL_EMBED_BASE_URL", defecto=f"{ollama}/v1")
    emb_key = env("EVAL_EMBED_API_KEY", defecto="ollama")
    emb_modelo = env("EVAL_EMBED_MODEL", "OLLAMA_EMBED_MODEL", defecto="bge-m3")

    modo = {}
    if env("EVAL_LLM_MODO") == "md_json":
        # Backends sin `response_format` (algunos modelos de Ollama): instructor extrae el JSON del markdown.
        import instructor

        modo = {"mode": instructor.Mode.MD_JSON}

    print(f"Juez: {llm_modelo} @ {llm_base} · embeddings: {emb_modelo} @ {emb_base}", flush=True)
    llm = llm_factory(llm_modelo, client=AsyncOpenAI(base_url=llm_base, api_key=llm_key), **modo)
    emb = embedding_factory(
        "openai", model=emb_modelo, client=AsyncOpenAI(base_url=emb_base, api_key=emb_key), interface="modern"
    )

    # Cada métrica recibe solo los argumentos que su `ascore` declara.
    return {
        "faithfulness": (
            Faithfulness(llm=llm),
            lambda m: {"user_input": m["question"], "response": m["answer"], "retrieved_contexts": m["contexts"]},
        ),
        "answer_relevancy": (
            AnswerRelevancy(llm=llm, embeddings=emb, strictness=3),
            lambda m: {"user_input": m["question"], "response": m["answer"]},
        ),
        "context_precision": (
            ContextPrecisionWithReference(llm=llm),
            lambda m: {
                "user_input": m["question"],
                "reference": m["ground_truth"],
                "retrieved_contexts": m["contexts"],
            },
        ),
        "context_recall": (
            ContextRecall(llm=llm),
            lambda m: {
                "user_input": m["question"],
                "retrieved_contexts": m["contexts"],
                "reference": m["ground_truth"],
            },
        ),
    }


def valor_valido(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


async def con_reintentos(fn: Callable[[], Awaitable[Any]], intentos: int = 3) -> Any:
    """Backoff exponencial ante fallos transitorios del juez (rate limit, timeouts)."""
    for i in range(intentos):
        try:
            return await fn()
        except Exception:  # noqa: BLE001 — se relanza en el último intento
            if i == intentos - 1:
                raise
            await asyncio.sleep(2**i)


async def evaluar(muestras: list[dict], concurrencia: int) -> list[dict]:
    metricas = construir_metricas()
    semaforo = asyncio.Semaphore(concurrencia)

    async def puntuar(muestra: dict, nombre: str) -> tuple[str, float | None]:
        metrica, argumentos = metricas[nombre]
        async with semaforo:
            try:
                r = await con_reintentos(lambda: metrica.ascore(**argumentos(muestra)))
                return nombre, valor_valido(getattr(r, "value", r))
            except Exception as e:  # noqa: BLE001 — una métrica rota no tumba la corrida
                print(f"  ! {muestra['caso_id']} {nombre}: {type(e).__name__}: {str(e)[:200]}", flush=True)
                return nombre, None

    async def caso(muestra: dict) -> dict:
        pares = await asyncio.gather(*(puntuar(muestra, n) for n in metricas))
        resultado = {"caso_id": muestra["caso_id"], "metricas": dict(pares)}
        valores = " ".join(f"{k}={'—' if v is None else f'{v:.2f}'}" for k, v in pares)
        print(f"  {muestra['caso_id']:<32} {valores}", flush=True)
        return resultado

    return await asyncio.gather(*(caso(m) for m in muestras))


def promedios(por_caso: list[dict]) -> dict[str, float | None]:
    nombres = {k for c in por_caso for k in c["metricas"]}
    salida: dict[str, float | None] = {}
    for n in sorted(nombres):
        vals = [c["metricas"][n] for c in por_caso if c["metricas"].get(n) is not None]
        salida[n] = sum(vals) / len(vals) if vals else None
    return salida


def main() -> int:
    if len(sys.argv) < 2:
        print("Uso: evaluar.py /evals/salidas/<modulo>-<corrida>.json", file=sys.stderr)
        return 2
    entrada = Path(sys.argv[1])
    datos = json.loads(entrada.read_text(encoding="utf-8"))
    muestras = datos["muestras"]
    if not muestras:
        print("La corrida no tiene muestras evaluables (¿corrida con --sin-generacion o todo sin contexto?).")
        return 1

    concurrencia = int(env("EVAL_CONCURRENCIA", defecto="4"))
    print(f"Ragas sobre {len(muestras)} muestras de la corrida #{datos['corrida_id']} ({datos['modulo']})…", flush=True)
    por_caso = asyncio.run(evaluar(muestras, concurrencia))
    metricas = promedios(por_caso)

    salida = entrada.with_name(entrada.stem + ".ragas.json")
    salida.write_text(
        json.dumps(
            {"corrida_id": datos["corrida_id"], "modulo": datos["modulo"], "metricas": metricas, "por_caso": por_caso},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print("\nPromedios:")
    for k, v in metricas.items():
        print(f"  {k:<20} {'—' if v is None else f'{v:.3f}'}")
    print(f"\nEscrito {salida}. Importar: npm run eval:rag:importar -- evals/salidas/{salida.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
