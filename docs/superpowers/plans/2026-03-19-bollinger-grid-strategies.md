# Bollinger Bands + Grid Trading Strategies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Bollinger Bands indicator to CandleStrategy scoring and implement a new Grid Trading strategy class.

**Architecture:** Bollinger Bands is added as a new scoring block inside the existing `CandleStrategy.evaluate()` method — no new files. Grid Trading is a new `GridStrategy` class in `src/strategy/grid.ts` implementing the `Strategy` interface, with grid state persisted in a new `grid_state` SQLite table. Both strategies integrate with the existing `TradingEngine` asset loop pattern.

**Tech Stack:** TypeScript ESM, better-sqlite3, Vitest, Express, Chart.js

**Spec:** `docs/superpowers/specs/2026-03-19-bollinger-grid-strategies-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/strategy/candle.ts` | Modify | Add `computeBollingerBands()` helper + BB scoring block in `evaluate()` |
| `src/strategy/grid.ts` | Create | `GridStrategy` class — grid level management, auto-calc, evaluate |
| `src/data/db.ts` | Modify | Add `grid_state` table, `gridStateQueries`, migration for `discovered_assets` columns |
| `src/core/runtime-config.ts` | Modify | Add BB and Grid config keys to ConfigKey |
| `src/trading/engine.ts` | Modify | Widen `AssetStrategyParams`, `_assetStrategies` type, handle `'grid'` in `tickAsset` |
| `src/trading/optimizer.ts` | Modify | Exclude grid-strategy assets from rotation sell candidates |
| `src/web/public/index.html` | Modify | Grid config fields in Asset Management modal, grid status indicator |
| `src/web/server.ts` | Modify | Extend asset config API for grid fields |
| `tests/candle-strategy.test.ts` | Modify | Add BB-specific tests |
| `tests/grid-strategy.test.ts` | Create | Grid strategy unit tests |
| `tests/engine-grid.test.ts` | Create | Engine integration test for grid strategy type |
| `tests/db-grid-state.test.ts` | Create | Grid state DB tests |

---

## Chunk 1: Bollinger Bands in CandleStrategy

### Task 1: Add `computeBollingerBands` helper and tests

**Files:**
- Modify: `src/strategy/candle.ts`
- Modify: `tests/candle-strategy.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/candle-strategy.test.ts` — import `computeBollingerBands` alongside the existing imports, then add a new describe block:

```typescript
describe('computeBollingerBands', () => {
  it('returns middle as SMA of closes', () => {
    const closes = Array.from({ length: 20 }, () => 100);
    const bb = computeBollingerBands(closes, 20, 2);
    expect(bb).not.toBeNull();
    expect(bb!.middle).toBeCloseTo(100, 5);
    expect(bb!.upper).toBeCloseTo(100, 5);
    expect(bb!.lower).toBeCloseTo(100, 5);
  });

  it('bands widen with volatile prices', () => {
    const closes = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 90 : 110));
    const bb = computeBollingerBands(closes, 20, 2);
    expect(bb!.middle).toBeCloseTo(100, 1);
    expect(bb!.upper).toBeGreaterThan(110);
    expect(bb!.lower).toBeLessThan(90);
  });

  it('returns null when not enough data', () => {
    expect(computeBollingerBands([100, 101], 20, 2)).toBeNull();
  });

  it('detects squeeze when bandwidth is narrow', () => {
    const volatile = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 80 : 120));
    const flat = Array.from({ length: 20 }, () => 100);
    const bb = computeBollingerBands([...volatile, ...flat], 20, 2);
    expect(bb).not.toBeNull();
    expect(bb!.squeeze).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/candle-strategy.test.ts --reporter verbose`
Expected: FAIL — `computeBollingerBands` is not exported

- [ ] **Step 3: Implement `computeBollingerBands`**

Add to `src/strategy/candle.ts` after the `computeMACD` function (after line 91):

```typescript
export interface BollingerResult {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;
  squeeze: boolean;
}

export function computeBollingerBands(
  closes: number[],
  period = 20,
  stdDevMultiplier = 2.0,
): BollingerResult | null {
  if (closes.length < period) return null;

  const window = closes.slice(-period);
  const sma = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((sum, v) => sum + (v - sma) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = sma + stdDevMultiplier * stdDev;
  const lower = sma - stdDevMultiplier * stdDev;
  const bandwidth = sma > 0 ? (upper - lower) / sma : 0;

  let squeeze = false;
  if (closes.length >= period * 2) {
    let bwSum = 0;
    let bwCount = 0;
    for (let end = closes.length - period; end <= closes.length; end++) {
      const w = closes.slice(end - period, end);
      const m = w.reduce((a, b) => a + b, 0) / period;
      if (m <= 0) continue;
      const v = w.reduce((s, x) => s + (x - m) ** 2, 0) / period;
      bwSum += (2 * stdDevMultiplier * Math.sqrt(v)) / m;
      bwCount++;
    }
    const avgBw = bwCount > 0 ? bwSum / bwCount : 0;
    squeeze = avgBw > 0 && bandwidth < avgBw * 0.5;
  }

  return { upper, middle: sma, lower, bandwidth, squeeze };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/candle-strategy.test.ts --reporter verbose`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```
git add src/strategy/candle.ts tests/candle-strategy.test.ts
git commit -m "feat: add computeBollingerBands helper with squeeze detection"
```

---

### Task 2: Integrate BB scoring into CandleStrategy.evaluate()

**Files:**
- Modify: `src/strategy/candle.ts`
- Modify: `tests/candle-strategy.test.ts`

- [ ] **Step 1: Write the failing tests**

Add inside the `CandleStrategy.evaluate` describe block in `tests/candle-strategy.test.ts`:

```typescript
  it('includes BB in reason when price is below lower Bollinger Band', () => {
    const flat = Array.from({ length: 30 }, () => 200);
    const drop = Array.from({ length: 10 }, (_, i) => 200 - (i + 1) * 8);
    const closes = [...flat, ...drop];
    const candles = closes.map((close, i) => ({
      open: close, high: close + 1,
      low: i === closes.length - 1 ? close - 10 : close - 1,
      close, volume: 100,
    }));
    const result = strategy.evaluate(candles);
    expect(result.reason).toContain('BB');
  });

  it('includes BB in reason when price is above upper Bollinger Band', () => {
    const flat = Array.from({ length: 30 }, () => 100);
    const rise = Array.from({ length: 10 }, (_, i) => 100 + (i + 1) * 8);
    const closes = [...flat, ...rise];
    const candles = closes.map((close, i) => ({
      open: close, high: i === closes.length - 1 ? close + 10 : close + 1,
      low: close - 1, close, volume: 100,
    }));
    const result = strategy.evaluate(candles);
    expect(result.reason).toContain('BB');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/candle-strategy.test.ts --reporter verbose`
Expected: FAIL — reason strings don't contain 'BB'

- [ ] **Step 3: Add BB scoring block to `evaluate()`**

In `src/strategy/candle.ts`, inside `CandleStrategy.evaluate()`, after the volume bonus block (line ~171 `if (volBonus) reasons.push(...)`) and before the decision block (line ~174 `const net = buyScore - sellScore`), insert:

```typescript
    // Bollinger Bands — BB_PERIOD and BB_STD_DEV are read from RuntimeConfig
    // by the optimizer when constructing scoring calls; here we use defaults
    // which can be overridden if CandleStrategy gains constructor params later.
    // For now, the optimizer passes these when calling evaluateForScoring().
    const bb = computeBollingerBands(closes);
    if (bb) {
      const lastClose = closes[closes.length - 1];
      const squeezeMult = bb.squeeze ? 1.5 : 1.0;
      if (lastClose < bb.lower) {
        const distance = (bb.lower - lastClose) / (bb.upper - bb.lower || 1);
        const pts = Math.round((15 + Math.min(distance, 1) * 10) * squeezeMult);
        buyScore += pts;
        reasons.push(`BB below lower (${pts}pts${bb.squeeze ? ', squeeze' : ''})`);
      } else if (lastClose > bb.upper) {
        const distance = (lastClose - bb.upper) / (bb.upper - bb.lower || 1);
        const pts = Math.round((15 + Math.min(distance, 1) * 10) * squeezeMult);
        sellScore += pts;
        reasons.push(`BB above upper (${pts}pts${bb.squeeze ? ', squeeze' : ''})`);
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/candle-strategy.test.ts --reporter verbose`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```
git add src/strategy/candle.ts tests/candle-strategy.test.ts
git commit -m "feat: integrate Bollinger Bands scoring into CandleStrategy"
```

---

### Task 3: Add BB and Grid config keys to RuntimeConfig

**Files:**
- Modify: `src/core/runtime-config.ts`

- [ ] **Step 1: Add all new keys**

In `src/core/runtime-config.ts`:

1. Add to `ConfigKey` type union (after the TELEGRAM line):
   `| 'BB_PERIOD' | 'BB_STD_DEV' | 'GRID_LEVELS' | 'GRID_AMOUNT_PCT' | 'GRID_UPPER_BOUND' | 'GRID_LOWER_BOUND' | 'GRID_RECALC_HOURS'`

2. Add to `ALL_KEYS` set:
   `'BB_PERIOD', 'BB_STD_DEV', 'GRID_LEVELS', 'GRID_AMOUNT_PCT', 'GRID_UPPER_BOUND', 'GRID_LOWER_BOUND', 'GRID_RECALC_HOURS'`

3. Add to `VALIDATORS`:
   ```typescript
   BB_PERIOD:         v => isInt(v) && (v as number) >= 5 && (v as number) <= 100 ? null : 'must be 5-100',
   BB_STD_DEV:        v => isNum(v) && (v as number) >= 0.5 && (v as number) <= 5 ? null : 'must be 0.5-5',
   GRID_LEVELS:       v => isInt(v) && (v as number) >= 3 && (v as number) <= 50 ? null : 'must be 3-50',
   GRID_AMOUNT_PCT:   v => isNum(v) && (v as number) >= 1 && (v as number) <= 25 ? null : 'must be 1-25',
   GRID_UPPER_BOUND:  v => !v || (isNum(v) && (v as number) > 0) ? null : 'must be a positive number or empty',
   GRID_LOWER_BOUND:  v => !v || (isNum(v) && (v as number) > 0) ? null : 'must be a positive number or empty',
   GRID_RECALC_HOURS: v => isNum(v) && (v as number) >= 1 && (v as number) <= 48 ? null : 'must be 1-48',
   ```
   `GRID_UPPER_BOUND` and `GRID_LOWER_BOUND` are global fallback defaults. Per-asset values from `AssetStrategyParams` take precedence; `grid_manual_override = 1` on `discovered_assets` locks per-asset values.

4. Add to `numericKeys` array: `'BB_PERIOD', 'BB_STD_DEV', 'GRID_LEVELS', 'GRID_AMOUNT_PCT', 'GRID_UPPER_BOUND', 'GRID_LOWER_BOUND', 'GRID_RECALC_HOURS'`

5. Update `STRATEGY` validator to accept `'grid'`:
   Change `['threshold', 'sma'].includes(String(v))` to `['threshold', 'sma', 'grid'].includes(String(v))`

- [ ] **Step 2: Run existing config tests**

Run: `npx vitest run tests/runtime-config.test.ts --reporter verbose`
Expected: All PASS

- [ ] **Step 3: Commit**

```
git add src/core/runtime-config.ts
git commit -m "feat: add BB and grid config keys to RuntimeConfig"
```

---

## Chunk 2: Grid Trading Strategy

### Task 4: Add grid_state table and discovered_assets grid columns

**Files:**
- Modify: `src/data/db.ts`
- Create: `tests/db-grid-state.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/db-grid-state.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { db, gridStateQueries } from '../src/data/db.js';

describe('grid_state table', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM grid_state').run();
  });

  it('upserts a grid level', () => {
    gridStateQueries.upsertGridLevel.run({
      symbol: 'ETH', network: 'base-sepolia',
      level_price: 1800, state: 'pending_buy',
    });
    const rows = gridStateQueries.getGridLevels.all('ETH', 'base-sepolia');
    expect(rows).toHaveLength(1);
    expect(rows[0].level_price).toBe(1800);
    expect(rows[0].state).toBe('pending_buy');
  });

  it('updates state on conflict', () => {
    gridStateQueries.upsertGridLevel.run({
      symbol: 'ETH', network: 'base-sepolia',
      level_price: 1800, state: 'pending_buy',
    });
    gridStateQueries.upsertGridLevel.run({
      symbol: 'ETH', network: 'base-sepolia',
      level_price: 1800, state: 'pending_sell',
    });
    const rows = gridStateQueries.getGridLevels.all('ETH', 'base-sepolia');
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('pending_sell');
  });

  it('clears all levels for a symbol/network', () => {
    gridStateQueries.upsertGridLevel.run({
      symbol: 'ETH', network: 'base-sepolia',
      level_price: 1800, state: 'pending_buy',
    });
    gridStateQueries.upsertGridLevel.run({
      symbol: 'ETH', network: 'base-sepolia',
      level_price: 1900, state: 'pending_sell',
    });
    gridStateQueries.clearGridLevels.run('ETH', 'base-sepolia');
    expect(gridStateQueries.getGridLevels.all('ETH', 'base-sepolia')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/db-grid-state.test.ts --reporter verbose`
Expected: FAIL — `gridStateQueries` not exported

- [ ] **Step 3: Implement the table, migrations, and queries**

In `src/data/db.ts`:

1. After the existing table creation block, add the grid_state table:

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS grid_state (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol        TEXT NOT NULL,
    network       TEXT NOT NULL,
    level_price   REAL NOT NULL,
    state         TEXT NOT NULL CHECK(state IN ('pending_buy','pending_sell','idle')),
    last_triggered TEXT,
    UNIQUE(symbol, network, level_price)
  );
`);
```

2. Add migrations for discovered_assets grid columns (near the other migrations):

```typescript
try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN grid_manual_override INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN grid_upper_bound REAL`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN grid_lower_bound REAL`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN grid_levels INTEGER NOT NULL DEFAULT 10`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN grid_amount_pct REAL NOT NULL DEFAULT 5.0`); } catch { /* exists */ }
```

3. Update the `strategy` CHECK in the CREATE TABLE to include `'grid'`:
   `CHECK(strategy IN ('threshold','sma','grid'))`
   **Note:** `CREATE TABLE IF NOT EXISTS` won't re-run on an existing DB, so the old CHECK constraint remains. SQLite does not enforce CHECK constraints on UPDATE statements, but INSERT may fail. Add a migration that rebuilds the table if needed:
   ```typescript
   // Migration: allow 'grid' strategy — SQLite CHECK constraints can't be altered,
   // but SQLite doesn't enforce CHECK on UPDATE. For safety, test with an insert:
   try {
     db.exec(`INSERT INTO discovered_assets (address, network, symbol, strategy) VALUES ('__grid_test__', '__test__', '__test__', 'grid')`);
     db.exec(`DELETE FROM discovered_assets WHERE address = '__grid_test__'`);
   } catch {
     // CHECK constraint blocks 'grid' — rebuild table
     db.exec(`ALTER TABLE discovered_assets RENAME TO discovered_assets_old`);
     // Re-create with updated CHECK including 'grid'
     // Then: INSERT INTO discovered_assets SELECT * FROM discovered_assets_old
     // Then: DROP TABLE discovered_assets_old
     // (Full DDL should mirror the existing CREATE TABLE with the 'grid' addition)
   }
   ```

4. Update `DiscoveredAssetRow` interface to add the new fields:
   ```typescript
   strategy:     'threshold' | 'sma' | 'grid';
   grid_manual_override: number;
   grid_upper_bound: number | null;
   grid_lower_bound: number | null;
   grid_levels:  number;
   grid_amount_pct: number;
   ```

5. Add `GridStateRow` interface and `gridStateQueries`:

```typescript
export interface GridStateRow {
  id: number;
  symbol: string;
  network: string;
  level_price: number;
  state: 'pending_buy' | 'pending_sell' | 'idle';
  last_triggered: string | null;
}

export const gridStateQueries = {
  upsertGridLevel: db.prepare(`
    INSERT INTO grid_state (symbol, network, level_price, state)
    VALUES (@symbol, @network, @level_price, @state)
    ON CONFLICT(symbol, network, level_price) DO UPDATE SET
      state = excluded.state, last_triggered = datetime('now')
  `) as Statement<{ symbol: string; network: string; level_price: number; state: string }>,

  getGridLevels: db.prepare(`
    SELECT * FROM grid_state WHERE symbol = ? AND network = ? ORDER BY level_price ASC
  `) as Statement<[string, string], GridStateRow>,

  clearGridLevels: db.prepare(`
    DELETE FROM grid_state WHERE symbol = ? AND network = ?
  `) as Statement<[string, string]>,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/db-grid-state.test.ts --reporter verbose`
Expected: All PASS

- [ ] **Step 5: Commit**

```
git add src/data/db.ts tests/db-grid-state.test.ts
git commit -m "feat: add grid_state table and discovered_assets grid columns"
```

---

### Task 5: Implement GridStrategy class

**Files:**
- Create: `src/strategy/grid.ts`
- Create: `tests/grid-strategy.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/grid-strategy.test.ts`. This test file mocks `gridStateQueries` to use an in-memory array instead of SQLite (since Strategy tests should be unit tests, not DB integration tests):

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

const levels: Array<{ symbol: string; network: string; level_price: number; state: string }> = [];

vi.mock('../src/data/db.js', () => ({
  gridStateQueries: {
    upsertGridLevel: { run: (row: any) => {
      const idx = levels.findIndex(l =>
        l.symbol === row.symbol && l.network === row.network && l.level_price === row.level_price);
      if (idx >= 0) levels[idx] = row; else levels.push({ ...row });
    }},
    getGridLevels: { all: (sym: string, net: string) =>
      levels.filter(l => l.symbol === sym && l.network === net)
        .sort((a, b) => a.level_price - b.level_price)
    },
    clearGridLevels: { run: (sym: string, net: string) => {
      for (let i = levels.length - 1; i >= 0; i--) {
        if (levels[i].symbol === sym && levels[i].network === net) levels.splice(i, 1);
      }
    }},
  },
}));

import { GridStrategy } from '../src/strategy/grid.js';

function snap(prices: number[]) {
  return prices.map(p => ({
    eth_price: p, eth_balance: 0, portfolio_usd: 0,
    timestamp: new Date().toISOString(),
  }));
}

describe('GridStrategy', () => {
  beforeEach(() => { levels.length = 0; });

  it('returns hold on first tick (initialization)', () => {
    const g = new GridStrategy({
      symbol: 'ETH', network: 'base-sepolia', gridLevels: 5,
      upperBound: 2000, lowerBound: 1800,
      getCandleHigh24h: () => 2000, getCandleLow24h: () => 1800,
      feeEstimatePct: 1.0,
    });
    expect(g.evaluate(snap([1900])).signal).toBe('hold');
  });

  it('emits buy when price drops below a pending_buy level', () => {
    const g = new GridStrategy({
      symbol: 'ETH', network: 'base-sepolia', gridLevels: 5,
      upperBound: 2000, lowerBound: 1800,
      getCandleHigh24h: () => 2000, getCandleLow24h: () => 1800,
      feeEstimatePct: 1.0,
    });
    g.evaluate(snap([1900])); // init
    const r = g.evaluate(snap([1900, 1810]));
    expect(r.signal).toBe('buy');
    expect(r.reason).toContain('Grid');
  });

  it('emits sell when price rises above a pending_sell level', () => {
    const g = new GridStrategy({
      symbol: 'ETH', network: 'base-sepolia', gridLevels: 5,
      upperBound: 2000, lowerBound: 1800,
      getCandleHigh24h: () => 2000, getCandleLow24h: () => 1800,
      feeEstimatePct: 1.0,
    });
    g.evaluate(snap([1900])); // init
    const r = g.evaluate(snap([1900, 1990]));
    expect(r.signal).toBe('sell');
    expect(r.reason).toContain('Grid');
  });

  it('flips level state after trigger (buy then sell)', () => {
    // With 5 levels between 1800-2000, step = 200/6 = 33.3
    // Levels at ~1833, 1867, 1900, 1933, 1967
    // Buy triggers when price drops below 1867 (prevPrice=1900 > 1867, currentPrice=1810 <= 1867)
    // After flip to pending_sell, sell triggers when price rises above 1867
    // (prevPrice=1810 < 1867, currentPrice=1880 >= 1867)
    const g = new GridStrategy({
      symbol: 'ETH', network: 'base-sepolia', gridLevels: 5,
      upperBound: 2000, lowerBound: 1800,
      getCandleHigh24h: () => 2000, getCandleLow24h: () => 1800,
      feeEstimatePct: 1.0,
    });
    g.evaluate(snap([1900])); // init
    const buy = g.evaluate(snap([1900, 1810]));
    expect(buy.signal).toBe('buy');
    // Price must rise above the flipped level (~1867) for sell
    const sell = g.evaluate(snap([1810, 1880]));
    expect(sell.signal).toBe('sell');
  });

  it('auto-calculates bounds from candle data', () => {
    const g = new GridStrategy({
      symbol: 'ETH', network: 'base-sepolia', gridLevels: 5,
      getCandleHigh24h: () => 2000, getCandleLow24h: () => 1800,
      feeEstimatePct: 1.0,
    });
    g.evaluate(snap([1900])); // init with auto bounds
    // Lower bound = 1800 * 0.98 = 1764, so 1770 should still trigger a buy level
    const r = g.evaluate(snap([1900, 1770]));
    expect(r.signal).toBe('buy');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/grid-strategy.test.ts --reporter verbose`
Expected: FAIL — `GridStrategy` not found

- [ ] **Step 3: Implement GridStrategy**

Create `src/strategy/grid.ts`:

```typescript
import { gridStateQueries, type GridStateRow } from '../data/db.js';
import type { Strategy, Snapshot, StrategyResult } from './base.js';

export interface GridStrategyOpts {
  symbol: string;
  network: string;
  gridLevels?: number;
  amountPct?: number;
  upperBound?: number;
  lowerBound?: number;
  recalcHours?: number;
  getCandleHigh24h: () => number | null;
  getCandleLow24h: () => number | null;
  feeEstimatePct: number;
}

export class GridStrategy implements Strategy {
  readonly name = 'grid';

  private readonly symbol: string;
  private readonly network: string;
  private readonly gridLevelCount: number;
  private readonly recalcHours: number;
  private readonly getCandleHigh24h: () => number | null;
  private readonly getCandleLow24h: () => number | null;
  private readonly feeEstimatePct: number;

  private upperBound: number | undefined;
  private lowerBound: number | undefined;
  private manualBounds: boolean;
  private lastRecalc = 0;
  private initialized = false;

  constructor(opts: GridStrategyOpts) {
    this.symbol = opts.symbol;
    this.network = opts.network;
    this.gridLevelCount = opts.gridLevels ?? 10;
    this.recalcHours = opts.recalcHours ?? 6;
    this.getCandleHigh24h = opts.getCandleHigh24h;
    this.getCandleLow24h = opts.getCandleLow24h;
    this.feeEstimatePct = opts.feeEstimatePct;

    if (opts.upperBound != null && opts.lowerBound != null) {
      this.upperBound = opts.upperBound;
      this.lowerBound = opts.lowerBound;
      this.manualBounds = true;
    } else {
      this.manualBounds = false;
    }
  }

  evaluate(snapshots: Snapshot[]): StrategyResult {
    if (snapshots.length === 0) return { signal: 'hold', reason: 'No snapshots' };

    const currentPrice = snapshots[snapshots.length - 1].eth_price;
    const prevPrice = snapshots.length > 1
      ? snapshots[snapshots.length - 2].eth_price
      : currentPrice;

    // Auto-calculate bounds if needed
    if (!this.manualBounds) {
      const now = Date.now();
      if (!this.initialized || now - this.lastRecalc > this.recalcHours * 3_600_000) {
        this.recalculateBounds(currentPrice);
      }
    }

    // First tick: initialize grid levels
    if (!this.initialized) {
      if (this.upperBound == null || this.lowerBound == null) {
        return { signal: 'hold', reason: 'Grid bounds not available' };
      }
      this.initializeLevels(currentPrice);
      this.initialized = true;
      return { signal: 'hold', reason: 'Grid initialized' };
    }

    // Check level crossings
    const levels = gridStateQueries.getGridLevels.all(
      this.symbol, this.network,
    ) as GridStateRow[];

    for (const level of levels) {
      if (level.state === 'pending_buy'
        && currentPrice <= level.level_price
        && prevPrice > level.level_price) {
        gridStateQueries.upsertGridLevel.run({
          symbol: this.symbol, network: this.network,
          level_price: level.level_price, state: 'pending_sell',
        });
        return {
          signal: 'buy',
          reason: `Grid buy at ${level.level_price.toFixed(2)}`,
        };
      }

      if (level.state === 'pending_sell'
        && currentPrice >= level.level_price
        && prevPrice < level.level_price) {
        gridStateQueries.upsertGridLevel.run({
          symbol: this.symbol, network: this.network,
          level_price: level.level_price, state: 'pending_buy',
        });
        return {
          signal: 'sell',
          reason: `Grid sell at ${level.level_price.toFixed(2)}`,
        };
      }
    }

    return { signal: 'hold', reason: 'No grid level crossed' };
  }

  private recalculateBounds(currentPrice: number): void {
    const high = this.getCandleHigh24h();
    const low = this.getCandleLow24h();
    if (high != null && low != null && high > low) {
      this.upperBound = high * 1.02;
      this.lowerBound = low * 0.98;
    } else {
      this.upperBound = currentPrice * 1.05;
      this.lowerBound = currentPrice * 0.95;
    }
    this.lastRecalc = Date.now();
  }

  private initializeLevels(currentPrice: number): void {
    gridStateQueries.clearGridLevels.run(this.symbol, this.network);

    const upper = this.upperBound!;
    const lower = this.lowerBound!;
    const step = (upper - lower) / (this.gridLevelCount + 1);
    const minStep = currentPrice * (this.feeEstimatePct / 100) * 2;
    const effectiveStep = Math.max(step, minStep);
    const count = Math.min(
      this.gridLevelCount,
      Math.floor((upper - lower) / effectiveStep),
    );

    for (let i = 1; i <= count; i++) {
      const price = lower + i * effectiveStep;
      gridStateQueries.upsertGridLevel.run({
        symbol: this.symbol, network: this.network,
        level_price: Math.round(price * 100) / 100,
        state: price < currentPrice ? 'pending_buy' : 'pending_sell',
      });
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/grid-strategy.test.ts --reporter verbose`
Expected: All PASS

- [ ] **Step 5: Commit**

```
git add src/strategy/grid.ts tests/grid-strategy.test.ts
git commit -m "feat: implement GridStrategy with level management and auto-bounds"
```

---

## Chunk 3: Engine Integration + Optimizer Exclusion

### Task 6: Wire GridStrategy into TradingEngine

**Files:**
- Modify: `src/trading/engine.ts`
- Create: `tests/engine-grid.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/engine-grid.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/data/db.js', () => ({
  queries: { recentSnapshots: { all: () => [] }, recentAssetSnapshots: { all: () => [] } },
  discoveredAssetQueries: { getActiveAssets: { all: () => [] } },
  gridStateQueries: {
    upsertGridLevel: { run: vi.fn() },
    getGridLevels: { all: () => [] },
    clearGridLevels: { run: vi.fn() },
  },
}));
vi.mock('../src/core/state.js', () => ({
  botState: { isPaused: false, activeNetwork: 'base-sepolia', status: 'running' },
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
    };
    return d[k];
  }),
  subscribe: vi.fn(), subscribeMany: vi.fn(),
};

import { TradingEngine } from '../src/trading/engine.js';

describe('TradingEngine grid support', () => {
  it('accepts grid as a strategy type without throwing', () => {
    const engine = new TradingEngine(mockExecutor as any, mockConfig as any);
    expect(() => {
      engine.startAssetLoop('0xabc', 'TEST', {
        strategyType: 'grid', dropPct: 2, risePct: 3,
        smaShort: 5, smaLong: 20,
        gridLevels: 10, gridUpperBound: 2000, gridLowerBound: 1800,
      });
    }).not.toThrow();
    engine.stopAssetLoop('TEST');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine-grid.test.ts --reporter verbose`
Expected: FAIL — `strategyType: 'grid'` not assignable

- [ ] **Step 3: Update TradingEngine**

In `src/trading/engine.ts`:

1. Add import: `import { GridStrategy } from '../strategy/grid.js';`

2. Widen `AssetStrategyParams`:
```typescript
interface AssetStrategyParams {
  strategyType: 'threshold' | 'sma' | 'grid';
  dropPct: number;
  risePct: number;
  smaShort: number;
  smaLong: number;
  gridLevels?: number;
  gridUpperBound?: number;
  gridLowerBound?: number;
}
```

3. Widen `_assetStrategies`:
```typescript
private readonly _assetStrategies = new Map<string, ThresholdStrategy | SMAStrategy | GridStrategy>();
```

4. Update snapshot limit in `tickAsset` — grid only needs 2 snapshots (current + prev):
```typescript
    const limit = params.strategyType === 'grid' ? 5 : params.smaLong + 5;
```

5. Update strategy creation in `tickAsset` (replace lines 150-154):
```typescript
    let strategy = this._assetStrategies.get(symbol);
    if (!strategy) {
      if (params.strategyType === 'grid') {
        strategy = new GridStrategy({
          symbol,
          network: botState.activeNetwork,
          gridLevels: params.gridLevels,
          upperBound: params.gridUpperBound,
          lowerBound: params.gridLowerBound,
          getCandleHigh24h: () => null,
          getCandleLow24h: () => null,
          feeEstimatePct: (this.runtimeConfig.get('DEFAULT_FEE_ESTIMATE_PCT') as number) ?? 1.0,
        });
      } else if (params.strategyType === 'sma') {
        strategy = new SMAStrategy({ shortWindow: params.smaShort, longWindow: params.smaLong });
      } else {
        strategy = new ThresholdStrategy({ dropPct: params.dropPct, risePct: params.risePct });
      }
      this._assetStrategies.set(symbol, strategy);
    }
```

6. In the `TradingEngine` constructor body (lines 49-58), update the `startAssetLoop` call to pass grid params:
```typescript
      this.startAssetLoop(row.address, row.symbol, {
        strategyType: row.strategy as 'threshold' | 'sma' | 'grid',
        dropPct: row.drop_pct,
        risePct: row.rise_pct,
        smaShort: row.sma_short,
        smaLong: row.sma_long,
        gridLevels: (row as any).grid_levels,
        gridUpperBound: (row as any).grid_upper_bound ?? undefined,
        gridLowerBound: (row as any).grid_lower_bound ?? undefined,
      });
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/engine-grid.test.ts --reporter verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add src/trading/engine.ts tests/engine-grid.test.ts
git commit -m "feat: wire GridStrategy into TradingEngine asset loops"
```

---

### Task 7: Exclude grid assets from optimizer rotation

**Files:**
- Modify: `src/trading/optimizer.ts`

- [ ] **Step 1: Read the optimizer to find sell-candidate selection**

Read `src/trading/optimizer.ts` and locate where sell candidates are filtered.

- [ ] **Step 2: Add grid exclusion filter**

Import `discoveredAssetQueries` and `DiscoveredAssetRow` if not already imported. Find the method that receives `network` as a parameter (likely `tick(network: string)` or similar) and add the grid exclusion in the sell-candidate selection logic. The `network` variable is available as a parameter to the optimizer's tick method:

```typescript
// Exclude grid-strategy assets from rotation
const gridAssets = new Set(
  (discoveredAssetQueries.getActiveAssets.all(network) as DiscoveredAssetRow[])
    .filter(a => a.strategy === 'grid')
    .map(a => a.symbol)
);
```

Then filter sell candidates: `.filter(s => !gridAssets.has(s.symbol))`

- [ ] **Step 3: Run existing optimizer tests**

Run: `npx vitest run tests/optimizer.test.ts --reporter verbose`
Expected: All PASS

- [ ] **Step 4: Commit**

```
git add src/trading/optimizer.ts
git commit -m "feat: exclude grid-strategy assets from optimizer rotation"
```

---

## Chunk 4: Dashboard + API + Docs

### Task 8: Add grid config fields to dashboard and asset API

**Files:**
- Modify: `src/web/public/index.html`
- Modify: `src/web/server.ts`

- [ ] **Step 1: Update Asset Management modal**

In `src/web/public/index.html`, find the `buildConfigForm` function or where strategy config fields are rendered. Add:

1. `'grid'` option to the strategy `<select>` dropdown
2. Grid-specific fields (shown when strategy is 'grid'):
   - Grid Levels (number input, 3-50)
   - Upper Bound (number input, empty = auto)
   - Lower Bound (number input, empty = auto)
3. When saving, include grid fields in the POST body
4. Add a small `GRID` badge on assets using grid strategy (use `var(--blue)` color)

- [ ] **Step 2: Update asset config API endpoint**

In `src/web/server.ts`, find the asset config update endpoint. Extend it to handle grid fields:

```typescript
if (strategy === 'grid') {
  const gridLevels = Number(req.body.grid_levels) || 10;
  const gridUpperBound = req.body.grid_upper_bound != null ? Number(req.body.grid_upper_bound) : null;
  const gridLowerBound = req.body.grid_lower_bound != null ? Number(req.body.grid_lower_bound) : null;
  const gridManualOverride = (gridUpperBound != null && gridLowerBound != null) ? 1 : 0;
  db.prepare(`
    UPDATE discovered_assets
    SET grid_levels = ?, grid_upper_bound = ?, grid_lower_bound = ?, grid_manual_override = ?
    WHERE address = ? AND network = ?
  `).run(gridLevels, gridUpperBound, gridLowerBound, gridManualOverride, address, network);
}
```

- [ ] **Step 3: Test manually**

Load dashboard, verify grid option appears, fields show/hide correctly, GRID badge renders.

- [ ] **Step 4: Commit**

```
git add src/web/public/index.html src/web/server.ts
git commit -m "feat: add grid config fields and badge to dashboard"
```

---

### Task 9: Update CLAUDE.md documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add Phase 5 to project status**

```markdown
**Phase 5 (new strategies) complete** — Bollinger Bands indicator added to CandleStrategy scoring (squeeze detection, +/-25pts buy/sell). Grid Trading strategy with auto-calculated bounds from 24hr candle data, manual override, persistent grid state. Dashboard grid config and status badge.
```

- [ ] **Step 2: Update architecture tree**

Update candle.ts description, add grid.ts entry.

- [ ] **Step 3: Add new config keys to settings reference table**

Add BB_PERIOD, BB_STD_DEV, GRID_LEVELS, GRID_AMOUNT_PCT, GRID_RECALC_HOURS.

- [ ] **Step 4: Commit**

```
git add CLAUDE.md
git commit -m "docs: add Phase 5 (Bollinger Bands + Grid Trading) to CLAUDE.md"
```
