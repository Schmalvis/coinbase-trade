# Unified Per-Asset Strategy Control — Design Spec

**Date:** 2026-03-19
**Status:** Approved

## Goal

Give all tradeable assets (ETH, CBBTC, CBETH, and discovered tokens) identical per-asset strategy controls. Remove the separate "main ETH loop" that uses a global strategy setting. Every asset runs through the same `startAssetLoop` path with its own strategy type, parameters, and grid config.

## Architecture

Registry assets (ETH, CBBTC, CBETH) are seeded into the `discovered_assets` table on startup via `INSERT OR IGNORE`. This makes them indistinguishable from discovered tokens in terms of strategy config. USDC is excluded — it's the base currency and has no meaningful strategy.

---

## 1. Boot-Time Seeding (`src/index.ts`)

After DB initialization but before TradingEngine starts, seed registry assets:

```typescript
import { ASSETS } from './assets/registry.js';

for (const asset of ASSETS) {
  if (asset.symbol === 'USDC') continue; // USDC is base currency, no strategy
  discoveredAssetQueries.upsertDiscoveredAsset.run({
    address: asset.address ?? `native:${asset.symbol}`,
    network: botState.activeNetwork,
    symbol: asset.symbol,
    name: asset.name ?? asset.symbol,
    decimals: asset.decimals ?? 18,
  });
}
```

- `INSERT OR IGNORE` ensures existing config is never overwritten
- Native assets (ETH) use a synthetic address like `native:ETH` since they have no contract address
- The seeded rows get default strategy from the global `STRATEGY` config (threshold/sma/grid)
- Runs on every boot but is idempotent

## 2. TradingEngine Changes (`src/trading/engine.ts`)

### Remove the global strategy loop

Delete these members and methods:
- `private strategy!: Strategy` — the global strategy instance
- `private intervalId` — the global loop timer
- `buildStrategy()` — constructs global strategy from config
- `start()` — starts the global interval
- `restart()` — restarts on config change
- `tick()` — the global ETH-only tick

### All assets use `startAssetLoop`

The constructor already loads active discovered assets and calls `startAssetLoop` for each. After seeding (above), registry assets appear in this query too. No change needed to the constructor loop — it already handles everything.

### Simplify config subscription

The `STRATEGY_KEYS` subscription currently calls `restart()` (the global loop). Change it to reload all asset loops instead:

```typescript
runtimeConfig.subscribeMany([...STRATEGY_KEYS], () => {
  // Reload all active asset loops with fresh config
  const activeAssets = discoveredAssetQueries.getActiveAssets.all(botState.activeNetwork);
  for (const row of activeAssets) {
    this.reloadAssetConfig(row.address, row.symbol, /* params from row */);
  }
});
```

### Keep `manualTrade`

`manualTrade(action)` currently calls `this.executor.execute(action, reason)` which operates on the main ETH pair. This should be updated to accept a symbol parameter: `manualTrade(action, symbol?)` — defaulting to ETH for backward compatibility with Telegram `/buy` and `/sell`.

## 3. Dashboard Changes (`src/web/public/index.html`)

### Asset Management modal shows all assets

The modal already renders all entries from the `discovered_assets` table. After seeding, ETH/CBBTC/CBETH appear automatically with the same strategy controls (threshold/sma/grid, drop_pct, rise_pct, grid config).

### USDC excluded from strategy controls

USDC is not seeded into `discovered_assets`, so it won't appear in the Asset Management modal. It continues to show in the Holdings section with balance info only.

### Global Strategy setting repurposed

The global `STRATEGY` dropdown in the Settings modal becomes "Default Strategy for New Assets" — it sets the default for newly discovered/seeded assets but doesn't drive any loop directly. Existing per-asset configs are unaffected.

## 4. What Stays the Same

- `PortfolioTracker` — still polls all registry assets for balances/prices (unchanged)
- `PortfolioOptimizer` — still scores and rotates across all assets (unchanged)
- `TradeExecutor` — `executeForAsset` already handles per-asset trades (unchanged)
- `RiskGuard` — all checks still apply (unchanged)
- Telegram commands — `/buy` and `/sell` default to ETH (backward compatible)
- Grid exclusion from rotation — still works via `discovered_assets.strategy = 'grid'` check

## 5. Migration

- **First deploy:** ETH, CBBTC, CBETH get inserted into `discovered_assets` with default strategy and params
- **Existing discovered token configs:** Untouched (INSERT OR IGNORE)
- **Global STRATEGY env var:** Still works as initial default; per-asset DB overrides take precedence
- **No data loss:** The old global loop simply stops running; per-asset loops take over

## 6. What This Does NOT Include

- No changes to USDC handling (it remains base currency with no strategy)
- No changes to the optimizer scoring or rotation logic
- No new Telegram commands
- No new API endpoints (existing asset config endpoints already work)
- No changes to the registry itself (`src/assets/registry.ts` is unchanged)
