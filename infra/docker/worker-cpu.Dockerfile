# syntax=docker/dockerfile:1.7
FROM node:20.18.1-alpine3.20 AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

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
COPY packages/ingestion/package.json packages/ingestion/package.json
COPY prisma prisma
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm prisma:generate
RUN pnpm --filter @audio-book/contracts run generate
RUN pnpm -r --filter "./packages/**" --filter @audio-book/worker-cpu... run build

# Pre-fetches the default OCR language's trained-data file at build time
# (busybox wget ships with the alpine base — no extra package needed) so
# the shipped image makes no runtime network call for OCR (task §29's
# "no silent fallback" — OCR_LANG_PATH below makes that explicit and
# overridable rather than an implicit network dependency). Uses the same
# CDN tesseract.js itself defaults to, so the file format matches exactly.
FROM base AS ocr-lang-data
RUN mkdir -p /ocr-lang-data \
  && wget -q -O /ocr-lang-data/eng.traineddata.gz \
  https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz

FROM node:20.18.1-alpine3.20 AS runtime
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate \
  && addgroup -S app && adduser -S app -G app
WORKDIR /repo
ENV NODE_ENV=production
ENV OCR_LANG_PATH=/repo/ocr-lang-data
COPY --from=build /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/apps/worker-cpu ./apps/worker-cpu
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/prisma ./prisma
COPY --from=build /repo/node_modules ./node_modules
COPY --from=ocr-lang-data /ocr-lang-data ./ocr-lang-data
USER app
CMD ["node", "apps/worker-cpu/dist/main.js"]
