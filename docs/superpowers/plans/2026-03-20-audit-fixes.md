# Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 18 findings from the 2026-03-19 security audit, add comprehensive UI/API tests.

**Architecture:** Fixes are grouped into 6 tasks by file/concern. Each task is independently testable and committable. Auth middleware is added first (C1), then executor safety (C2/C3), then optimizer/strategy correctness, then UI tests.

**Tech Stack:** TypeScript, Express, Vitest, better-sqlite3, Chart.js

**Audit report:** `AUDIT-2026-03-19.md`

---

## File Map

| File | Changes |
|------|---------|
| `src/web/auth.ts` | **CREATE** — Bearer token auth middleware |
| `src/web/server.ts` | Add auth middleware, fix XSS (H3), add Enso allowlist (C2) |
| `src/trading/executor.ts` | Add RiskGuard + isPaused to executeForAsset (C3), record trades (M2), error handling (M3), fix rotation leg 2 (H1) |
| `src/trading/engine.ts` | Add .catch to asset loop (M3), wire candle data to grid (L1) |
| `src/trading/optimizer.ts` | Fix non-ETH price lookup (H2), fix estimatedGainPct units (M4) |
| `src/strategy/grid.ts` | Guard division-by-zero (H4) |
| `src/strategy/threshold.ts` | Add consecutive buy limit (M1) |
| `src/mcp/client.ts` | Add timeout to callTool (M5) |
| `src/core/runtime-config.ts` | Add DRY_RUN to READ_ONLY_KEYS (M6) |
| `src/data/db.ts` | Add transaction helpers (H5) |
| `src/portfolio/tracker.ts` | Fix legacy portfolio_usd:0 (L4) |
| `tests/audit-fixes.test.ts` | **CREATE** — Tests for all critical/high fixes |
| `tests/ui-api.test.ts` | **CREATE** — Comprehensive UI/API endpoint tests |

---

## Chunk 1: Security (C1, C2, M6)

### Task 1: API Authentication Middleware

**Files:**
- Create: `src/web/auth.ts`
- Modify: `src/web/server.ts`
- Modify: `src/core/runtime-config.ts`
- Modify: `src/config.ts`
- Modify: `src/web/public/index.html`
- Test: `tests/audit-fixes.test.ts`

- [ ] **Step 1: Create auth middleware**

Create `src/web/auth.ts` with a `createAuthMiddleware` function:
- Takes a `getSecret: () => string | undefined` callback
- Returns Express middleware
- GET requests always pass through (read-only dashboard)
- If no secret configured, all requests pass (backwards-compatible)
- POST/PUT/DELETE require `Authorization: Bearer <secret>` header
- Logs unauthorized attempts with IP

- [ ] **Step 2: Add DASHBOARD_SECRET to config**

In `src/config.ts`, add `DASHBOARD_SECRET: z.string().optional().default('')` to the Zod schema.

In `src/core/runtime-config.ts`, add `'DASHBOARD_SECRET'` and `'DRY_RUN'` to the `READ_ONLY_KEYS` set. Auth token and dry-run must not be changeable via the API they protect (M6).

- [ ] **Step 3: Wire auth into server.ts**

Import `createAuthMiddleware` and apply it with `app.use()` after `express.json()`.

- [ ] **Step 4: Add Enso allowlist validation (C2)**

In the `POST /api/trade/enso` handler, build an allowlist from registry + active discovered asset addresses. Reject trades where neither `tokenIn` nor `tokenOut` is in the allowlist.

- [ ] **Step 5: Update dashboard to send auth header**

Add `getAuthHeaders()` helper that reads secret from `localStorage.getItem('cb-dashboard-secret')`. Update all POST/PUT/DELETE fetch calls to use this. Add a "Dashboard Secret" input field in Settings modal that saves to localStorage.

- [ ] **Step 6: Write tests**

Tests for: GET without auth works, POST without auth rejected when secret set, POST with correct token accepted, POST with wrong token rejected, POST allowed when no secret.

- [ ] **Step 7: Run tests, commit**

```bash
npx vitest run tests/audit-fixes.test.ts
git add src/web/auth.ts src/web/server.ts src/core/runtime-config.ts src/config.ts src/web/public/index.html tests/audit-fixes.test.ts
git commit -m "security: add bearer-token auth to mutating API endpoints (C1, C2, M6)"
```

---

## Chunk 2: Executor Safety (C3, H1, M2, M3)

### Task 2: Fix executeForAsset — RiskGuard, Trade Recording, Error Handling

**Files:**
- Modify: `src/trading/executor.ts`
- Modify: `src/trading/engine.ts`
- Test: `tests/audit-fixes.test.ts`

- [ ] **Step 1: Add isPaused check and RiskGuard to executeForAsset (C3)**

Add at the start of `executeForAsset`:
- `if (botState.isPaused)` check with log and return
- Portfolio floor check: read latest `portfolio_snapshots` row, compare against `PORTFOLIO_FLOOR_USD`
- Position limit check: for buy signals, compute current position weight and compare against `MAX_POSITION_PCT`

- [ ] **Step 2: Add try/catch to swap in executeForAsset (M3)**

Wrap `this.tools.swap()` call in try/catch, log error and return on failure.

- [ ] **Step 3: Record trades in executeForAsset (M2)**

After successful swap (or dry run), call `this.recordTrade()` with `triggeredBy: 'asset-loop:<symbol>'`.

- [ ] **Step 4: Add .catch to engine asset loop (M3)**

In `src/trading/engine.ts`, change the setInterval callback from `void this.tickAsset(...)` to `.catch(err => logger.error(...))`.

- [ ] **Step 5: Fix rotation leg 2 stale balance (H1)**

In `executeRotation`, after leg 1 succeeds, fetch fresh USDC balance from MCP (via `tools.getErc20Balance` for USDC contract address) instead of reading `botState.lastUsdcBalance`.

- [ ] **Step 6: Write tests, commit**

Tests for: paused check, portfolio floor block, position limit block, trade recording, swap error handling.

```bash
npx vitest run tests/audit-fixes.test.ts
git commit -m "security: add RiskGuard to executeForAsset, record trades, fix rotation (C3, H1, M2, M3)"
```

---

## Chunk 3: Optimizer & Strategy Correctness (H2, H4, M1, M4, L1)

### Task 3: Fix Optimizer Pricing and Grid Safety

**Files:**
- Modify: `src/trading/optimizer.ts`
- Modify: `src/strategy/grid.ts`
- Modify: `src/strategy/threshold.ts`
- Modify: `src/trading/engine.ts`
- Test: `tests/audit-fixes.test.ts`

- [ ] **Step 1: Fix non-ETH/USDC asset pricing in optimizer (H2)**

Replace the hardcoded price lookup in optimizer `tick()`:
- USDC: price = 1
- ETH: price = botState.lastPrice
- All others: read latest `asset_snapshots` row for that symbol

Import `queries` from db.ts if not already imported.

- [ ] **Step 2: Fix estimatedGainPct units (M4)**

Score delta is 0-200 range, not a percentage. Map to estimated gain: `estimatedGainPct = rawScoreDelta * 0.05` (so 40-point delta = 2% estimated gain, matching the MIN_ROTATION_GAIN_PCT default).

- [ ] **Step 3: Guard grid division-by-zero (H4)**

In `grid.ts`, add at start of `initializeLevels`:
```typescript
if (this.upperBound === this.lowerBound || this.gridLevelCount < 2) {
  logger.warn(`Grid bounds invalid for ${this.symbol}`);
  return;
}
```

Also guard in `evaluate` before calling `initializeLevels`:
```typescript
if (this.upperBound == null || this.lowerBound == null || this.upperBound <= this.lowerBound) {
  return { signal: 'hold', reason: 'Grid bounds invalid' };
}
```

- [ ] **Step 4: Add consecutive buy limit to ThresholdStrategy (M1)**

Add `consecutiveBuys` counter. Increment on buy signal, reset on sell. Return hold when limit (3) reached.

- [ ] **Step 5: Wire candle data to grid strategy (L1)**

In `engine.ts`, replace `getCandleHigh24h: () => null` with actual candle queries using `candleQueries.getCandles`. Import `candleQueries` from db.ts.

- [ ] **Step 6: Write tests, commit**

```bash
npx vitest run tests/audit-fixes.test.ts
git commit -m "fix: optimizer pricing, grid safety, threshold buy limit (H2, H4, M1, M4, L1)"
```

---

## Chunk 4: Infrastructure Fixes (H3, H5, M5, L2, L4)

### Task 4: XSS, Transactions, Timeouts, Minor Fixes

**Files:**
- Modify: `src/web/public/index.html`
- Modify: `src/mcp/client.ts`
- Modify: `src/data/db.ts`
- Modify: `src/portfolio/tracker.ts`

- [ ] **Step 1: Fix XSS in dashboard (H3)**

Find all places where error messages are inserted using unsafe DOM methods. Replace with `textContent` assignments. The `alert()` calls are safe (alert escapes HTML).

- [ ] **Step 2: Add transaction helper to db.ts (H5)**

Export `const runTransaction = db.transaction((fn: () => void) => fn());`. Use selectively in executor for grid state + trade recording, and in optimizer for rotation + daily PnL.

- [ ] **Step 3: Add timeout to MCP callTool (M5)**

Wrap `this.client.callTool()` in `Promise.race` with a 30-second timeout. On timeout, record failure and throw.

- [ ] **Step 4: Fix legacy portfolio_usd:0 (L4)**

In tracker.ts, the ETH-specific `insertSnapshot` writes `portfolio_usd: 0`. Pass the running `portfolioUsd` total or move the call after the asset loop.

- [ ] **Step 5: Commit**

```bash
npx vitest run tests/audit-fixes.test.ts
git commit -m "fix: XSS, DB transactions, MCP timeout, minor fixes (H3, H5, M5, L2, L4)"
```

---

## Chunk 5: Comprehensive UI/API Tests

### Task 5: UI and API Endpoint Test Suite

**Files:**
- Create: `tests/ui-api.test.ts`

- [ ] **Step 1: Write API endpoint tests**

Test every endpoint returns correct shape and handles errors:
- GET /api/status: returns portfolioUsd, ethBalance, all required fields
- GET /api/assets: deduplicated, includes strategyConfig with grid fields, correct prices
- PUT /api/assets/:address/config: saves strategy, case-insensitive lookup, validates params
- POST /api/assets/:address/enable: enables and starts loop
- POST /api/assets/:address/dismiss: dismisses and stops loop
- GET /api/risk: returns snake_case fields with computed values
- GET /api/scores: empty when optimizer disabled, populated when ticked
- GET /api/performance: P&L metrics with correct shape
- POST /api/settings: rejects READ_ONLY_KEYS, validates ranges
- POST /api/trade: requires auth, respects DRY_RUN
- POST /api/trade/enso: rejects non-mainnet, rejects non-allowlisted tokens
- GET/PUT /api/theme: get and set theme

- [ ] **Step 2: Write dashboard data contract tests**

Verify the shape of every API response matches what index.html JS code expects:
- status response has all fields the dashboard reads
- assets response includes strategyConfig for all assets
- risk response has snake_case fields matching dashboard JS

- [ ] **Step 3: Run all tests, commit**

```bash
npx vitest run
git commit -m "test: comprehensive UI/API endpoint test suite"
```

---

## Chunk 6: Final Verification

### Task 6: TypeScript Check, Full Test Run, Documentation

- [ ] **Step 1: TypeScript check**
```bash
npx tsc --noEmit
```

- [ ] **Step 2: Run full test suite**
```bash
npx vitest run
```

- [ ] **Step 3: Update CLAUDE.md**

Add `DASHBOARD_SECRET` to .env Keys table. Update any stale notes.

- [ ] **Step 4: Final commit and push**

```bash
git push origin main
```
