# syntax=docker/dockerfile:1.7
# Multi-stage, non-root, pinned base images. Build context is the repo root
# (docker-compose.yml sets `context: .`) because this is a pnpm workspace —
# apps/api depends on sibling packages/* via workspace protocol.

FROM node:20.18.1-alpine3.20 AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

# ---- deps: install once, cached across builds unless lockfile/manifests change ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker-cpu/package.json apps/worker-cpu/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/logging/package.json packages/logging/package.json
COPY packages/errors/package.json packages/errors/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/events/package.json packages/events/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY prisma prisma
RUN pnpm install --frozen-lockfile

# ---- build: compile TS across the workspace, generate the Prisma client ----
FROM deps AS build
COPY . .
RUN pnpm prisma:generate
RUN pnpm --filter @audio-book/contracts run generate
RUN pnpm -r --filter "./packages/**" --filter @audio-book/api... run build

# ---- runtime: production deps only, non-root, minimal surface ----
FROM node:20.18.1-alpine3.20 AS runtime
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate \
  && addgroup -S app && adduser -S app -G app
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/apps/api ./apps/api
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/prisma ./prisma
COPY --from=build /repo/node_modules ./node_modules
USER app
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
