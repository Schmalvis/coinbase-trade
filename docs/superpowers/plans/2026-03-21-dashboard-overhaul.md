# Dashboard Overhaul & Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all known dashboard bugs (balance flickering, broken save, phantom trades, empty charts/panels) and add inline asset management via row-click.

**Architecture:** The dashboard reads from DB tables as authoritative source (`asset_snapshots`, `portfolio_snapshots`), with botState as fallback. Most bugs stem from field name mismatches between API responses and frontend expectations, plus the asset lookup using exact address match when registry assets use sentinel addresses. Each task is independent and can be verified in isolation.

**Tech Stack:** TypeScript ESM, Express, better-sqlite3, vanilla JS dashboard (Chart.js + chartjs-chart-financial), Vitest

---

## File Map

| File | Changes |
|------|---------|
| `src/data/db.ts` | Add `getAssetBySymbol` and `getLatestAssetSnapshot` prepared statements |
| `src/web/server.ts` | Fix asset lookup to use symbol fallback; fix /api/status balance fields; fix /api/risk response; add per-asset strategy to status |
| `src/web/public/index.html` | Inline asset config on row click; remove ASSETS nav button; fix Holdings dedup; fix risk monitor rendering; fix header strategy display |
| `src/trading/executor.ts` | Add trade amount sanity check (reject trades exceeding portfolio value) |
| `tests/dashboard-api.test.ts` | API endpoint tests for asset config, status, risk |
| `tests/executor-guards.test.ts` | Trade amount sanity check tests |

---

## Chunk 1: Backend Fixes

### Task 1: Fix asset config save — symbol fallback lookup

The PUT `/api/assets/:address` endpoint uses exact address match. Registry assets are seeded with sentinel addresses (e.g., `0xeeee...` for ETH) that the frontend may not know. The lookup must fall back to symbol match.

**Files:**
- Modify: `src/web/server.ts` (PUT /api/assets/:address handler)
- Modify: `src/data/db.ts` (add getAssetBySymbol)
- Test: `tests/dashboard-api.test.ts`

- [ ] **Step 1: Add getAssetBySymbol to db.ts**

In `discoveredAssetQueries`, add:
```typescript
getAssetBySymbol: db.prepare(
  `SELECT * FROM discovered_assets WHERE UPPER(symbol) = UPPER(?) AND network = ? LIMIT 1`
) as Statement<[string, string], DiscoveredAssetRow>,
```

- [ ] **Step 2: Fix PUT handler in server.ts**

Find the PUT `/api/assets/:address` handler. Change the asset lookup from exact address to a cascade:
1. Try exact address match
2. Try case-insensitive address match across all assets for that network
3. Try symbol match (frontend may send symbol instead of address)

- [ ] **Step 3: Write test verifying symbol fallback**

Create `tests/dashboard-api.test.ts` with test: when address lookup returns null but symbol lookup returns the asset, the save should succeed.

- [ ] **Step 4: Run tests**

Run: `npx tsc --noEmit && npx vitest run tests/dashboard-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/server.ts src/data/db.ts tests/dashboard-api.test.ts
git commit -m "fix: asset config save uses symbol fallback when address lookup fails"
```

---

### Task 2: Fix ETH balance flickering in /api/status

The `/api/status` endpoint reads `botState.lastBalance` which can be null/0 between poll cycles. It should read from the `asset_snapshots` DB table as authoritative source.

**Files:**
- Modify: `src/web/server.ts` (/api/status handler)
- Modify: `src/data/db.ts` (add getLatestAssetSnapshot)

- [ ] **Step 1: Add getLatestAssetSnapshot to db.ts**

```typescript
getLatestAssetSnapshot: db.prepare(
  `SELECT * FROM asset_snapshots WHERE symbol = ? AND network = ? ORDER BY timestamp DESC LIMIT 1`
),
```

- [ ] **Step 2: Fix /api/status to read from DB with botState fallback**

Change ethBalance/ethPrice reads to use DB snapshot as primary source, botState as fallback only.

- [ ] **Step 3: Verify no type errors**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add src/web/server.ts src/data/db.ts
git commit -m "fix: /api/status reads from DB snapshots to prevent balance flickering"
```

---

### Task 3: Add trade amount sanity check

Prevent the executor from executing trades with amounts that exceed the portfolio value. This catches phantom trades caused by MCP response parsing errors.

**Files:**
- Modify: `src/trading/executor.ts`
- Test: `tests/executor-guards.test.ts`

- [ ] **Step 1: Write failing test**

Test that a trade with value exceeding 2x portfolio is rejected with an error log and no swap execution.

- [ ] **Step 2: Implement sanity check in executor.ts**

In `execute()` and `executeForAsset()`, before calling `tools.swap()`, calculate the trade value in USD. If it exceeds 2x the current portfolio value, log an error and return without executing.

```typescript
const portfolioUsd = (botState.lastBalance ?? 0) * (botState.lastPrice ?? 0) + (botState.lastUsdcBalance ?? 0);
const tradeValueUsd = amount * (price || 0);
if (portfolioUsd > 0 && tradeValueUsd > portfolioUsd * 2) {
  logger.error(`Trade sanity check BLOCKED: value $${tradeValueUsd.toFixed(2)} > 2x portfolio $${portfolioUsd.toFixed(2)}`);
  return;
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/executor-guards.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/trading/executor.ts tests/executor-guards.test.ts
git commit -m "fix: add trade amount sanity check to prevent phantom trades"
```

---

## Chunk 2: Frontend Overhaul

### Task 4: Inline asset management — click row to configure

Remove the ASSETS nav button. When a user clicks an asset row in the ASSETS table, expand an inline config panel below that row with strategy selection, params, and save/disable buttons.

**Files:**
- Modify: `src/web/public/index.html`

- [ ] **Step 1: Remove ASSETS button from nav**

Find the nav bar. Remove the ASSETS button element entirely.

- [ ] **Step 2: Add data-symbol attribute and click handler to asset rows**

In `loadAssets()`, when creating each `<tr>`:
```javascript
tr.setAttribute('data-symbol', a.symbol);
tr.style.cursor = 'pointer';
tr.onclick = function() { toggleAssetConfig(a); };
```

- [ ] **Step 3: Create toggleAssetConfig function**

Build a function that:
1. Checks if a config panel already exists for this symbol — if so, remove it (toggle off)
2. Closes any other open panels
3. Creates a new `<tr>` with a single `<td colspan="8">` containing the config form
4. Inserts it after the clicked row

The config form contains:
- Strategy pills (THRESHOLD / SMA / GRID) — clicking sets active state
- Threshold params: Buy on drop %, Sell on rise %
- SMA params: Short window, Long window
- Grid params: Grid levels, Upper bound, Lower bound
- SAVE button (green) — calls PUT /api/assets/{symbol} with the form values
- DISABLE STRATEGY button (red) — calls DELETE or POST to dismiss the asset

Build all DOM elements using `document.createElement()` and `textContent` (not innerHTML) to avoid XSS.

- [ ] **Step 4: Implement saveAssetConfig to use symbol**

The save function should PUT to `/api/assets/{symbol}` instead of `/api/assets/{address}`, since the backend now supports symbol fallback.

- [ ] **Step 5: Remove old Asset Management modal code**

Delete `openAssetsModal()`, the modal HTML, and any associated event listeners.

- [ ] **Step 6: Style for dark/light themes**

Use existing CSS variables: `--bg-card-hover`, `--border`, `--text-primary`, `--green`, `--red`.

- [ ] **Step 7: For pending/new-token assets, show ENABLE/DISMISS inline**

When asset status is `pending`, the row click should show ENABLE and DISMISS buttons instead of the strategy config form.

- [ ] **Step 8: Commit**

```bash
git add src/web/public/index.html
git commit -m "feat: inline asset config on row click, remove ASSETS nav button"
```

---

### Task 5: Fix Holdings section deduplication

The Holdings section shows duplicate cards (e.g., CBBTC appearing twice). Deduplicate by symbol.

**Files:**
- Modify: `src/web/public/index.html`

- [ ] **Step 1: Find Holdings rendering code**

Search for 'HOLDINGS' in index.html.

- [ ] **Step 2: Add deduplication before rendering**

Before the Holdings card loop, filter by symbol (first occurrence wins). Also exclude USDC (already shown in header).

- [ ] **Step 3: Commit**

```bash
git add src/web/public/index.html
git commit -m "fix: deduplicate Holdings cards by symbol, exclude USDC"
```

---

### Task 6: Fix Risk Monitor rendering

The Risk Monitor panel shows `--` for all values. The frontend likely reads wrong field names from the /api/risk response.

**Files:**
- Modify: `src/web/public/index.html`
- Possibly modify: `src/web/server.ts`

- [ ] **Step 1: Check /api/risk response fields vs frontend expectations**

Read both the endpoint and the `loadRisk()` function. Note any field name mismatches.

- [ ] **Step 2: Fix field name mismatches**

Update the frontend to use the correct field names. Add fallback values for when data is genuinely empty (show `$0.00` instead of `--` for P&L, `0` for rotation count, configured floor value for portfolio floor).

- [ ] **Step 3: Commit**

```bash
git add src/web/public/index.html src/web/server.ts
git commit -m "fix: risk monitor renders correctly with proper field mapping and defaults"
```

---

### Task 7: Fix header strategy display inconsistency

The header shows global `STRATEGY` config (e.g., "Strategy: threshold") but the per-asset strategy is authoritative.

**Files:**
- Modify: `src/web/server.ts`
- Modify: `src/web/public/index.html`

- [ ] **Step 1: Add per-asset ETH strategy to /api/status response**

Look up ETH's strategy from discovered_assets and return it in the status response.

- [ ] **Step 2: Update header to show per-asset strategy**

Read the strategy from the status response instead of the global config field.

- [ ] **Step 3: Commit**

```bash
git add src/web/server.ts src/web/public/index.html
git commit -m "fix: header shows per-asset ETH strategy, not global default"
```

---

## Chunk 3: Verification

### Task 8: End-to-end verification

- [ ] **Step 1: TypeScript check**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`
Expected: all new tests pass, no regressions in existing tests

- [ ] **Step 3: Manual verification checklist**

After deploying, verify in browser:
- Portfolio balance shows correctly and does not flicker to $0
- ETH balance in header matches basescan
- Clicking asset row expands inline config panel
- Changing strategy and clicking SAVE persists (refresh to verify)
- DISABLE STRATEGY on an asset removes it from active loops
- Holdings section shows no duplicates
- Risk monitor shows real values (Daily P&L, rotation count, floor)
- Header shows per-asset strategy for ETH, not global default
- Candlestick chart renders candles for ETH
- No ASSETS button in nav bar

- [ ] **Step 4: Update CLAUDE.md**

Add notes about:
- Inline asset management (click row to configure)
- Trade sanity check (2x portfolio guard)
- DB-authoritative display pattern

- [ ] **Step 5: Final commit and push**

```bash
git add -A
git commit -m "docs: update CLAUDE.md with dashboard overhaul changes"
git push origin main
```
