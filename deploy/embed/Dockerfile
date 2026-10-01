# Embedding service (TEI-compatible API) for x86_64 and arm64.
FROM python:3.12-slim
ENV PIP_NO_CACHE_DIR=1 \
    EMBED_MODEL=BAAI/bge-small-en-v1.5 \
    EMBED_CACHE=/models
RUN pip install "fastembed==0.7.*" "fastapi==0.115.*" "uvicorn[standard]==0.34.*"
# Bake the model into the image so containers start instantly and offline.
RUN python -c "import os; from fastembed import TextEmbedding; TextEmbedding(os.environ['EMBED_MODEL'], cache_dir='/models')"
COPY deploy/embed/app.py /app/app.py
WORKDIR /app
EXPOSE 80
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "80", "--workers", "1", "--log-level", "warning"]
