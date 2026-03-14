# Portfolio Optimizer — Design Spec

> **For agentic workers:** This is the design spec. Use `superpowers:writing-plans` to create an implementation plan from this spec.

**Goal:** Add a cross-asset portfolio optimization layer that monitors opportunity signals across all held, discovered, and watchlisted assets, autonomously rotating capital from weaker positions into stronger opportunities when the math (net gain after fees) checks out.

**Architecture:** Additive layer on top of the existing per-asset strategy loops. A new `CandleService` fetches OHLCV data from Coinbase Advanced Trade API, DEX aggregation, and snapshot synthesis. A new `CandleStrategy` produces multi-timeframe signals. The `PortfolioOptimizer` collects signals from all strategies, ranks assets by opportunity score, and emits rotation orders through a `RiskGuard` gate before reaching the `TradeExecutor`.

**Tech Stack:** TypeScript ESM, better-sqlite3, Coinbase Advanced Trade REST API (public, no auth), Chart.js (candlestick plugin), Telegraf, Express.

---

## 1. Core Concept: Opportunity Rotation

Each asset runs its own strategy signal independently (existing behaviour, unchanged). The optimizer is a **new layer on top** that:

1. Watches all signals simultaneously
2. Ranks assets by opportunity score
3. When a strong buy signal exists and a weak/negative position is held, evaluates whether rotating capital (selling the weak to buy the strong) produces a net gain after fees
4. Executes the rotation autonomously if the math clears all risk checks
5. Sends Telegram alerts after execution

The optimizer does NOT replace existing strategies — it coexists. Existing ThresholdStrategy and SMAStrategy loops continue to fire buy/sell signals for their individual assets. The optimizer adds cross-asset intelligence.

### USDC as Active Position

USDC is treated as a legitimate position, not just a transit currency. When all opportunity scores fall below `RISK_OFF_THRESHOLD` (default -10), the optimizer enters **risk-off mode**:

- Sells positions down to `MAX_CASH_PCT` (default 80%) of portfolio in USDC
- Stops evaluating buy signals until at least one asset's score crosses back above `RISK_ON_THRESHOLD` (default +15)
- Hysteresis gap between risk-off (-10) and risk-on (+15) prevents rapid flipping
- `MAX_CASH_PCT` prevents full liquidation — always maintains some market exposure

---

## 2. Data Layer

### 2.1 Candle Data Sources

Three sources, normalised into a unified OHLCV format:

**Source 1: Coinbase Advanced Trade API** (primary, highest fidelity)
- Endpoint: `GET /api/v3/brokerage/market/products/{product_id}/candles`
- Free, no API key required for public market data
- Provides 15m, 1hr, 24hr OHLCV candles with real volume
- Used for all assets with a Coinbase trading pair (ETH-USD, CBBTC-USD, CBETH-USD, etc.)
- Polled every 15 minutes for 15m candles; 1hr and 24hr on slower cadence

**Source 2: DEX Synthetic Candles** (for discovered ERC20 tokens)
- Collects spot prices from existing DefiLlama fetcher on each poll interval
- `SyntheticCandleAggregator` rolls spot prices into synthetic 15m candles (tracks open/high/low/close within window)
- Volume estimated from on-chain swap counts via Alchemy if available, otherwise 0
- Optimizer weights volume-less candles lower via confidence multiplier (0.7)

**Source 3: Snapshot Synthesis** (fallback)
- Aggregates existing `asset_snapshots` rows into crude candles
- Lowest fidelity — confidence multiplier 0.4
- Ensures every tracked asset has some candle data

### 2.2 New Database Tables

All tables in the existing `trades.db` file. Data disambiguated by `network` column — single DB, single volume mount.

```sql
CREATE TABLE IF NOT EXISTS candles (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol    TEXT NOT NULL,
  network   TEXT NOT NULL,
  interval  TEXT NOT NULL CHECK(interval IN ('15m', '1h', '24h')),
  open_time TEXT NOT NULL,
  open      REAL NOT NULL,
  high      REAL NOT NULL,
  low       REAL NOT NULL,
  close     REAL NOT NULL,
  volume    REAL NOT NULL DEFAULT 0,
  source    TEXT NOT NULL CHECK(source IN ('coinbase', 'dex', 'synthetic')),
  UNIQUE(symbol, network, interval, open_time)
);

CREATE TABLE IF NOT EXISTS watchlist (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL,
  network       TEXT NOT NULL,
  address       TEXT,
  source        TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual', 'trending', 'suggested')),
  added_at      TEXT NOT NULL DEFAULT (datetime('now')),
  status        TEXT NOT NULL DEFAULT 'watching' CHECK(status IN ('watching', 'promoted', 'removed')),
  coinbase_pair TEXT,
  UNIQUE(symbol, network)
);

CREATE TABLE IF NOT EXISTS rotations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp           TEXT NOT NULL DEFAULT (datetime('now')),
  sell_symbol         TEXT NOT NULL,
  buy_symbol          TEXT NOT NULL,
  sell_amount         REAL NOT NULL,
  buy_amount          REAL,
  sell_tx_hash        TEXT,
  buy_tx_hash         TEXT,
  estimated_gain_pct  REAL NOT NULL,
  actual_gain_pct     REAL,
  estimated_fee_pct   REAL NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending', 'leg1_done', 'executed', 'failed', 'vetoed')),
  veto_reason         TEXT,
  dry_run             INTEGER NOT NULL DEFAULT 0,
  network             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rotations_network_ts ON rotations(network, timestamp);

CREATE TABLE IF NOT EXISTS daily_pnl (
  date          TEXT NOT NULL,
  network       TEXT NOT NULL,
  high_water    REAL NOT NULL,
  current_usd   REAL NOT NULL,
  rotations     INTEGER NOT NULL DEFAULT 0,
  realized_pnl  REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (date, network)
);
```

### 2.3 Candle Data Retention

- 15m candles: keep 7 days (672 candles per asset)
- 1hr candles: keep 30 days (720 candles per asset)
- 24hr candles: keep 365 days
- Cleanup runs once daily via a scheduled function in the portfolio tracker
- Rotations and daily_pnl: keep indefinitely (small rows, valuable history)

---

## 3. New Components

### 3.1 CandleService (`src/services/candles.ts`)

Responsible for fetching, normalising, and storing OHLCV candle data from all three sources.

**Interface:**
```typescript
interface Candle {
  symbol: string;
  network: string;
  interval: '15m' | '1h' | '24h';
  openTime: string;       // ISO8601
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: 'coinbase' | 'dex' | 'synthetic';
}

class CandleService {
  // Fetch latest candles for a symbol from the best available source
  async fetchCandles(symbol: string, interval: '15m' | '1h' | '24h', limit: number): Promise<Candle[]>;

  // Get candles from DB (for strategy evaluation)
  getStoredCandles(symbol: string, network: string, interval: string, limit: number): Candle[];

  // Start periodic fetching for all tracked assets
  startPolling(): void;

  // Stop periodic fetching (for graceful shutdown / optimizer disable)
  stopPolling(): void;

  // Roll spot prices into synthetic candles (called by portfolio tracker)
  recordSpotPrice(symbol: string, network: string, price: number): void;
}
```

**Coinbase API details:**
- Base URL: `https://api.coinbase.com/api/v3/brokerage/market/products`
- Product IDs: `ETH-USD`, `CBBTC-USD`, `CBETH-USD`, etc.
- Granularity values: `FIFTEEN_MINUTE`, `ONE_HOUR`, `ONE_DAY`
- No authentication required for candle data
- Rate limit: 10 requests/second (generous — we'll use ~1 req/min)

**Failure handling:**
- If Coinbase API is unreachable or returns an error, log a warning and fall back to Source 2 (DEX synthetic) or Source 3 (snapshot synthesis) for that asset
- No retry — the next poll cycle will attempt Coinbase again
- If all three sources fail for an asset, that asset's candle data is stale; the optimizer uses the most recent stored candles but reduces confidence to 0.2

### 3.2 CandleStrategy (`src/strategy/candle.ts`)

Evaluates OHLCV candles to produce a signal with strength.

**Interface:**
```typescript
interface CandleSignal {
  signal: 'buy' | 'sell' | 'hold';
  strength: number;       // 0–100
  reason: string;
}

class CandleStrategy {
  // Evaluates a single-timeframe array of candles (e.g. 100 x 15m candles).
  // The optimizer calls this THREE times per asset — once per timeframe —
  // then combines the three CandleSignal results into the opportunity score.
  evaluate(candles: Candle[]): CandleSignal;
}
```

**Indicators:**
- **RSI(14)** on close prices — oversold (<30) = buy, overbought (>70) = sell
- **MACD(12,26,9)** — crossover direction confirms momentum
- **Volume trend** — current volume vs 20-period average. Above-average confirms signal; below-average weakens it
- **Candle body ratio** — large lower wick on down candle = buying pressure (bullish); large upper wick on up candle = selling pressure (bearish)

Deliberately simple — 4 well-understood indicators that complement each other. No exotic indicators that overfit.

### 3.3 PortfolioOptimizer (`src/trading/optimizer.ts`)

The brain of the system. Runs on its own interval (default 5 minutes).

**Each tick:**

**Step 1: Collect Opportunity Scores**

For every asset (registry + active discovered + watchlist), compute an opportunity score:

```typescript
interface OpportunityScore {
  symbol: string;
  score: number;           // -100 to +100
  confidence: number;      // 0–1
  signals: {
    candle15m: CandleSignal;
    candle1h: CandleSignal;
    candle24h: CandleSignal;
    legacy?: StrategyResult;  // from existing Threshold/SMA if available
  };
  currentWeight: number;   // % of portfolio
  isHeld: boolean;
}
```

Scoring formula:

Each timeframe's `CandleSignal` is converted to a signed score component:
```
direction = signal === 'buy' ? +1 : signal === 'sell' ? -1 : 0
component = direction * strength
```

Then combined with weights:
```
raw_score = (component_15m * 0.5) + (component_1h * 0.3) + (component_24h * 0.2)
score = raw_score * confidence
```

Where:
- `confidence` depends on candle data source: Coinbase = 1.0, DEX synthetic = 0.7, snapshot synthetic = 0.4
- Volume bonus: if latest candle volume > 1.5x 20-period average, add +10 to score (momentum confirmation)
- `hold` signals contribute 0 to their component (direction = 0)

**Legacy strategy integration:** The `legacy` field in `OpportunityScore.signals` is informational — it records the existing ThresholdStrategy/SMAStrategy result for that asset (if running) but does NOT affect the numeric score. This avoids double-counting since both the legacy strategy and the candle strategy see the same price data.

**Step 2: Rank and Identify Rotation Candidates**

Sort all assets by score. A rotation candidate pair requires:
- **Sell candidate**: held asset with score < `ROTATION_SELL_THRESHOLD` (default -20)
- **Buy candidate**: any asset with score > `ROTATION_BUY_THRESHOLD` (default +30)
- **Score delta**: buy score minus sell score > `MIN_ROTATION_SCORE_DELTA` (default 40)

**Step 3: Estimate Net Gain**

```
estimated_gain = (buy_opportunity_implied_move% - sell_opportunity_implied_move%) - estimated_fees
```

Fee estimation:
- Primary: Enso Router API quote endpoint (`GET /api/v1/shortcuts/route?...`) — returns estimated output amount, gas cost, and price impact without executing. Requires adding a `getEnsoQuote()` method to `CoinbaseTools` (read-only, no signing).
- Fallback: `DEFAULT_FEE_ESTIMATE_PCT` (configurable, default 1.0%) — used when Enso quote is unavailable or errors

Rotation proceeds only if `estimated_gain > MIN_ROTATION_GAIN_PCT` (default 2.0%).

**Step 4: Execute or Skip**

If rotation passes all checks (score delta, net gain, RiskGuard approval):
1. Leg 1: Sell A → USDC (wait for tx confirmation)
2. Leg 2: Buy B with USDC (only if Leg 1 succeeded)
3. Record rotation in `rotations` table
4. Emit Telegram alert

If Leg 1 succeeds but Leg 2 fails: hold USDC, log partial rotation, re-evaluate on next tick. No automatic retry.

**Risk-off mode:**

When all opportunity scores < `RISK_OFF_THRESHOLD` (default -10):
- Sell positions to `MAX_CASH_PCT` USDC
- Pause buy signal evaluation
- Re-enter when any asset score > `RISK_ON_THRESHOLD` (default +15)
- Hysteresis gap prevents rapid mode flipping

### 3.4 WatchlistManager (`src/portfolio/watchlist.ts`)

Manages assets the user wants to monitor without holding.

```typescript
class WatchlistManager {
  add(symbol: string, network: string, address?: string, coinbasePair?: string): void;
  remove(symbol: string, network: string): void;
  getAll(network: string): WatchlistRow[];
  promote(symbol: string, network: string): void;  // → discovered_assets with status 'active'
}
```

Watchlist assets:
- Get candle data fetched (by CandleService)
- Get opportunity scores computed (by PortfolioOptimizer)
- Do NOT get balance tracking
- Can be buy targets for rotation (optimizer promotes them automatically when a rotation executes)

**Promotion requirements:** `promote()` requires the watchlist entry to have a non-null `address`. For assets added manually by symbol only (address is null), the user must provide the contract address before promotion can occur (enforced at API/Telegram level). During promotion, the entry is inserted into `discovered_assets` with: address and network from watchlist, symbol from watchlist, name defaults to symbol, decimals defaults to 18 (updated on first Alchemy metadata fetch), strategy defaults to global `STRATEGY` config value.

### 3.5 RiskGuard (`src/trading/risk-guard.ts`)

Pure gate — can veto any trade, never initiates one.

**Veto checks (in order, first failure stops):**

1. **Portfolio floor** — `portfolio_usd < PORTFOLIO_FLOOR_USD` → halt ALL trading, Telegram alert, requires manual `/resume`
2. **Daily loss limit** — `(high_water - current_usd) / high_water * 100 > MAX_DAILY_LOSS_PCT` → pause autonomous trading, alert. Auto-resets at UTC midnight.
3. **Daily rotation count** — `daily_pnl.rotations >= MAX_DAILY_ROTATIONS` → veto rotation (individual trades still allowed). Resets at UTC midnight.
4. **Position size limit** — buy leg would cause target asset > `MAX_POSITION_PCT` of portfolio → reduce amount. If reduced amount falls below profitability threshold, veto entirely.
5. **Single rotation size** — rotation value > `MAX_ROTATION_PCT` of portfolio → cap it.
6. **Fee check** — estimated fees > expected gain → veto with reason.

**Audit trail:** Every decision logged to `bot_events` table:
```
event: 'risk_veto' | 'risk_approved' | 'risk_halt'
detail: JSON { rotation details, which check failed/passed, values at decision time }
```

---

## 4. New RuntimeConfig Keys

All live-reloadable via dashboard Settings modal. Persisted to `settings` DB table (survives restarts, repulls, container rebuilds). Env vars only set initial defaults.

| Key | Type | Default | Validation | Description |
|---|---|---|---|---|
| `MAX_POSITION_PCT` | number | 40 | 5–100 | Max % of portfolio in any single non-primary asset |
| `MAX_DAILY_LOSS_PCT` | number | 5 | 1–50 | Daily loss % that triggers trading pause |
| `MAX_ROTATION_PCT` | number | 25 | 5–100 | Max % of portfolio per single rotation |
| `MAX_DAILY_ROTATIONS` | number | 10 | 1–100 | Max rotations per 24hr window |
| `PORTFOLIO_FLOOR_USD` | number | 100 | 0–100000 | Absolute USD kill switch threshold |
| `MIN_ROTATION_GAIN_PCT` | number | 2 | 0.5–50 | Min net gain after fees to execute rotation |
| `MAX_CASH_PCT` | number | 80 | 10–100 | Max USDC % in risk-off mode |
| `OPTIMIZER_INTERVAL_SECONDS` | number | 300 | 30–3600 | Optimizer tick interval |
| `ROTATION_SELL_THRESHOLD` | number | -20 | -100–0 | Score below which held asset is sell candidate |
| `ROTATION_BUY_THRESHOLD` | number | 30 | 0–100 | Score above which asset is buy candidate |
| `MIN_ROTATION_SCORE_DELTA` | number | 40 | 10–200 | Min gap between sell and buy scores |
| `RISK_OFF_THRESHOLD` | number | -10 | -100–0 | All-asset score below which risk-off activates |
| `RISK_ON_THRESHOLD` | number | 15 | 0–100 | Score above which risk-off deactivates |
| `DEFAULT_FEE_ESTIMATE_PCT` | number | 1.0 | 0.1–10 | Fallback fee estimate when Enso quote unavailable |
| `DASHBOARD_THEME` | string | dark | light\|dark | Dashboard colour theme |

---

## 5. Modified Components

### 5.1 TradeExecutor (`src/trading/executor.ts`)

**New method:**
```typescript
async executeRotation(
  sellSymbol: string,
  buySymbol: string,
  sellAmount: number,
  rotationId: number,
): Promise<{ status: 'executed' | 'leg1_done' | 'failed'; sellTxHash?: string; buyTxHash?: string }>;
```

Two-leg execution with abort-on-failure between legs:
1. Execute sell (via `swap` or `ensoRoute` depending on asset)
2. Wait for tx confirmation
3. If sell succeeded, execute buy
4. If buy fails, log partial rotation, hold USDC
5. Update `rotations` table with final status and tx hashes

**Cooldown handling:** Rotations bypass `TRADE_COOLDOWN_SECONDS` between legs (leg 2 must execute immediately after leg 1). The cooldown timestamp is set once after the full rotation completes (or after leg 1 if leg 2 fails). This prevents the cooldown from blocking the second half of an in-progress rotation.

**DRY_RUN mode:** When `DRY_RUN` is true, both legs are simulated (no swap calls). The rotation is recorded in the `rotations` table with `dry_run = 1` and estimated amounts. This allows testing the optimizer's decision quality without real trades.

### 5.2 TradingEngine (`src/trading/engine.ts`)

- Add optimizer loop alongside existing strategy loops
- Optimizer runs on its own interval (`OPTIMIZER_INTERVAL_SECONDS`)
- Existing per-asset loops continue unchanged
- New method: `enableOptimizer()` / `disableOptimizer()` for Telegram `/optimizer on|off`

### 5.3 Portfolio Tracker (`src/portfolio/tracker.ts`)

- Feed spot prices to `CandleService.recordSpotPrice()` for synthetic candle aggregation
- Feed watchlist asset prices to `CandleService` as well

### 5.4 Web Server (`src/web/server.ts`)

**New API endpoints:**
- `GET /api/candles?symbol=ETH&interval=15m&limit=100` — candle data for charts
- `GET /api/scores` — current opportunity scores for all assets
- `GET /api/rotations?limit=20` — rotation history
- `GET /api/risk` — current risk status (daily P&L, rotation count, limits)
- `GET /api/watchlist` — watchlist assets
- `POST /api/watchlist` — add to watchlist `{ symbol, network, address?, coinbasePair? }`
- `DELETE /api/watchlist/:symbol` — remove from watchlist
- `POST /api/optimizer/toggle` — enable/disable optimizer `{ enabled: boolean }`

**Modified endpoints:**
- `GET /api/status` — add `optimizerEnabled`, `optimizerMode` ('normal' | 'risk-off'), `dailyPnl`, `rotationsToday`

### 5.5 Telegram Bot (`src/telegram/bot.ts`)

**New commands:**

| Command | Description |
|---|---|
| `/scores` | Current opportunity scores, ranked |
| `/rotations` | Last 5 rotations with gain/fee/status |
| `/watchlist` | List watched assets with scores |
| `/watch <symbol>` | Add to watchlist |
| `/unwatch <symbol>` | Remove from watchlist |
| `/risk` | Risk status (daily P&L, rotation count, limits) |
| `/killswitch` | Halt all trading immediately |
| `/optimizer on\|off` | Enable/disable optimizer |

**Automatic alerts:**
- Rotation executed (with gain and fee details)
- Rotation vetoed (with reason)
- Risk-off mode entered/exited
- Daily loss limit hit
- Portfolio floor breached
- Partial rotation (leg 1 success, leg 2 failure)

---

## 6. Dashboard Changes

### 6.1 Theme Support

- CSS custom properties for all colours (`--bg-primary`, `--text-primary`, etc.)
- Theme toggle in status bar (sun/moon icon)
- Preference persisted to `settings` DB table (key: `DASHBOARD_THEME`)
- Default: dark

| Token | Dark | Light |
|---|---|---|
| `--bg-primary` | `#0c0c14` | `#f8f9fb` |
| `--bg-card` | `#13132a` | `#ffffff` |
| `--bg-card-hover` | `#1a1a35` | `#f3f4f6` |
| `--border` | `rgba(255,255,255,0.05)` | `rgba(0,0,0,0.08)` |
| `--text-primary` | `#e2e8f0` | `#1a1a2e` |
| `--text-secondary` | `rgba(255,255,255,0.5)` | `rgba(0,0,0,0.5)` |
| `--text-muted` | `rgba(255,255,255,0.25)` | `rgba(0,0,0,0.3)` |
| `--green` | `#4ade80` | `#16a34a` |
| `--red` | `#f87171` | `#dc2626` |
| `--blue` | `#60a5fa` | `#2563eb` |
| `--yellow` | `#fbbf24` | `#d97706` |

### 6.2 Design Style

- Font: Inter / system sans-serif (not monospace)
- Subtle gradients on card backgrounds
- Rounded corners (12px)
- Softer colours with transparency
- Light font weights (400/500/600)

### 6.3 New Dashboard Panels

**Candlestick chart** (replaces existing line chart):
- Asset selector dropdown (ETH, CBBTC, CBETH, discovered tokens)
- Timeframe selector (15m / 1h / 24h)
- OHLCV candlesticks with volume bars below
- Indicator readouts: RSI(14), MACD direction, volume vs average, opportunity score
- Uses Chart.js with `chartjs-chart-financial` plugin for candlestick rendering

**Opportunity Scores panel:**
- Ranked list of all assets (held + watchlist)
- Visual score bars (-100 to +100, red to green gradient)
- Per-timeframe signal breakdown (15m/1h/24h)
- Watchlist items tagged with blue "watchlist" pill
- Click to view that asset's candle chart

**Enhanced Holdings table:**
- New columns: portfolio Weight % (with visual bar), opportunity Score
- Weight bars colour-coded by size

**Rotation Log:**
- Chronological feed of executed and vetoed rotations
- Shows: pair, gain %, fees, status, timestamp
- Green left border for executed, red for vetoed
- Click to expand full details

**Risk Monitor bar:**
- Daily P&L with progress bar toward limit
- Rotation count (today / max) with progress bar
- Max position (current largest)
- Portfolio floor (current value vs kill switch)
- Optimizer status (Active / Risk-Off / Disabled)

**Settings modal — new "Portfolio Optimizer" section:**
- All new RuntimeConfig keys grouped under a collapsible section
- Same input validation and live-save pattern as existing settings

---

## 7. File Structure (New / Modified)

### New Files
| File | Purpose |
|---|---|
| `src/services/candles.ts` | CandleService — fetch, normalise, store OHLCV from 3 sources |
| `src/strategy/candle.ts` | CandleStrategy — RSI, MACD, volume, candle pattern indicators |
| `src/trading/optimizer.ts` | PortfolioOptimizer — scoring, ranking, rotation decisions |
| `src/trading/risk-guard.ts` | RiskGuard — pure veto gate for all trades |
| `src/portfolio/watchlist.ts` | WatchlistManager — external asset tracking |
| `tests/candle-service.test.ts` | CandleService unit tests |
| `tests/candle-strategy.test.ts` | CandleStrategy unit tests |
| `tests/optimizer.test.ts` | PortfolioOptimizer unit tests |
| `tests/risk-guard.test.ts` | RiskGuard unit tests |
| `tests/watchlist.test.ts` | WatchlistManager unit tests |

### Modified Files
| File | Changes |
|---|---|
| `src/data/db.ts` | New table DDL (candles, watchlist, rotations, daily_pnl), new prepared statements |
| `src/core/runtime-config.ts` | New config keys added to: `ConfigKey` type union, `ALL_KEYS` set, `VALIDATORS` record, `coerce()` numeric keys list. None are read-only. |
| `src/config.ts` | Default values for new config keys |
| `src/trading/executor.ts` | New `executeRotation()` method |
| `src/trading/engine.ts` | Optimizer loop integration, enable/disable optimizer |
| `src/portfolio/tracker.ts` | Feed spot prices to CandleService |
| `src/web/server.ts` | New API endpoints, theme endpoint |
| `src/web/public/index.html` | Full dashboard redesign (themes, candle chart, new panels) |
| `src/telegram/bot.ts` | New commands, rotation alerts |
| `src/index.ts` | Wire CandleService, PortfolioOptimizer, RiskGuard into startup |

---

## 8. Conventions (carried from existing codebase)

- TypeScript ESM — all imports use `.js` extensions even for `.ts` source files
- `better-sqlite3` is synchronous — never `await` DB calls
- DB migration: `CREATE TABLE IF NOT EXISTS` — never drop existing tables
- MCP calls are live network I/O — always mock in tests
- `botState` is a singleton from `src/core/state.ts` — do not instantiate it
- `runtimeConfig.get('KEY')` for live-reloadable settings; `config.KEY` for boot-time-only config
- New config keys persisted to `settings` table — env vars set initial defaults only
- Ports must be env vars — never hardcode
- All new tables include `network` column for multi-chain disambiguation
- Single SQLite DB (`trades.db`), single Docker volume mount

---

## 9. Security Considerations

- **No API keys required** for Coinbase candle data (public endpoint)
- **Enso quote API** is read-only (fee estimation) — no signing authority
- **RiskGuard is non-bypassable** — every trade/rotation passes through it
- **Portfolio floor is absolute** — cannot be disabled, only adjusted
- **Kill switch** (`/killswitch`) requires manual `/resume` — no auto-recovery
- **Rotation abort-on-failure** — partial rotations hold USDC, never retry automatically
- **All risk decisions audited** in `bot_events` table
- **Telegram commands respect existing `TELEGRAM_ALLOWED_CHAT_IDS`** — no new auth surface

---

## 10. Monitoring and Observability

- **Dashboard Risk Monitor** — real-time view of all risk limits and current values
- **Rotation Log** — full history of every rotation (executed, vetoed, failed, partial)
- **bot_events table** — every RiskGuard decision with JSON detail
- **Telegram alerts** — pushed for all significant events (rotations, risk limits, mode changes)
- **Opportunity Scores** — visible in dashboard and via `/scores` command
- **Candle data health** — CandleService logs source used per asset; dashboard could show data freshness
- **daily_pnl table** — historical P&L tracking for performance analysis
