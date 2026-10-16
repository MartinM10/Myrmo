# Laya System One decision model (Apache-2.0), CPU build.
# The base image is pinned by digest (Dependabot proposes the updates), the Python packages by exact version.
FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
ENV PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models \
    LAYA_HOST=0.0.0.0 \
    LAYA_PORT=8000 \
    LAYA_DEVICE=cpu \
    LAYA_PRELOAD=1 \
    LAYA_MODELS=english \
    LAYA_DEFAULT_MODEL=english
RUN pip install "torch==2.14.1" --index-url https://download.pytorch.org/whl/cpu \
 && pip install "laya[serve]==0.3.22"
# The server runs as the unprivileged user `laya`, who owns the model volume (/models). The entrypoint starts as root
# only to hand over a volume created by an older image, then drops to that user.
RUN useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin laya \
 && install -d -o laya -g laya /models
COPY --chmod=755 deploy/laya-entrypoint.sh /usr/local/bin/laya-entrypoint
EXPOSE 8000
ENTRYPOINT ["laya-entrypoint"]
CMD ["laya-serve"]
