# syntax=docker/dockerfile:1

# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Build tools required for better-sqlite3 native bindings
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Install all deps (including devDeps) — native modules compiled here
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Compile TypeScript → dist/
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Copy static assets (not handled by tsc)
RUN cp -r src/web/public dist/web/public


# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# Create data directory and hand ownership to unprivileged node user
RUN mkdir -p /app/data && chown node:node /app/data

# Copy compiled output and node_modules (with native bindings) from builder
# Avoids re-compiling better-sqlite3 in the runtime stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Web dashboard port (default 8080, configurable via WEB_PORT)
EXPOSE 8080

USER node

VOLUME ["/app/data"]

CMD ["node", "dist/index.js"]
