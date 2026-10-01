# Hosted MCP server (Streamable HTTP, stateless). Build context: repository root.
FROM node:22-alpine AS build
WORKDIR /src
COPY clients/typescript/package.json clients/typescript/package-lock.json ./
COPY clients/typescript/packages/myrmo/package.json packages/myrmo/
COPY clients/typescript/packages/myrmo-mcp/package.json packages/myrmo-mcp/
RUN npm ci --no-audit --no-fund
COPY clients/typescript/packages packages
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /src /app
USER node
EXPOSE 3333
CMD ["node", "packages/myrmo-mcp/dist/index.js", "--http", "--port", "3333"]
