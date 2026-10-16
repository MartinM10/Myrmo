# Hosted MCP server (Streamable HTTP, stateless). Build context: repository root.
FROM node:22-alpine AS build
WORKDIR /src
COPY clients/typescript/package.json clients/typescript/package-lock.json ./
COPY clients/typescript/packages/myrmo/package.json packages/myrmo/
COPY clients/typescript/packages/myrmo-mcp/package.json packages/myrmo-mcp/
RUN npm ci --no-audit --no-fund
COPY clients/typescript/packages packages
# The hook scripts that `init` installs for Antigravity ship inside the package (scripts/copy-hooks.mjs).
COPY plugins/myrmo/scripts plugins/myrmo/scripts
# The trail schema, for checking a trail locally before anything is sent (src/check.ts).
COPY protocol/trail.v1.schema.json protocol/trail.v1.schema.json
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /src /app
USER node
EXPOSE 3333
# Inside a container the port must be reachable from the network: the server alone listens on loopback.
CMD ["node", "packages/myrmo-mcp/dist/index.js", "--http", "--port", "3333", "--host", "0.0.0.0"]
