# A task image plus the agent that will work in it. Built per task by run.py; the broken state and the hidden check
# come from the task image, which is why the agent runs inside the container and not next to it.
ARG BASE
FROM ${BASE}
ARG AGENT=claude-code
ARG CLAUDE_CODE_VERSION=latest
ARG OPENCODE_VERSION=latest
RUN command -v node >/dev/null 2>&1 || (apt-get update && apt-get install -y --no-install-recommends nodejs npm \
      && rm -rf /var/lib/apt/lists/*)
RUN if [ "$AGENT" = "opencode" ]; then \
      npm install -g --no-audit --no-fund opencode-ai@${OPENCODE_VERSION}; \
    else \
      npm install -g --no-audit --no-fund @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}; \
    fi
