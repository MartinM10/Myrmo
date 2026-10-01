# Laya System One decision model (Apache-2.0), CPU build.
FROM python:3.12-slim
ENV PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models \
    LAYA_HOST=0.0.0.0 \
    LAYA_PORT=8000 \
    LAYA_DEVICE=cpu \
    LAYA_PRELOAD=1 \
    LAYA_MODELS=english \
    LAYA_DEFAULT_MODEL=english
RUN pip install torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install "laya[serve]==0.3.22"
EXPOSE 8000
CMD ["laya-serve"]
