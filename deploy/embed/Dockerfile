# Embedding service (TEI-compatible API) for x86_64 and arm64.
FROM python:3.12-slim
ENV PIP_NO_CACHE_DIR=1 \
    EMBED_MODEL=BAAI/bge-small-en-v1.5 \
    EMBED_CACHE=/models
RUN pip install "fastembed==0.7.*" "fastapi==0.115.*" "uvicorn[standard]==0.34.*"
# Bake the model into the image so containers start instantly and offline.
RUN python -c "import os; from fastembed import TextEmbedding; TextEmbedding(os.environ['EMBED_MODEL'], cache_dir='/models')"
# The task model of a private colony's second index, baked too (an empty TASK_MODEL leaves it out). It is only loaded
# when EMBED_TASK_MODEL names it at run time, so a colony without a task index pays for the image size, not memory.
ARG TASK_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
RUN if [ -n "$TASK_MODEL" ]; then python -c "import sys; from fastembed import TextEmbedding; TextEmbedding(sys.argv[1], cache_dir='/models')" "$TASK_MODEL"; fi
COPY deploy/embed/app.py /app/app.py
WORKDIR /app
EXPOSE 80
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "80", "--workers", "1", "--log-level", "warning"]
