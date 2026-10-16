# Embedding service (TEI-compatible API) for x86_64 and arm64.
# The base image is pinned by digest (Dependabot proposes the updates), the Python packages by exact version.
FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
ENV PIP_NO_CACHE_DIR=1 \
    EMBED_MODEL=BAAI/bge-small-en-v1.5 \
    EMBED_CACHE=/models
RUN pip install "fastembed==0.7.4" "fastapi==0.115.14" "uvicorn[standard]==0.34.3"
# It runs as an unprivileged user, who owns the model cache: the models are downloaded as that user below, so the
# files are theirs without a chown that would copy them into another layer.
RUN useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin embed \
 && install -d -o embed -g embed /models
USER embed
# Bake the model into the image so containers start instantly and offline.
RUN python -c "import os; from fastembed import TextEmbedding; TextEmbedding(os.environ['EMBED_MODEL'], cache_dir='/models')"
# The task model of a private colony's second index, baked too (an empty TASK_MODEL leaves it out). It is only loaded
# when EMBED_TASK_MODEL names it at run time, so a colony without a task index pays for the image size, not memory.
ARG TASK_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
RUN if [ -n "$TASK_MODEL" ]; then python -c "import sys; from fastembed import TextEmbedding; TextEmbedding(sys.argv[1], cache_dir='/models')" "$TASK_MODEL"; fi
COPY deploy/embed/app.py /app/app.py
WORKDIR /app
# Port 80 as a non-root user: Docker (20.10 and later) lets any user of a container bind ports below 1024.
EXPOSE 80
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "80", "--workers", "1", "--log-level", "warning"]
