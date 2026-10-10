# A task image plus the agent that will work in it. Built per task by run.py; the broken state and the hidden check
# come from the task image, which is why the agent runs inside the container and not next to it.
ARG BASE
ARG AGENT_NODE=node:22.12.0-bookworm-slim
FROM ${AGENT_NODE} AS agentnode

FROM ${BASE}
ARG AGENT=claude-code
ARG CLAUDE_CODE_VERSION=latest
ARG OPENCODE_VERSION=latest
ARG GEMINI_VERSION=latest
RUN command -v node >/dev/null 2>&1 || (apt-get update && apt-get install -y --no-install-recommends nodejs npm \
      && rm -rf /var/lib/apt/lists/*)
# Gemini CLI needs a newer Node than some tasks run on, and a task's own Node is part of its breakage (Node 22 can
# require() an ES module, so ERR_REQUIRE_ESM would vanish). The agent gets its own Node in /opt/agent-node, off the
# PATH, and only the `gemini` command uses it.
COPY --from=agentnode /usr/local/bin/node /opt/agent-node/bin/node
RUN if [ "$AGENT" = "opencode" ]; then \
      npm install -g --no-audit --no-fund opencode-ai@${OPENCODE_VERSION}; \
    elif [ "$AGENT" = "gemini" ]; then \
      npm install -g --no-audit --no-fund --prefix /opt/gemini @google/gemini-cli@${GEMINI_VERSION} \
      && printf '#!/bin/sh\nexec /opt/agent-node/bin/node /opt/gemini/bin/gemini "$@"\n' > /usr/local/bin/gemini \
      && chmod +x /usr/local/bin/gemini; \
    else \
      npm install -g --no-audit --no-fund @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}; \
    fi
