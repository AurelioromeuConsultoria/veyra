# syntax=docker/dockerfile:1.7
#
# Imagem de PRODUÇÃO da API (Nest + Prisma + pg-boss).
#
# Três estágios: `deps` resolve o workspace inteiro (o app importa
# `@veyra/contracts` por `workspace:*`), `build` compila contratos e API, e
# `runtime` recebe só o necessário para rodar. O cliente Prisma é gerado no
# build porque ele é código, não configuração — gerar no boot deixaria o
# container dependendo de rede para subir.
#
# Roda como usuário não-root (uid 10001). O diretório de storage é criado aqui
# com esse dono: o volume nomeado herda a propriedade do diretório da imagem no
# primeiro uso, e sem isso a aplicação sobe sem conseguir escrever.

ARG NODE_VERSION=24-alpine

# ── deps ────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
# `CI=true`: sem TTY, o pnpm ABORTA a remoção do node_modules em vez de
# perguntar, e o passo `--prod` falha com ERR_PNPM_ABORTED_REMOVE_MODULES_DIR
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# `--frozen-lockfile`: build reprodutível — lock desatualizado FALHA em vez de
# resolver versões novas em silêncio
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @veyra/api... --filter @veyra/contracts...

# ── build ───────────────────────────────────────────────────────────────────
FROM deps AS build
# `packages/config` carrega o tsconfig base que TODO tsconfig do monorepo
# estende. Sem ele, o `tsc` não falha por arquivo ausente: ele compila com os
# padrões da linguagem (target ES5, sem esModuleInterop) e explode em erros que
# não têm nada a ver com o código — foi exatamente o que aconteceu.
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter @veyra/contracts build \
 && pnpm --filter @veyra/api prisma:generate \
 && pnpm --filter @veyra/api build

# produção: reinstala sem devDependencies, mantendo o cliente Prisma gerado
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @veyra/api... --filter @veyra/contracts...

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
# `tini` como PID 1: o Node ignora SIGTERM em alguns caminhos e o container
# levaria 10s para morrer em todo deploy
RUN apk add --no-cache tini curl \
 && addgroup -g 10001 -S veyra \
 && adduser -u 10001 -S -G veyra -h /app veyra
WORKDIR /app

COPY --from=build --chown=veyra:veyra /repo/node_modules ./node_modules
COPY --from=build --chown=veyra:veyra /repo/packages/contracts ./packages/contracts
COPY --from=build --chown=veyra:veyra /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=veyra:veyra /repo/apps/api/dist ./apps/api/dist
COPY --from=build --chown=veyra:veyra /repo/apps/api/package.json ./apps/api/
# schema e migrations viajam na imagem: `migrate deploy` roda a partir DELA,
# então a versão do schema e a do código são sempre a mesma
COPY --from=build --chown=veyra:veyra /repo/apps/api/prisma ./apps/api/prisma
COPY --from=build --chown=veyra:veyra /repo/apps/api/prisma.config.ts ./apps/api/

RUN mkdir -p /data/storage && chown -R veyra:veyra /data
USER veyra
WORKDIR /app/apps/api
EXPOSE 3001

# a rota de saúde é pública e não toca o banco (ADR-016): serve para o
# orquestrador saber que o processo responde, não que o sistema está íntegro
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3001/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
