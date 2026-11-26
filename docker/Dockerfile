# syntax=docker/dockerfile:1.7
# Production image: one image, two processes.
#   web:    node server.js          (Next.js standalone, default CMD)
#   worker: node dist/worker.js     (BullMQ worker bundled with tsup)
#   migrate: prisma migrate deploy  (one-shot service in docker-compose.prod.yml)

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PNPM_VERSION=12.23.0
ARG PRISMA_VERSION=6.19.3

# ── base ──────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@${PNPM_VERSION}
ENV NEXT_TELEMETRY_DISABLED=1 PNPM_STORE_DIR=/pnpm/store
WORKDIR /app

# ── deps: pnpm fetch + offline install (cached on the lockfile only) ──
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm fetch
COPY prisma ./prisma
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline

# ── build: prisma client, Next standalone, worker bundle ─────────────
FROM deps AS build
COPY . .
ENV NODE_ENV=production
RUN pnpm prisma generate \
 && pnpm build:web \
 && pnpm build:worker

# ── runner ────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runner
ARG PRISMA_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g prisma@${PRISMA_VERSION} \
 && npm cache clean --force
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    TZ=Asia/Kolkata \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
