FROM python:3.12.4-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# What an app's Dockerfile does: install uv with its installer, in a RUN step (a non-login shell).
RUN curl -LsSf https://astral.sh/uv/0.4.30/install.sh | sh
# The wheel the build installs, kept here so that the task needs no package index.
RUN pip download --no-cache-dir --dest /opt/wheels six==1.16.0
WORKDIR /work
COPY files/ /work/
RUN chmod +x /work/build.sh
CMD ["sleep", "infinity"]
