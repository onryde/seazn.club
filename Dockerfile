# ── Stage 1: install all deps (including devDeps for build) ──────────────────
FROM node:26-alpine AS builder
WORKDIR /app

# Workspace manifests first so the install layer caches across source changes.
# pnpm-workspace.yaml is not optional here, and its absence is SILENT: besides
# the workspace globs it carries the public-hoist patterns for the three
# serverExternalPackages (pdfkit, exceljs). Leave it out and the
# install succeeds, `next build` succeeds, and the standalone server cannot
# resolve any of them at runtime — the scheduler then falls back to LLM repair,
# which is a
# designed path, so nothing surfaces an error..
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/engine/package.json packages/engine/
# node 26 dropped corepack, so pnpm is installed explicitly rather than activated.
RUN npm i -g pnpm@10.34.5
# BuildKit cache mount over pnpm's content-addressed store: it persists on the
# Fly builder disk between deploys, so a lockfile change re-fetches only what
# actually changed.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile

COPY . .

# NEXT_PUBLIC_* vars are baked into the client bundle at build time.
# Pass them via fly.toml [build.args] or `fly deploy --build-arg`.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_BASE_URL
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_POSTHOG_HOST
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=$NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_BASE_URL=$NEXT_PUBLIC_BASE_URL
ENV NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY
ENV NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST

# Sentry source-map upload during `next build` (next.config.js). ORG/PROJECT
# come from fly.toml [build.args]; AUTH_TOKEN is passed via `fly deploy
# --build-arg` from CI — it is a SECRET, never committed. Upload self-disables
# when SENTRY_AUTH_TOKEN is absent (local builds).
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ARG SENTRY_AUTH_TOKEN
ENV SENTRY_ORG=$SENTRY_ORG
ENV SENTRY_PROJECT=$SENTRY_PROJECT
ENV SENTRY_AUTH_TOKEN=$SENTRY_AUTH_TOKEN

# tsc gates types in CI; the in-build checker (the 6 GB-heap worker that
# SIGKILLed on builder VMs) is skipped here.
#
# This step needs roughly 4 GB: measured peak RSS is 3.83 GB, and most of it is
# NOT the JS heap — a 2 GB `--max-old-space-size` cap changed nothing, the
# build was still SIGKILLed at the same point. Turbopack's native side is the
# bulk, and it sits outside anything NODE_OPTIONS can bound.
#
# That is why the image is built on a CI runner and pushed to registry.fly.io
# rather than built by `flyctl deploy` (see the deploy job in ci.yml). The fly
# Depot builder reports nproc=4 and NO cgroup memory limit, so nothing bounds
# the build until the VM itself runs out and the kernel kills it — which it did
# deterministically, at 80s/88s/117s across three attempts, once #480 moved
# this stage to node:26-alpine.
#
RUN SKIP_TYPECHECK=1 npm run build --workspace apps/web

# ── Stage 2: minimal production image ────────────────────────────────────────
FROM node:26-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# standalone output + static assets + public dir
# (outputFileTracingRoot = repo root, so standalone mirrors the monorepo layout:
#  server.js lives at apps/web/server.js inside the standalone folder)
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static    ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public          ./apps/web/public

# Turbopack's standalone file-tracing drops the COMPILED instrumentation.js
# (and the lazy chunks it await-imports for sentry.server.config /
# sentry.edge.config) from apps/web/.next/standalone/apps/web/.next/server —
# it copies the raw, unusable instrumentation.ts source next to server.js
# instead. Next's runtime looks only for the compiled file, silently skips
# register() when it's missing, and Sentry.init() has NEVER run server-side in
# any deploy since instrumentation.ts was added — confirmed live: fly logs on
# seazn-club-stg show pino error/warn lines every deploy, zero of them ever
# reached Sentry, and `node apps/web/server.js` throws a ChunkLoadError
# resolving "register" the moment the missing chunk is reproduced locally.
# Overlaying the full compiled server/ dir (superset of the standalone one)
# supplies every chunk the tracer dropped; confirmed fixed by rebuilding this
# way and reproducing a real request error end to end.
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/server ./apps/web/.next/server

USER nextjs
EXPOSE 3000

CMD ["node", "apps/web/server.js"]
