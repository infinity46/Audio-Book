# syntax=docker/dockerfile:1.7
# The `web` deployable from `context.md` §3.1: the Next.js frontend plus the
# colocated BFF that holds the session and calls `api`.
#
# Same shape as api.Dockerfile — multi-stage, pinned base, non-root, repo-root
# build context because this is a pnpm workspace.

FROM node:20.18.1-alpine3.20 AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

# ---- deps ------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @audio-book/web...

# ---- build -----------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/web apps/web
# The build must not need a running API or real key material: every page that
# reads either is `force-dynamic`, so nothing is prerendered against them.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @audio-book/web run build

# ---- runtime ---------------------------------------------------------------
FROM node:20.18.1-alpine3.20 AS runtime
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate \
  && addgroup -S app && adduser -S app -G app
WORKDIR /repo
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/apps/web ./apps/web
COPY --from=build /repo/node_modules ./node_modules
USER app
EXPOSE 3001
CMD ["pnpm", "--filter", "@audio-book/web", "run", "start"]
