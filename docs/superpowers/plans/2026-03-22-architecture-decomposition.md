# Architecture Decomposition Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose monolithic files into focused, testable modules without changing any behavior — pure refactor with zero functional changes.

**Architecture:** Split 5 large files into domain-specific modules. Each task extracts code into a new file, re-exports from the original (backward compat), then updates imports. Every task is independently committable and passes tsc + all existing tests.

**Tech Stack:** TypeScript ESM, better-sqlite3, Express, Telegraf, Vitest, esbuild

**Constraint:** All imports use .js extensions (ESM). Re-exports preserve backward compatibility until cleanup pass.

---

## Execution Order

1. Task 1: Split db.ts (foundation)
2. Task 2: Split server.ts into route modules
3. Task 3: Split auth.ts
4. Task 4: Split bot.ts into command groups
5. Task 5: Split index.html into JS modules with esbuild
6. Task 6: Cleanup re-exports + update CLAUDE.md

---

## Task 1: Split db.ts into schema + domain query modules

**Current:** src/data/db.ts (520 lines)

**Target structure:**
- src/data/db.ts (~30 lines: connection + pragma + re-exports)
- src/data/schema.ts (~80 lines: all CREATE TABLE + ALTER TABLE migrations)
- src/data/queries/core.ts (price_snapshots, trades, bot_events, portfolio_snapshots, runTransaction)
- src/data/queries/settings.ts (settings table)
- src/data/queries/assets.ts (discovered_assets + DiscoveredAssetRow)
- src/data/queries/candles.ts (candles + CandleRow)
- src/data/queries/rotations.ts (rotations + daily_pnl + interfaces)
- src/data/queries/watchlist.ts (watchlist + WatchlistRow)
- src/data/queries/passkeys.ts (passkeys + PasskeyRow)
- src/data/queries/grid.ts (grid_state + GridStateRow)

Steps:
- Create schema.ts with all DDL (imported for side effects)
- Create each queries/*.ts exporting its prepared statements + interface
- Reduce db.ts to connection + re-exports from all query modules
- Verify: npx tsc --noEmit and npx vitest run
- Commit: refactor: split db.ts into schema + domain query modules

---

## Task 2: Split server.ts into route modules

**Current:** src/web/server.ts (689 lines, 31 routes)

**Target structure:**
- src/web/server.ts (~80 lines: Express setup, middleware, mount routes)
- src/web/route-context.ts (RouteContext interface)
- src/web/routes/status.ts (GET /api/status, /networks, /wallet, /health)
- src/web/routes/settings.ts (GET+POST /api/settings, GET+PUT /api/theme)
- src/web/routes/trading.ts (POST /api/trade, /trade/enso, /control, /faucet, GET /quote)
- src/web/routes/assets.ts (GET /api/assets, POST enable/dismiss, PUT config + validateAssetParams)
- src/web/routes/candles.ts (GET /api/candles, /scores)
- src/web/routes/rotations.ts (GET /api/rotations)
- src/web/routes/risk.ts (GET /api/risk)
- src/web/routes/watchlist.ts (GET+POST+DELETE /api/watchlist)
- src/web/routes/performance.ts (GET /api/performance, /portfolio, /prices, /trades)
- src/web/routes/optimizer.ts (POST /api/optimizer/toggle)
- src/web/routes/wallet.ts (POST /api/wallet/reset, /network)

Pattern: each module exports registerXxxRoutes(router, ctx: RouteContext)

Steps:
- Create route-context.ts with RouteContext interface
- Create each route module, moving handlers verbatim
- Reduce server.ts to setup + middleware + mount calls
- Verify: npx tsc --noEmit and npx vitest run
- Commit: refactor: split server.ts into route modules

---

## Task 3: Split auth.ts into focused modules

**Current:** src/web/auth.ts (449 lines)

**Target structure:**
- src/web/auth.ts (~30 lines: re-exports)
- src/web/totp.ts (exists, unchanged)
- src/web/webauthn.ts (~120 lines: passkey register/login routes)
- src/web/middleware.ts (~80 lines: requireAuth, createAuthMiddleware, createSessionMiddleware, isIpAllowed, rate limiting)
- src/web/auth-routes.ts (~100 lines: TOTP login/setup/reset routes)

Steps:
- Create middleware.ts with all middleware functions
- Create webauthn.ts with passkey routes as registerWebAuthnRoutes()
- Create auth-routes.ts with TOTP routes as registerTotpRoutes()
- Update auth.ts to re-export everything
- Verify: npx tsc --noEmit and npx vitest run tests/auth-totp.test.ts tests/auth-passkey.test.ts
- Commit: refactor: split auth.ts into middleware, totp-routes, webauthn

---

## Task 4: Split bot.ts into command groups

**Current:** src/telegram/bot.ts (491 lines, 19 commands)

**Target structure:**
- src/telegram/bot.ts (~80 lines: bot setup, alert wiring, command registration)
- src/telegram/notifications.ts (~80 lines: sendFiltered, digest queue, quiet hours)
- src/telegram/commands/trading.ts (status, pause, resume, trades, buy, sell, network)
- src/telegram/commands/optimizer.ts (scores, rotations, watchlist, watch, unwatch, risk, killswitch, optimizer)
- src/telegram/commands/account.ts (resetwallet, pnl, notify, help)

Pattern: each module exports registerXxxCommands(bot, ctx)

Steps:
- Create notifications.ts with notification logic
- Create each commands/*.ts with relevant commands
- Reduce bot.ts to setup + registration calls
- Verify: npx tsc --noEmit and npx vitest run
- Commit: refactor: split bot.ts into command groups + notifications

---

## Task 5: Split index.html into TypeScript modules with esbuild

**Current:** src/web/public/index.html (2021 lines, all JS inline)

**Target structure:**
- src/web/public/index.html (~200 lines: HTML + CSS only, loads bundle.js)
- src/web/public/js/api.ts (~50 lines: all fetch wrappers)
- src/web/public/js/state.ts (~30 lines: shared state)
- src/web/public/js/charts.ts (~150 lines: Chart.js candle/portfolio/price)
- src/web/public/js/assets.ts (~200 lines: renderAssets, inline config, save)
- src/web/public/js/settings.ts (~100 lines: settings modal)
- src/web/public/js/scores.ts (~50 lines: opportunity scores)
- src/web/public/js/risk.ts (~50 lines: risk monitor)
- src/web/public/js/status.ts (~80 lines: header cards, holdings)
- src/web/public/js/theme.ts (~30 lines: theme toggle)
- src/web/public/js/main.ts (~50 lines: init, polling, event wiring)

Build: esbuild bundles main.ts into dist/web/public/bundle.js

Steps:
- Add esbuild to devDeps
- Create api.ts and state.ts (shared modules)
- Extract each UI concern into its own module
- Create main.ts importing all modules
- Strip JS from index.html, add script tag for bundle.js
- Add build:frontend script to package.json, update build pipeline and Dockerfile
- Verify: npx tsc --noEmit and npm run build:frontend
- Commit: refactor: split index.html into TypeScript modules with esbuild

---

## Task 6: Cleanup and documentation

Steps:
- Update all consumers to import directly from new module paths
- Remove re-exports from db.ts and auth.ts
- Run full regression: npx tsc --noEmit and npx vitest run
- Update CLAUDE.md architecture section with new file tree
- Commit: refactor: remove re-exports, direct imports everywhere
- Commit: docs: update CLAUDE.md with decomposed architecture
- Push to remote
