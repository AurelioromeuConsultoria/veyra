# syntax=docker/dockerfile:1.7
#
# Imagem de PRODUÇÃO do web. Duas responsabilidades, e a segunda é a que evita
# um proxy a mais: além de servir o SPA, este nginx encaminha `/api` para o
# container da API pela rede interna. O proxy da VPS passa a ter UM upstream
# só, e `/api/channels/whatsapp/webhook` funciona sem regra extra.
#
# `nginx-unprivileged`: escuta em 8080 como uid 101, sem root em momento algum.

ARG NODE_VERSION=24-alpine

FROM node:${NODE_VERSION} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @veyra/web... --filter @veyra/contracts...

# `packages/config` carrega o tsconfig base que TODO tsconfig do monorepo
# estende. Sem ele, o `tsc` não falha por arquivo ausente: ele compila com os
# padrões da linguagem (target ES5, sem esModuleInterop) e explode em erros que
# não têm nada a ver com o código — foi exatamente o que aconteceu.
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN pnpm --filter @veyra/contracts build && pnpm --filter @veyra/web build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
# a imagem já roda como uid 101 (nginx); nenhum passo abaixo precisa de root
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY deploy/staging/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
