# Website + documentation, served by nginx.
# Stage 1 builds the VitePress docs; stage 2 serves the static site with the docs under /docs/.

FROM node:22-alpine AS docs
WORKDIR /src/docs
COPY docs/package.json docs/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY docs/ ./
ARG MYRMO_SITE_URL=http://localhost:3000
ENV MYRMO_SITE_URL=${MYRMO_SITE_URL} \
    MYRMO_DOCS_NO_GIT=1
RUN npx vitepress build

FROM nginx:1.27-alpine
COPY deploy/nginx-web.conf /etc/nginx/conf.d/default.conf
COPY web/ /usr/share/nginx/html/
COPY protocol/ /usr/share/nginx/protocol/
COPY --from=docs /src/docs/.vitepress/dist/ /usr/share/nginx/html/docs/
