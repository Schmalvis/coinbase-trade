# Unified Per-Asset Strategy Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all tradeable assets (ETH, CBBTC, CBETH, discovered tokens) use the same per-asset strategy controls, removing the separate global ETH strategy loop.

**Architecture:** Registry assets are seeded into `discovered_assets` on boot with `status = 'active'`. The global strategy loop in TradingEngine is removed; all assets use `startAssetLoop`. The dashboard shows all assets with identical config controls.

**Tech Stack:** TypeScript ESM, better-sqlite3, Vitest, Express

**Spec:** `docs/superpowers/specs/2026-03-19-unified-asset-strategy-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/data/db.ts` | Modify | Add `seedRegistryAsset` prepared statement |
| `src/trading/engine.ts` | Modify | Remove global loop, add `startAllAssetLoops()`, widen constructor |
| `src/index.ts` | Modify | Seed registry assets on boot, replace `engine.start()` |
| `src/web/public/index.html` | Modify | Repurpose global strategy setting label |
| `tests/engine-unified.test.ts` | Create | Test unified asset loop behavior |
| `CLAUDE.md` | Modify | Document Phase 5.5 changes |

---

## Chunk 1: Database Seeding

### Task 1: Add `seedRegistryAsset` prepared statement

**Files:**
- Modify: `src/data/db.ts`

- [ ] **Step 1: Add the prepared statement**

In `src/data/db.ts`, add to `discoveredAssetQueries` (after the existing `upsertDiscoveredAsset`):

```typescript
  seedRegistryAsset: db.prepare(`
    INSERT OR IGNORE INTO discovered_assets (address, network, symbol, name, decimals, status)
    VALUES (@address, @network, @symbol, @name, @decimals, 'active')
  `) as Statement<{ address: string; network: string; symbol: string; name: string; decimals: number }>,
```

This differs from `upsertDiscoveredAsset` which defaults `status` to `'pending'`. Registry assets are always active — they don't need user approval.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```
git add src/data/db.ts
git commit -m "feat: add seedRegistryAsset prepared statement for registry asset seeding"
```

---

## Chunk 2: TradingEngine Refactor

### Task 2: Remove global strategy loop and add `startAllAssetLoops()`

**Files:**
- Modify: `src/trading/engine.ts`
- Create: `tests/engine-unified.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/engine-unified.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/data/db.js', () => ({
  queries: { recentSnapshots: { all: () => [] }, recentAssetSnapshots: { all: () => [] } },
  discoveredAssetQueries: {
    getActiveAssets: { all: () => [
      {
        address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        symbol: 'ETH', strategy: 'threshold',
        drop_pct: 2, rise_pct: 3, sma_short: 5, sma_long: 20,
        grid_levels: 10, grid_upper_bound: null, grid_lower_bound: null,
      },
      {
        address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
        symbol: 'CBBTC', strategy: 'sma',
        drop_pct: 2, rise_pct: 3, sma_short: 5, sma_long: 20,
        grid_levels: 10, grid_upper_bound: null, grid_lower_bound: null,
      },
    ]},
  },
  gridStateQueries: {
    upsertGridLevel: { run: vi.fn() },
    getGridLevels: { all: () => [] },
    clearGridLevels: { run: vi.fn() },
  },
}));
vi.mock('../src/core/state.js', () => ({
  botState: { isPaused: false, activeNetwork: 'base-mainnet', status: 'running' },
}));
vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockExecutor = { execute: vi.fn(), executeForAsset: vi.fn() };
const mockConfig = {
  get: vi.fn((k: string) => {
    const d: Record<string, unknown> = {
      STRATEGY: 'threshold', TRADE_INTERVAL_SECONDS: 60,
      SMA_SHORT_WINDOW: 5, SMA_LONG_WINDOW: 20,
      OPTIMIZER_INTERVAL_SECONDS: 300, DEFAULT_FEE_ESTIMATE_PCT: 1.0,
      PRICE_DROP_THRESHOLD_PCT: 2, PRICE_RISE_TARGET_PCT: 3,
    };
    return d[k];
  }),
  subscribe: vi.fn(), subscribeMany: vi.fn(),
};

import { TradingEngine } from '../src/trading/engine.js';

describe('TradingEngine unified asset loops', () => {
  it('startAllAssetLoops starts loops for all active assets from DB', () => {
    const engine = new TradingEngine(mockExecutor as any, mockConfig as any);
    engine.startAllAssetLoops();
    // Should have started loops for ETH and CBBTC (from mock getActiveAssets)
    expect(engine.activeAssetCount).toBe(2);
    // Cleanup
    engine.stopAllAssetLoops();
    expect(engine.activeAssetCount).toBe(0);
  });

  it('startAllAssetLoops calls startAssetLoop exactly once per active asset', () => {
    const engine = new TradingEngine(mockExecutor as any, mockConfig as any);
    const spy = vi.spyOn(engine, 'startAssetLoop');
    engine.startAllAssetLoops();
    expect(spy).toHaveBeenCalledTimes(2); // ETH + CBBTC from mock
    expect(spy).toHaveBeenCalledWith(
      '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'ETH', expect.any(Object),
    );
    engine.stopAllAssetLoops();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-unified.test.ts --reporter verbose`
Expected: FAIL — `startAllAssetLoops` does not exist, `start` is still defined

- [ ] **Step 3: Refactor TradingEngine**

In `src/trading/engine.ts`:

1. **Remove** these members:
   - `private strategy!: Strategy;`
   - `private intervalId: ReturnType<typeof setInterval> | null = null;`

2. **Remove** these methods entirely:
   - `private buildStrategy(): Strategy` (lines 61-64)
   - `start(): void` (lines 66-71)
   - `private restart(): void` (lines 73-80)
   - `async tick(): Promise<void>` (lines 82-101)

3. **Remove** from constructor:
   - `this.strategy = this.buildStrategy();` (line 38)
   - `logger.info(\`Trading engine using strategy: ${this.strategy.name}\`);` (line 47)
   - The entire `const activeAssets = ... for (const row ...) { startAssetLoop }` block in the constructor body — this moves to `startAllAssetLoops()`

4. **Update** the `STRATEGY_KEYS` subscription in constructor (line 39) to reload all asset loops:

```typescript
    runtimeConfig.subscribeMany([...STRATEGY_KEYS], () => {
      const activeAssets = discoveredAssetQueries.getActiveAssets.all(botState.activeNetwork) as DiscoveredAssetRow[];
      for (const row of activeAssets) {
        this.reloadAssetConfig(row.address, row.symbol, {
          strategyType: row.strategy as 'threshold' | 'sma' | 'grid',
          dropPct: row.drop_pct, risePct: row.rise_pct,
          smaShort: row.sma_short, smaLong: row.sma_long,
          gridLevels: row.grid_levels,
          gridUpperBound: row.grid_upper_bound ?? undefined,
          gridLowerBound: row.grid_lower_bound ?? undefined,
        });
      }
      logger.info('All asset loops reloaded due to config change');
    });
```

5. **Add** new public methods:

```typescript
  startAllAssetLoops(): void {
    const activeAssets = discoveredAssetQueries.getActiveAssets.all(botState.activeNetwork) as DiscoveredAssetRow[];
    for (const row of activeAssets) {
      this.startAssetLoop(row.address, row.symbol, {
        strategyType: row.strategy as 'threshold' | 'sma' | 'grid',
        dropPct: row.drop_pct, risePct: row.rise_pct,
        smaShort: row.sma_short, smaLong: row.sma_long,
        gridLevels: (row as any).grid_levels,
        gridUpperBound: (row as any).grid_upper_bound ?? undefined,
        gridLowerBound: (row as any).grid_lower_bound ?? undefined,
      });
    }
    logger.info(`Started ${activeAssets.length} asset loops`);
  }

  stopAllAssetLoops(): void {
    for (const symbol of this._assetLoops.keys()) {
      this.stopAssetLoop(symbol);
    }
  }

  get activeAssetCount(): number {
    return this._assetLoops.size;
  }
```

6. **Remove** the `Strategy` import from the top of the file (no longer needed). Keep `ThresholdStrategy`, `SMAStrategy`, `GridStrategy` imports (used in `tickAsset`).

7. **Update** `manualTrade` to accept an optional symbol parameter:

```typescript
  async manualTrade(action: 'buy' | 'sell', symbol?: string): Promise<void> {
    if (symbol) {
      await this.executor.executeForAsset(symbol, action, 'manual');
    } else {
      await this.executor.execute(action, 'Manual override via Telegram/CLI', 'manual');
    }
  }
```

This defaults to the existing ETH behavior when no symbol is provided (backward compatible with Telegram `/buy` and `/sell`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/engine-unified.test.ts tests/engine-grid.test.ts tests/engine-asset-loops.test.ts --reporter verbose`
Expected: All PASS

**Note:** Existing `engine-asset-loops.test.ts` may need minor updates if it references `engine.start()`. If so, remove those calls — the engine no longer has a global start.

- [ ] **Step 5: Commit**

```
git add src/trading/engine.ts tests/engine-unified.test.ts
git commit -m "feat: remove global strategy loop, add startAllAssetLoops()"
```

---

## Chunk 3: Boot-Time Wiring

### Task 3: Seed registry assets and update index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add registry asset seeding**

In `src/index.ts`, add import at top:

```typescript
import { ASSET_REGISTRY } from './assets/registry.js';
import { discoveredAssetQueries } from './data/db.js';
```

(`discoveredAssetQueries` may need to be added to the existing `settingQueries` import from `./data/db.js`)

After the network restore block (after line 37: `botState.setNetwork(savedNetwork)`) and before the optimizer dependencies block, add:

```typescript
  // Seed registry assets into discovered_assets so they get per-asset strategy controls
  for (const asset of ASSET_REGISTRY) {
    if (asset.symbol === 'USDC') continue;
    const address = asset.addresses[botState.activeNetwork as keyof typeof asset.addresses]
      ?? `native:${asset.symbol}`;
    discoveredAssetQueries.seedRegistryAsset.run({
      address,
      network: botState.activeNetwork,
      symbol: asset.symbol,
      name: asset.symbol, // AssetDefinition has no 'name' field; symbol is the display name
      decimals: asset.decimals,
    });
  }
  logger.info('Registry assets seeded into discovered_assets');
```

- [ ] **Step 2: Replace `engine.start()` with `engine.startAllAssetLoops()`**

Find line 88: `engine.start();`
Replace with: `engine.startAllAssetLoops();`

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```
git add src/index.ts
git commit -m "feat: seed registry assets on boot, replace engine.start() with startAllAssetLoops()"
```

---

## Chunk 4: Dashboard + Documentation

### Task 4: Repurpose global strategy setting in dashboard

**Files:**
- Modify: `src/web/public/index.html`

- [ ] **Step 1: Find and update the global Strategy setting label**

Search for the Settings modal section that renders the `STRATEGY` dropdown. It currently says something like "Strategy" as a label. Change the label to "Default Strategy (new assets)" to clarify that it only sets the default for newly seeded/discovered assets, not a global override.

This is a small label change — the dropdown itself (`threshold`/`sma`/`grid`) remains unchanged.

- [ ] **Step 2: Commit**

```
git add src/web/public/index.html
git commit -m "ui: relabel global strategy setting as default for new assets"
```

---

### Task 5: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add Phase 5.5 to project status**

After the Phase 5 entry, add:

```markdown
**Phase 5.5 (unified strategy control) complete** — Registry assets (ETH, CBBTC, CBETH) seeded into `discovered_assets` on boot. All tradeable assets now have identical per-asset strategy controls (threshold/SMA/grid) via the Asset Management modal. The separate global ETH strategy loop has been removed — all assets use the same `startAssetLoop` path. USDC remains the base currency with no strategy.
```

- [ ] **Step 2: Update Known Issues / Notes section**

Add a note:

```markdown
- **Per-asset strategy is primary:** The global `STRATEGY` setting only sets the default for newly added assets. Per-asset config in the `discovered_assets` table (editable via dashboard) takes precedence and persists across restarts.
```

- [ ] **Step 3: Commit**

```
git add CLAUDE.md
git commit -m "docs: add Phase 5.5 (unified per-asset strategy control) to CLAUDE.md"
```
