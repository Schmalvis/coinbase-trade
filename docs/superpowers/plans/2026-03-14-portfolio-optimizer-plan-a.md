# Portfolio Optimizer — Plan A: Data & Strategy Foundation

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the data layer (DB tables, CandleService) and CandleStrategy that the portfolio optimizer will consume.

**Architecture:** New DB tables for candles, watchlist, rotations, and daily P&L. CandleService fetches OHLCV from Coinbase Advanced Trade API (primary), synthesizes candles from spot prices (fallback). CandleStrategy evaluates candle arrays using RSI, MACD, volume trend, and candle body analysis.

**Tech Stack:** TypeScript ESM, better-sqlite3, Coinbase Advanced Trade REST API (public, no auth), Vitest

**Spec:** `docs/superpowers/specs/2026-03-14-portfolio-optimizer-design.md`

**Conventions:**
- TypeScript ESM — all imports use `.js` extensions even for `.ts` source files
- `better-sqlite3` is synchronous — never `await` DB calls
- DB migration: `CREATE TABLE IF NOT EXISTS` — never drop existing tables
- `botState` is a singleton — do not instantiate it
- `runtimeConfig.get('KEY')` for live-reloadable settings; `config.KEY` for boot-time-only
- Vitest with `vi.hoisted()` for mock hoisting in ESM
- Run tests with `npx vitest run`
- Type check with `npx tsc --noEmit`

---

## Chunk 1: DB Schema & RuntimeConfig

### Task 1: New Database Tables

**Files:**
- Modify: `src/data/db.ts`
- Test: `tests/db-optimizer-tables.test.ts`

- [ ] **Step 1: Write failing test for new tables**

Create `tests/db-optimizer-tables.test.ts` that verifies:
- `candles` table exists with columns: symbol, network, interval, open_time, open, high, low, close, volume, source
- `watchlist` table exists with columns: symbol, network, address, coinbase_pair, status
- `rotations` table exists with columns: sell_symbol, buy_symbol, estimated_gain_pct, dry_run, network
- `daily_pnl` table exists with columns: date, network, high_water, rotations
- `candles` UNIQUE constraint on (symbol, network, interval, open_time) prevents duplicates

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db-optimizer-tables.test.ts`
Expected: FAIL — tables don't exist yet

- [ ] **Step 3: Add table DDL to db.ts**

Add after the existing `portfolio_snapshots` table creation in `src/data/db.ts` the four new tables from the spec (Section 2.2). Include the index: `CREATE INDEX IF NOT EXISTS idx_rotations_network_ts ON rotations(network, timestamp)`.

- [ ] **Step 4: Add prepared statements for new tables**

Add new query exports to `src/data/db.ts`:

`candleQueries`:
- `insertCandle` — INSERT OR REPLACE into candles
- `getCandles` — SELECT by symbol, network, interval ORDER BY open_time DESC LIMIT ?
- `deleteOldCandles` — DELETE WHERE interval = ? AND open_time < ?

`watchlistQueries`:
- `insertWatchlistItem` — INSERT OR IGNORE
- `getWatchlist` — SELECT WHERE network = ? AND status = 'watching'
- `updateWatchlistStatus` — UPDATE status WHERE symbol AND network
- `removeWatchlistItem` — UPDATE status = 'removed'

`rotationQueries`:
- `insertRotation` — INSERT with all fields
- `updateRotation` — UPDATE status, amounts, tx hashes by id
- `getRecentRotations` — SELECT by network ORDER BY id DESC LIMIT ?
- `getTodayRotationCount` — SELECT COUNT WHERE network AND date(timestamp) = date('now') AND status IN ('executed', 'leg1_done')

`dailyPnlQueries`:
- `upsertDailyPnl` — INSERT ON CONFLICT UPDATE (high_water uses MAX)
- `getDailyPnl` — SELECT by date and network
- `getTodayPnl` — SELECT WHERE date = date('now') AND network

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/db-optimizer-tables.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```
git add src/data/db.ts tests/db-optimizer-tables.test.ts
git commit -m "feat: add optimizer DB tables (candles, watchlist, rotations, daily_pnl)"
```

---

### Task 2: RuntimeConfig — New Optimizer Keys

**Files:**
- Modify: `src/core/runtime-config.ts`
- Modify: `src/config.ts`
- Test: `tests/runtime-config-optimizer.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/runtime-config-optimizer.test.ts` that verifies:
- Reading optimizer defaults works (MAX_POSITION_PCT=40, MAX_DAILY_LOSS_PCT=5, OPTIMIZER_INTERVAL_SECONDS=300, DASHBOARD_THEME='dark')
- Validates MAX_POSITION_PCT range (5-100): 3 throws, 101 throws, 50 works
- Validates DASHBOARD_THEME: 'neon' throws, 'light' works
- Persists optimizer keys to DB and reads them back in a new RuntimeConfig instance
- Allows negative thresholds for ROTATION_SELL_THRESHOLD and RISK_OFF_THRESHOLD

Use a mock DB (in-memory Map) — same pattern as existing runtime-config tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runtime-config-optimizer.test.ts`
Expected: FAIL — new keys not in ALL_KEYS

- [ ] **Step 3: Add new keys to runtime-config.ts**

Modify `src/core/runtime-config.ts`:
1. Add 15 new keys to the `ConfigKey` type union
2. Add all 15 to the `ALL_KEYS` set
3. Add validators for each (see spec Section 4 for ranges)
4. Add numeric keys to the `coerce()` function's `numericKeys` array (all except DASHBOARD_THEME which is a string)

- [ ] **Step 4: Add defaults to config.ts**

Add 15 new fields to the Zod schema in `src/config.ts` with their defaults (see spec Section 4).

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/runtime-config-optimizer.test.ts`
Expected: PASS

- [ ] **Step 6: Type check**

Run: `npx tsc --noEmit`

- [ ] **Step 7: Commit**

```
git add src/core/runtime-config.ts src/config.ts tests/runtime-config-optimizer.test.ts
git commit -m "feat: add optimizer RuntimeConfig keys with validators"
```

---

## Chunk 2: CandleService

### Task 3: CandleService — Coinbase API Fetcher + Synthetic Aggregator

**Files:**
- Create: `src/services/candles.ts`
- Test: `tests/candle-service.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/candle-service.test.ts` that verifies:
- `fetchCoinbaseCandles` parses Coinbase API response into Candle format (mock global fetch)
- `fetchCoinbaseCandles` returns empty array on API failure
- `recordSpotPrice` builds a synthetic candle (tracks open/high/low/close across multiple calls)
- `storeCandles` writes to DB and `getStoredCandles` reads them back

Mock `fetch` using `vi.stubGlobal('fetch', mockFetch)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/candle-service.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement CandleService**

Create `src/services/candles.ts` with:

**Candle interface:**
```typescript
export interface Candle {
  symbol: string;
  network: string;
  interval: '15m' | '1h' | '24h';
  openTime: string;
  open: number; high: number; low: number; close: number;
  volume: number;
  source: 'coinbase' | 'dex' | 'synthetic';
}
```

**CandleService class:**
- Constructor takes `network: string` and optional `coinbasePairs: string[]` (default: `['ETH-USD', 'CBBTC-USD', 'CBETH-USD']`)
- `fetchCoinbaseCandles(productId, interval, limit)` — calls Coinbase Advanced Trade API: `GET https://api.coinbase.com/api/v3/brokerage/market/products/{productId}/candles?start={}&end={}&granularity={}`. Granularity map: 15m→FIFTEEN_MINUTE, 1h→ONE_HOUR, 24h→ONE_DAY. Returns `Candle[]`, empty on error.
- `recordSpotPrice(symbol, network, price)` — tracks pending candle (open/high/low/close) in a Map keyed by `${symbol}:${network}`
- `getPendingSyntheticCandle(symbol, network)` — returns current pending candle state (for testing)
- `flushSyntheticCandles()` — flushes pending candles older than 15min with 2+ data points as synthetic candles to DB
- `storeCandles(candles)` — INSERT OR REPLACE to DB
- `getStoredCandles(symbol, network, interval, limit)` — reads from DB
- `pollCoinbaseCandles()` — fetches all pairs, all intervals, stores, and flushes synthetics
- `startPolling(intervalMs)` / `stopPolling()` — interval management
- `cleanupOldCandles()` — deletes candles beyond retention (15m: 7 days, 1h: 30 days, 24h: 365 days)

On Coinbase API failure: log warning, return empty array (fallback handled by caller).

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/candle-service.test.ts`
Expected: PASS

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```
git add src/services/candles.ts tests/candle-service.test.ts
git commit -m "feat: add CandleService with Coinbase API + synthetic candle aggregation"
```

---

## Chunk 3: CandleStrategy

### Task 4: CandleStrategy — RSI, MACD, Volume, Candle Pattern

**Files:**
- Create: `src/strategy/candle.ts`
- Test: `tests/candle-strategy.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/candle-strategy.test.ts` that verifies:

Helper: `makeCandles(closes, opts?)` — generates Candle array from close prices with optional volumes/highs/lows/opens.

`computeRSI` tests:
- Alternating up/down prices → RSI ~50 (between 40-60)
- Consistently rising prices (20 candles) → RSI > 70
- Consistently falling prices (20 candles) → RSI < 30

`computeMACD` tests:
- Rising prices → positive histogram

`CandleStrategy.evaluate` tests:
- Insufficient candles (<26) → hold with "Need" reason
- Strongly falling prices (30 candles, each -3) → buy signal with strength > 0
- Strongly rising prices (30 candles, each +3) → sell signal with strength > 0
- High volume on latest candle → strength >= low volume version

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/candle-strategy.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement CandleStrategy**

Create `src/strategy/candle.ts` with:

**Exported functions:**
- `computeRSI(closes: number[], period = 14): number` — Wilder's smoothing RSI
- `computeMACD(closes: number[], fast = 12, slow = 26, signalPeriod = 9)` — returns `{ macd, signal, histogram }`

**Helper:** `ema(values, period)` — exponential moving average

**CandleStrategy class:**
- `evaluate(candles: Candle[]): CandleSignal` — expects candles ordered oldest→newest
- Returns `{ signal, strength (0-100), reason }`
- Needs 26+ candles minimum (for MACD slow period)

**Signal logic:**
- RSI < 30 → buyScore += 40; RSI 30-40 → buyScore += 15; RSI > 70 → sellScore += 40; RSI 60-70 → sellScore += 15
- MACD histogram > 0 → buyScore += 25; < 0 → sellScore += 25
- Lower wick > 50% of range → buyScore += 15; Upper wick > 50% → sellScore += 15
- Volume > 1.5x average → +10 bonus to winning side
- Net score > 20 → buy; < -20 → sell; else hold
- Strength = min(100, abs(netScore) + volBonus)

**CandleSignal interface:**
```typescript
export interface CandleSignal {
  signal: 'buy' | 'sell' | 'hold';
  strength: number;
  reason: string;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/candle-strategy.test.ts`
Expected: PASS

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```
git add src/strategy/candle.ts tests/candle-strategy.test.ts
git commit -m "feat: add CandleStrategy with RSI, MACD, volume, candle pattern indicators"
```
