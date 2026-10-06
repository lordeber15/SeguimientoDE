# Métricas LLM de Ragas sobre las corridas de `npm run eval:rag` (docs/PLAN-RAG-AVANZADO.md, Fase 1).
# Python aparte a propósito: el backend sigue siendo solo Node en producción.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    RAGAS_DO_NOT_TRACK=true

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY evaluar.py .

# Sin usuario propio a propósito: escribe el .ragas.json en el bind mount `backend/evals`, y en un
# host Linux un UID distinto del dueño de la carpeta no podría. Es un contenedor efímero
# (`run --rm`) sin puertos publicados.

ENTRYPOINT ["python", "/app/evaluar.py"]
