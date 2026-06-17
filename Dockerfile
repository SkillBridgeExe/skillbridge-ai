# =========================================================================
# Multi-stage Dockerfile for Cloud Run deployment.
# Repo uses pnpm (pnpm-lock.yaml) — NOT npm. Native deps (bcrypt, etc.) are
# compiled in the builder stage only; the runtime image gets the pruned,
# already-built node_modules so it needs no toolchain.
# =========================================================================

# ----- Stage 1: build -----
FROM node:22-alpine AS builder

# Non-interactive CI: skip corepack's download confirmation prompt.
ENV CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PUPPETEER_SKIP_DOWNLOAD=true

# bcrypt / node-gyp native builds need python3 + a C toolchain on alpine.
RUN apk add --no-cache python3 make g++ && corepack enable

WORKDIR /app

# Install ALL deps (incl. dev) against the committed lockfile — reproducible.
# pnpm-workspace.yaml carries `allowBuilds` (native build-script approval) — pnpm
# 11.3 exits 1 if a package with a build script isn't listed there, so it MUST be
# present before install.
# --trust-lockfile: our lockfile is committed/trusted, so skip pnpm 11.3's
# supply-chain verification step (re-applies minimumReleaseAge/trustPolicy to
# all 877 entries) which makes network calls and fails the headless build.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --trust-lockfile

COPY . .
RUN pnpm run build
# Drop dev dependencies in place so the runtime stage can copy a lean tree
# without recompiling native modules.
RUN pnpm prune --prod

# ----- Stage 2: production -----
FROM node:22-alpine AS production

ENV NODE_ENV=production PUPPETEER_SKIP_DOWNLOAD=true

# Puppeteer uses system Chromium instead of a browser cache from the build stage.
RUN apk add --no-cache \
    ca-certificates \
    chromium \
    fontconfig \
    font-noto-cjk \
    freetype \
    harfbuzz \
    nss

WORKDIR /app

# Pruned prod node_modules (native modules already compiled in the builder).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Compiled output + runtime assets read via process.cwd():
#   - prompts/  → LLM prompt templates
#   - data/     → skills-pilot.json, role-rubrics-pilot.json, course catalog, jobs seed
#     (data/.cache is excluded via .dockerignore)
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prompts ./prompts
COPY --from=builder /app/data ./data

# Cloud Run injects PORT (default 8080); main.ts binds 0.0.0.0:$PORT.
EXPOSE 8080

CMD ["node", "dist/main"]
