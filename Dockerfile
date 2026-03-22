# syntax=docker/dockerfile:1

# ── Stage 1: Install dependencies ─────────────────────────────────────────────
# Separate from build stage so source code changes don't invalidate the
# expensive native-module install. On arm64 runners, better-sqlite3 downloads
# a prebuilt binary via prebuild-install — no compilation needed.
# Build tools are only installed as a fallback if prebuild-install fails.
FROM node:20-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./

# Try prebuilt binaries first; only install build tools if that fails.
# This saves ~2-3 minutes on arm64 where prebuilds are available.
RUN --mount=type=cache,target=/root/.npm \
    npm ci || \
    (apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/* && npm ci)

# ── Stage 2: Build TypeScript ─────────────────────────────────────────────────
FROM deps AS builder

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune devDependencies — only production deps go to the runtime image
RUN npm prune --omit=dev

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# Create data directory and hand ownership to unprivileged node user
RUN mkdir -p /app/data && chown node:node /app/data

# Copy compiled output and production-only node_modules from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Web dashboard port (default 8080, configurable via WEB_PORT)
EXPOSE 8080

USER node

VOLUME ["/app/data"]

CMD ["node", "dist/index.js"]
