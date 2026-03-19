# Bollinger Bands + Grid Trading Strategies — Design Spec

**Date:** 2026-03-19
**Status:** Approved (revised after spec review)

## Goal

Add two new trading strategies to the bot: Bollinger Bands (integrated into the existing CandleStrategy scoring pipeline) and Grid Trading (a new standalone strategy class). Together they cover trending/volatile markets (Bollinger) and sideways/ranging markets (Grid).

## Architecture

Bollinger Bands extends the existing CandleStrategy — no new files. Grid Trading is a new strategy class following the existing Strategy interface pattern. Both use OHLCV candle data already collected by CandleService.

---

## 1. Bollinger Bands (CandleStrategy Integration)

### What It Does

Adds Bollinger Band signals to the CandleStrategy scoring system. Bollinger Bands measure price relative to a moving average +/- standard deviations. Price touching the lower band = statistically cheap (buy); upper band = statistically expensive (sell).

### Implementation

- **File modified:** `src/strategy/candle.ts`
- **Data source:** Existing OHLCV close prices from the candles table — no new data needed
- **Parameters (DB-persisted via RuntimeConfig):**
  - `BB_PERIOD` (default: 20) — lookback period for the moving average
  - `BB_STD_DEV` (default: 2.0) — number of standard deviations for band width

### Signal Contribution (raw additive scoring)

The existing CandleStrategy uses raw additive `buyScore`/`sellScore` accumulation (e.g., RSI oversold = +40, MACD crossover = +25). Bollinger Bands follow the same pattern — **no refactoring of the scoring model is needed.**

| Condition | buyScore | sellScore |
|---|---|---|
| Price below lower band | +15 to +25 (scales with distance) | 0 |
| Price above upper band | 0 | +15 to +25 (scales with distance) |
| Price near middle band | 0 | 0 |
| Bollinger Squeeze active | 1.5x multiplier on all BB scores this tick | same |

### Squeeze Detection

Squeeze is detected **within the same `evaluate()` call** — it is stateless and requires no persistence. The calculation:

1. Compute current band width: `(upper - lower) / middle`
2. Compute average band width over the last `BB_PERIOD` candles
3. If current width < 50% of average width → squeeze is active
4. When squeeze is active, the Bollinger contribution scores (±15 to ±25) are multiplied by 1.5x before adding to `buyScore`/`sellScore`

This is a per-tick calculation, not a cross-tick flag. If the squeeze condition is true this tick, the multiplier applies this tick. No state carried between `evaluate()` calls.

---

## 2. Grid Trading Strategy

### What It Does

A standalone strategy that profits from sideways/ranging markets by repeatedly buying low and selling high within a defined price grid. Fundamentally different from signal-based strategies — it maintains virtual price levels and executes when price crosses them.

### New File: `src/strategy/grid.ts`

Implements the `Strategy` interface from `src/strategy/base.ts`.

**Candle data access:** GridStrategy receives candle data via **constructor injection** — the `CandleService` instance (or a query function) is passed at construction time in `tickAsset`. The `evaluate(snapshots)` method uses `snapshots` for the current price (mapped to `eth_price` per the existing asset loop pattern) and the injected candle accessor for auto-calculating bounds. This mirrors how CandleStrategy accesses candle data in the optimizer.

**Constructor signature:**
```typescript
constructor(opts: {
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
})
```

### How the Grid Works

1. On initialization, calculate grid levels between `lowerBound` and `upperBound` with `gridLevels` evenly spaced price points
2. Each level has a state: `pending_buy`, `pending_sell`, or `idle`
3. Levels below current price start as `pending_buy`, above start as `pending_sell`
4. Each tick, check if price has crossed any level:
   - Crossed a `pending_buy` level downward: emit `buy` signal, mark level as `pending_sell`
   - Crossed a `pending_sell` level upward: emit `sell` signal, mark level as `pending_buy`
5. Only one signal per tick (the most profitable level crossing)

### Auto-Calculation from Candle Data

- `upperBound` = 24hr candle high + 2% buffer
- `lowerBound` = 24hr candle low - 2% buffer
- `gridLevels` = range / minimum profitable spread (must exceed fee estimate from `DEFAULT_FEE_ESTIMATE_PCT`)
- Recalculates every `GRID_RECALC_HOURS` (default: 6) from fresh candle data
- Never overrides manual values — `grid_manual_override` column on `discovered_assets` table (INTEGER DEFAULT 0, set to 1 when user manually configures bounds via dashboard)

### Configuration (DB-persisted via RuntimeConfig)

| Key | Default | Notes |
|---|---|---|
| `GRID_LEVELS` | `10` | Number of price levels in the grid |
| `GRID_AMOUNT_PCT` | `5` | % of portfolio per grid order |
| `GRID_UPPER_BOUND` | auto | Upper price bound (auto-calculated if not set) |
| `GRID_LOWER_BOUND` | auto | Lower price bound (auto-calculated if not set) |
| `GRID_RECALC_HOURS` | `6` | Hours between auto-recalculation of bounds |

### Grid State Persistence

Grid level states survive restarts via a new DB table:

```sql
CREATE TABLE grid_state (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL,
  network       TEXT NOT NULL,
  level_price   REAL NOT NULL,
  state         TEXT NOT NULL CHECK(state IN ('pending_buy','pending_sell','idle')),
  last_triggered TEXT,
  UNIQUE(symbol, network, level_price)
);
```

**Prepared statements needed:**
- `upsertGridLevel` — insert or update a grid level's state
- `getGridLevels` — get all levels for a symbol/network
- `clearGridLevels` — clear all levels for a symbol/network (used on recalculation)

**Recalculation atomicity:** Since both `clearGridLevels` and `upsertGridLevel` use synchronous `better-sqlite3` calls, and Node.js is single-threaded, recalculation is naturally atomic with respect to `tickAsset`. The recalc runs inside `evaluate()` at the start of a tick — it clears and rebuilds levels before checking crossings, all within the same synchronous call stack. No concurrent tick can interleave.

---

## 3. Integration Points

### TradingEngine (`src/trading/engine.ts`)

- Grid is selectable as a strategy type per asset: `threshold | sma | grid`
- Uses the existing `startAssetLoop` / `tickAsset` pattern
- `GridStrategy.evaluate()` receives price snapshots and returns `{signal, reason}` like all other strategies
- Strategy instantiation in `tickAsset` extended to handle `'grid'` type
- **Type annotation update:** `_assetStrategies: Map<string, ThresholdStrategy | SMAStrategy>` must be widened to `Map<string, ThresholdStrategy | SMAStrategy | GridStrategy>`
- **`AssetStrategyParams.strategyType`** must be widened from `'threshold' | 'sma'` to `'threshold' | 'sma' | 'grid'`
- Grid-specific params added to `AssetStrategyParams`: `gridLevels?: number`, `gridAmountPct?: number`, `gridUpperBound?: number`, `gridLowerBound?: number`, `gridRecalcHours?: number`

### Optimizer (`src/trading/optimizer.ts`)

- Assets running Grid strategy are **excluded from rotation sell candidates** — the optimizer won't try to rotate out of a grid-traded asset
- Grid-traded assets still contribute to portfolio value calculations and dashboard displays

### RuntimeConfig (`src/core/runtime-config.ts`)

New keys added: `BB_PERIOD`, `BB_STD_DEV`, `GRID_LEVELS`, `GRID_AMOUNT_PCT`, `GRID_UPPER_BOUND`, `GRID_LOWER_BOUND`, `GRID_RECALC_HOURS`

All live-reloadable, DB-persisted, editable via dashboard Settings.

### Dashboard (`src/web/public/index.html`)

- Asset Management modal: when strategy type is `grid`, show grid-specific config fields (levels, bounds, amount %)
- Small "Grid Status" indicator on assets using grid strategy showing: active level count, pending buy/sell counts, profit captured

### Database (`src/data/db.ts`)

- New `grid_state` table with prepared statements
- New RuntimeConfig keys registered with validators

---

## 4. What This Does NOT Include

- No new Telegram commands (grid status visible via existing `/status` per-asset display)
- No changes to the existing threshold, SMA, or candle strategy behaviour (only additive)
- No new API endpoints (grid config goes through existing settings/asset-config endpoints)
- No changes to TradeExecutor (grid signals flow through the same `executeForAsset` path)
