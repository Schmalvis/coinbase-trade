# Comprehensive Trading Dashboard — Design Spec
**Date:** 2026-03-13
**Project:** coinbase-trade
**Status:** Approved

---

## Overview

Extend the trading dashboard to support any ERC20 token currently held in the wallet. Alchemy scans the wallet at each poll cycle and surfaces newly discovered tokens inline. Users opt each token into autonomous strategy individually. The strategy engine runs an independent threshold/SMA loop per active asset. All assets are displayed in a dynamic table that replaces the current hardcoded ETH/USDC status grid. Dark and light mode are both supported via existing CSS variables.

**Autonomous trading is preserved** — the bot continues to operate without user intervention. The UI adds visibility and control, not a requirement to act.

---

## Architecture

```
Alchemy API (external)
       ↓
src/services/alchemy.ts          ← NEW: token balance + metadata fetcher
       ↓
src/portfolio/tracker.ts         ← MODIFIED: calls Alchemy each poll; inserts new discoveries
       ↓
src/data/db.ts                   ← MODIFIED: discovered_assets table + queries
       ↓
src/trading/engine.ts            ← MODIFIED: strategy map (symbol → interval); hot-add on enable
       ↓
src/web/server.ts                ← MODIFIED: asset management endpoints; portfolio sum fix
       ↓
src/web/public/index.html        ← MODIFIED: dynamic table, ASSETS badge, modal, inline actions
```

### Alchemy Service (`src/services/alchemy.ts`)

Thin HTTP wrapper — no MCP involved. Reads `ALCHEMY_API_KEY` from `.env`. Network mapping: `base-mainnet` → Base mainnet Alchemy endpoint, `base-sepolia` → Base Sepolia endpoint.

Two methods:
- `getTokenBalances(walletAddress, network)` → `AlchemyTokenBalance[]` — calls `alchemy_getTokenBalances`
- `getTokenMetadata(contractAddress, network)` → `{ symbol, name, decimals }` — calls `alchemy_getTokenMetadata`

Both are plain `fetch` calls to the Alchemy REST API. No caching — called fresh each poll cycle. If Alchemy is unavailable, the tracker logs a warning and skips discovery for that cycle (existing known assets still poll normally).

### Portfolio Tracker

At each poll cycle, after pricing all known assets:
1. Call `alchemyService.getTokenBalances(walletAddress, network)`
2. For each returned token address, check against static registry + `discovered_assets` table
3. If unknown: call `getTokenMetadata`, insert as `status = 'pending'` (idempotent — `INSERT OR IGNORE`)
4. Increment `botState.pendingTokenCount` if any pending rows exist
5. For ALL assets (static + discovered with `status = 'active'` or `'pending'`): price via DefiLlama `base:0xADDRESS`, write to `asset_snapshots`

USDC pricing note: DefiLlama returns `~1.00` for USDC via `base:0x833589...` — no special-casing needed.

### Trading Engine

Currently: one `setInterval` loop for ETH↔USDC using the global strategy from `RuntimeConfig`.

Becomes: a `Map<string, NodeJS.Timeout>` of `symbol → interval handle`.

- On startup: start loops for ETH/USDC (as today) + all `status = 'active'` discovered assets
- On `POST /api/assets/:address/enable`: engine receives event, starts a new loop for that asset live
- On `POST /api/assets/:address/dismiss` or strategy disabled in modal: engine stops and removes that asset's loop
- Each discovered asset loop uses its own per-asset strategy params from `discovered_assets` (not `RuntimeConfig`)
- Static assets (ETH, USDC, CBBTC, CBETH) continue using `RuntimeConfig` as before

Each loop trades `asset ↔ USDC` (buy: spend USDC to acquire asset on drop; sell: sell asset for USDC on rise).

---

## Data Model

### New table: `discovered_assets`

```sql
CREATE TABLE IF NOT EXISTS discovered_assets (
  address       TEXT    NOT NULL,
  network       TEXT    NOT NULL,
  symbol        TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  decimals      INTEGER NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending',   -- 'pending' | 'active' | 'dismissed'
  strategy_type TEXT    NOT NULL DEFAULT 'threshold', -- 'threshold' | 'sma'
  quote_asset   TEXT    NOT NULL DEFAULT 'USDC',
  drop_pct      REAL    NOT NULL DEFAULT 3.0,
  rise_pct      REAL    NOT NULL DEFAULT 4.0,
  sma_short     INTEGER NOT NULL DEFAULT 5,
  sma_long      INTEGER NOT NULL DEFAULT 20,
  discovered_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (address, network)
)
```

**Design decisions:**
- Primary key is `(address, network)` — same token tracked independently per network
- Strategy params stored per asset; changing global RuntimeConfig does not retroactively affect saved per-asset config
- `quote_asset` is always USDC for now — every discovered asset trades X↔USDC
- Static registry assets (ETH, USDC, CBBTC, CBETH) are never inserted here — they use RuntimeConfig
- `asset_snapshots` table is unchanged — discovered assets write rows there by symbol, same as static assets

### New queries added to `src/data/db.ts`

- `insertDiscoveredAsset` — `INSERT OR IGNORE` (idempotent on re-discovery)
- `getPendingAssets(network)` — for badge count and inline table rows
- `getActiveDiscoveredAssets(network)` — for engine startup
- `updateAssetStatus(address, network, status)` — enable / dismiss
- `updateAssetStrategyConfig(address, network, params)` — save config from modal
- `getDiscoveredAsset(address, network)` — single asset lookup

---

## API Endpoints

### Updated endpoints

| Method | Path | Change |
|--------|------|--------|
| `GET` | `/api/assets` | Returns static + discovered assets; adds `status`, `name`, `change24h`, `source`, `strategyConfig` fields |
| `GET` | `/api/status` | `portfolioUsd` now sums ALL held assets (not just ETH×price + USDC); adds `pendingTokenCount` |

### New endpoints

| Method | Path | Body | Response |
|--------|------|------|----------|
| `POST` | `/api/assets/:address/enable` | `{ strategyType, dropPct, risePct, smaShort, smaLong }` | `{ ok: true }` or `{ error }` |
| `POST` | `/api/assets/:address/dismiss` | — | `{ ok: true }` |
| `PUT` | `/api/assets/:address/config` | `{ strategyType, dropPct, risePct, smaShort, smaLong }` | `{ ok: true }` or `{ error }` |

### `/api/assets` response shape per asset

```json
{
  "symbol": "AERO",
  "name": "Aerodrome Finance",
  "address": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
  "decimals": 18,
  "balance": 280.0,
  "price": 0.84,
  "change24h": 5.4,
  "isNative": false,
  "tradeMethod": "agentkit",
  "priceSource": "defillama",
  "status": "pending",
  "source": "discovered",
  "strategyConfig": {
    "type": "threshold",
    "dropPct": 3.0,
    "risePct": 4.0,
    "smaShort": 5,
    "smaLong": 20
  }
}
```

Static registry assets return `"source": "registry"` and `"status": "active"` always. `change24h` is computed server-side: fetch the `asset_snapshots` row closest to 24 hours ago and compare its `price_usd` to the most recent row.

---

## Dashboard Changes (`src/web/public/index.html`)

### Header

Add `ASSETS` button alongside existing `SETTINGS` button. When `pendingTokenCount > 0`, render a red badge with the count. Clicking opens the Asset Management modal.

### Status section — replace hardcoded grid with dynamic table

**Remove:** hardcoded ETH Price / ETH Balance / USDC Balance / Portfolio cards and the `loadStatus()` code that reads `s.lastPrice`, `s.ethBalance`, `s.usdcBalance` directly.

**Add:** 3-card summary row (Portfolio total + 24h change, Bot status + active strategy count, Last trade) followed by a dynamic asset table.

Asset table columns: `ASSET | PRICE | BALANCE | VALUE | 24H | STRATEGY | (actions)`

- Rows rendered from `assetList` (populated by `loadAssets()` via `/api/assets`)
- `status = 'active'` rows: strategy column shows `● threshold` or `● sma` in green; no action buttons
- `status = 'pending'` rows: amber highlight, strategy column shows `⚠ new token`, action column shows inline `ENABLE` + `DISMISS` buttons
- `status = 'dismissed'` rows: not shown in the table (excluded from `/api/assets` response)
- Portfolio value in summary card correctly sums all assets: `assetList.reduce((sum, a) => sum + (a.balance ?? 0) * (a.price ?? 0), 0)`

### Price chart

Unchanged in behaviour — asset selector pills already work for any symbol. Discovered assets automatically gain a pill once they appear in `assetList`. Chart loads from `/api/prices?asset=SYMBOL&limit=288` which reads `asset_snapshots`.

### Asset Management modal

Triggered by the `ASSETS` header button. Full-screen overlay with a scrollable list of all assets.

**List item states:**

| State | Appearance | Controls |
|-------|-----------|----------|
| Active (expanded) | Amber border, ▲ chevron | Strategy type pills, param inputs, SAVE button, "Disable strategy" link |
| Active (collapsed) | Normal border, ▼ chevron | Click to expand |
| Pending | Amber dashed border | ENABLE + DISMISS buttons; no expand |
| Dismissed | Not shown | — |

**Strategy config fields (shown when expanded):**
- Strategy type: `THRESHOLD` / `SMA` pill selector
- When THRESHOLD: Buy on drop % + Sell on rise % number inputs
- When SMA: Short window + Long window integer inputs (long must be > short)
- SAVE → `PUT /api/assets/:address/config` → updates DB + sends event to engine

**Enable flow (from pending row):**
- Click ENABLE → inline form expands with strategy defaults pre-filled
- User adjusts params if desired → confirm → `POST /api/assets/:address/enable` → engine starts loop live → row moves to active state, badge decrements

**Dismiss flow:**
- Click DISMISS → `POST /api/assets/:address/dismiss` → row removed from table and modal; badge decrements

### Trade modal

The existing Trade modal already dynamically populates pair buttons from `assetList` (implemented in the previous phase). Discovered assets with `tradeMethod = 'agentkit'` automatically appear as trade pair options once added to `assetList`.

### Theme

All new elements (asset table, badge, modal, inline buttons) use the existing CSS variables (`--bg`, `--surface`, `--border`, `--text`, `--accent`, `--green`, `--red`). Dark and light mode work automatically via the existing ☾/☀ toggle — no extra theming work required.

---

## Config Changes

### `.env` / `src/config.ts`

Add:
```
ALCHEMY_API_KEY=your_key_here
```

`src/config.ts` adds `ALCHEMY_API_KEY: z.string()` to the Zod schema. This is a startup-required field — the bot will fail to start if missing, with a clear Zod validation error.

### `stack.env` / `CLAUDE.md`

Both updated to document the new required key.

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Alchemy unavailable at poll time | Log warning, skip discovery, known assets still price normally |
| Alchemy returns unknown token with no metadata | Skip insertion, log debug |
| DefiLlama returns no price for discovered token | Store `price_usd = 0`, show `—` in table; no strategy signals fired |
| `POST /api/assets/:address/enable` with invalid params | 400 `{ error, field }` |
| Engine fails to start loop for new asset | Log error, asset stays `pending` in DB, badge stays |
| Alchemy API key missing at startup | Zod validation throws, bot exits with clear error message |

---

## Files to Create / Modify

### New Files
- `src/services/alchemy.ts` — Alchemy HTTP client
- `tests/alchemy.test.ts` — unit tests with mocked fetch

### Modified Files
- `src/config.ts` — add `ALCHEMY_API_KEY`
- `src/data/db.ts` — add `discovered_assets` table and queries
- `src/core/state.ts` — add `pendingTokenCount` field + setter
- `src/portfolio/tracker.ts` — call Alchemy each cycle; insert discovered assets; price all active+pending tokens
- `src/trading/engine.ts` — strategy map; hot-add/remove loops; load active discovered assets on startup
- `src/web/server.ts` — new asset management endpoints; fix portfolio sum; `change24h` computation
- `src/web/public/index.html` — dynamic table; ASSETS badge; Asset Management modal; inline Enable/Dismiss
- `stack.env` — document `ALCHEMY_API_KEY`
- `CLAUDE.md` — update architecture + .env keys

### Unchanged Files
- `src/assets/registry.ts` — static registry untouched
- `src/mcp/tools.ts` — no change
- `src/core/runtime-config.ts` — no change
- `src/core/logger.ts` — no change

---

## Out of Scope (This Phase)

- Per-asset price alerts / notifications
- Portfolio rebalancing (target % allocations)
- Non-USDC quote assets (e.g. ETH as the quote)
- Token transfer UI
- Enso routing for discovered tokens (all use AgentKit swap)
- Historical performance % beyond 24h
