# Coinbase Trade Bot — Profit & Code Quality Improvement Spec

**Date:** 2026-03-31
**Author:** Claude Sonnet 4.6 (automated analysis)
**Status:** Ready for review
**Scope:** Full codebase audit + trading strategy overhaul

---

## 1. Architecture Overview

The bot is a TypeScript/Node.js process running on Base chain via Coinbase CDP/AgentKit. It connects to an MCP server at `192.168.68.139:3002` for onchain operations (swaps, balance queries).

**Runtime loop:**
1. **Portfolio tracker** polls balances every `POLL_INTERVAL_SECONDS` (30s) and updates `botState`
2. **Per-asset strategy loops** tick every `TRADE_INTERVAL_SECONDS` (60s) — each asset runs its own Threshold/SMA/Grid strategy
3. **Portfolio optimizer** ticks every `OPTIMIZER_INTERVAL_SECONDS` (300s) — scores all assets using CandleStrategy (RSI/MACD/BB across 15m/1h/24h), identifies rotation candidates, executes via `executeRotation`
4. **Web server** (port 8080) exposes dashboard + REST API; **Telegram bot** relays alerts

**Key files:**
| File | Role |
|------|------|
| `src/trading/engine.ts` | Orchestrates all loops, starts/stops strategies |
| `src/trading/optimizer.ts` | Portfolio rotation scoring and execution |
| `src/trading/executor.ts` | All trade execution (swap, rotation, manual) |
| `src/trading/risk-guard.ts` | Pre-trade risk checks (portfolio/rotation only) |
| `src/strategy/candle.ts` | RSI + MACD + Bollinger scoring, shared indicators |
| `src/strategy/threshold.ts` | Simple drop-buy/rise-sell strategy |
| `src/strategy/sma.ts` | SMA/EMA crossover with volume + RSI filters |
| `src/strategy/grid.ts` | Price-grid level trading |
| `src/config.ts` | Zod env schema with all tunable parameters |
| `src/data/schema.ts` | SQLite schema (trades, candles, rotations, daily_pnl) |

---

## 2. Root Cause Analysis — Why the Bot Loses Money Daily

### 2.1 Fee Gate Is Effectively Disabled

**File:** `src/trading/optimizer.ts:268`, `src/trading/risk-guard.ts:78`

`estimatedGainPct` is calculated as the raw score delta between two assets (a number in the 0–200 range), then compared against `estimatedFeePct` (which is `DEFAULT_FEE_ESTIMATE_PCT = 1.0`). The comparison `if (fees >= gain)` uses a score-point delta against a percentage — they are not the same unit.

A delta of 40 passes the fee check because `40 >= 1.0` is false. But 40 score points does **not** mean 40% expected gain. The actual gain is completely unquantified.

**Real cost per rotation:** ~1–2% in DEX fees + 0.5–1% slippage = 1.5–3% loss before any market movement benefit. With 3–5 rotations/day this is 5–15% daily portfolio erosion.

### 2.2 Realized P&L is Never Tracked

**File:** `src/trading/optimizer.ts` (upsertDailyPnl call)

`realized_pnl` is always written as `0`. The `daily_pnl` table tracks `high_water` and `current_usd` but never computes or stores the actual P&L from completed trades. The RiskGuard's daily loss check works off portfolio value changes (high_water vs current_usd), which is correct — but no trade-level P&L is ever attributed, making it impossible to see which rotations lost/gained money.

### 2.3 Rotation Leg 2 Uses Stale Balance (Race Condition)

**File:** `src/trading/executor.ts:204–216`

After leg 1 (sell asset → USDC) succeeds, leg 2 reads `botState.lastUsdcBalance` to size the buy. This balance is updated by the tracker on a polling interval — not after the swap. If pre-swap USDC was 0, leg 2 buys nothing, leaving the portfolio stranded in USDC indefinitely.

### 2.4 ThresholdStrategy Resets Entry on Every Buy (Downtrend Death Spiral)

**File:** `src/strategy/threshold.ts:34`

When a buy fires, `this.entryPrice = current`. In a sustained downtrend, each new low triggers another buy with a fresh entry price, resetting the profit target downward. With `maxConsecutiveBuys = 3`, the strategy can average down 3× with no stop-loss — capturing the full downside of a move.

### 2.5 Non-ETH/USDC Assets Priced at $0

**File:** `src/trading/optimizer.ts:269–272`

```ts
sellUsdValue = balance * (symbol === 'USDC' ? 1 : symbol === 'ETH' ? price : 0)
```

CBBTC, CBETH, and discovered tokens all get `sellUsdValue = 0`. The optimizer can never propose rotating *out of* these assets, making multi-asset portfolio management non-functional.

### 2.6 Grid Bounds Always Fall Back to ±5%

**File:** `src/trading/engine.ts:153–154`

Engine passes `() => null` for the candle high/low callbacks. Grid strategy auto-bounds therefore always use the fallback `currentPrice * 1.05 / 0.95`. Real 24h volatility data is available in the candle DB but never used for grid sizing.

### 2.7 executeForAsset Bypasses All Risk Guards

**File:** `src/trading/executor.ts:77–111`

Per-asset strategy signals (Threshold, SMA, Grid) execute via `executeForAsset`, which has zero RiskGuard checks — no portfolio floor, no daily loss limit, no position size cap. Only optimizer rotations go through risk checks. A strategy can trade an asset to zero without triggering any safety mechanism.

---

## 3. Code Quality Issues

### Critical
| ID | File | Issue |
|----|------|-------|
| C1 | `src/web/server.ts` | No authentication on mutating API endpoints — anyone on the network can execute trades |
| C2 | `src/web/server.ts:162` | Enso route accepts arbitrary token addresses with no allowlist |
| C3 | `src/trading/executor.ts:77` | `executeForAsset` bypasses RiskGuard and pause check |

### High
| ID | File | Issue |
|----|------|-------|
| H1 | `src/trading/executor.ts:204` | Rotation leg 2 uses stale USDC balance — race condition |
| H2 | `src/trading/optimizer.ts:269` | Non-ETH/USDC assets scored with $0 sell value |
| H3 | `src/web/public/index.html` | XSS via unescaped server error messages in dashboard |
| H4 | `src/strategy/grid.ts` | Division-by-zero when upper bound equals lower bound |
| H5 | `src/data/db.ts` | No DB transactions — concurrent writes can corrupt grid/pnl state |

### Medium
| ID | File | Issue |
|----|------|-------|
| M1 | `src/strategy/threshold.ts:34` | Entry price resets on every buy — no stop-loss, downtrend death spiral |
| M2 | `src/trading/executor.ts:77` | `executeForAsset` does not record trades in DB — P&L calculations miss them |
| M3 | `src/trading/executor.ts:108` | `swap` call has no try/catch — silent crash risk in asset loop |
| M4 | `src/trading/optimizer.ts:268` | `estimatedGainPct` is score delta, not a percentage |
| M5 | `src/mcp/tools.ts` | MCP client has no timeout on tool calls |
| M6 | `src/web/server.ts` | `DRY_RUN` can be toggled via unauthenticated API |

### Low
| ID | File | Issue |
|----|------|-------|
| L1 | `src/trading/engine.ts:153` | Grid strategy candle callbacks always return null |
| L2 | `src/strategy/candle.ts` | `computeRSI` returns 50 on insufficient data (neutral, not an error) |
| L3 | `src/web/server.ts` | Watchlist accepts arbitrary symbols without validation |
| L4 | `src/portfolio/tracker.ts` | `portfolio_usd` written as 0 for ETH snapshots |

### Simplification / Duplication
| ID | Files | Issue |
|----|-------|-------|
| S1 | `src/strategy/candle.ts`, `src/strategy/sma.ts` | EMA function duplicated — candle.ts has `ema()`, sma.ts has its own `ema()`. Both are identical. |
| S2 | `src/trading/executor.ts` | Cooldown check block copy-pasted verbatim in `executeEnso` and `executeManual` |
| S3 | `src/trading/optimizer.ts` | Portfolio USD summation loop duplicated twice in `run()` |
| S4 | `src/trading/engine.ts:153` | `getCandleHigh24h`/`getCandleLow24h` passed as `() => null` — dead parameter pattern |

---

## 4. Improvements — Prioritised List

### Category: Fee & Profitability (Highest Impact)

#### F1. Fix Fee Gate Unit Mismatch ★★★ [Easy]
Convert `estimatedGainPct` to an actual percentage estimate before comparing to fees. Use a conservative mapping: `estimatedGainPct = (scoreDelta / 100) * historicalVolatility * 0.3`. Until backtested data exists, require the score delta to be at least `MIN_ROTATION_SCORE_DELTA * 2` AND `estimatedGainPct >= estimatedFeePct * 2.0` (require 2× margin above fees).

**Expected benefit:** Eliminates ~70% of loss-making rotations immediately.

#### F2. Accurate Round-Trip Fee Calculation ★★★ [Easy]
Current `DEFAULT_FEE_ESTIMATE_PCT = 1.0` covers one leg only. A rotation is two swaps (sell → USDC, then buy). Set default to `2.0` (or sum actual Coinbase swap fees from transaction receipts when available). Add a `slippageBufferPct` config (default `0.5`) that is added on top.

**Expected benefit:** RiskGuard fee comparison now reflects real costs.

#### F3. Realized P&L Per Trade ★★★ [Medium]
Record entry price and exit price for every trade. When a sell executes, compute `realizedPnl = (exitPrice - entryPrice) * amount - fees`. Store in trades table. Aggregate to `daily_pnl.realized_pnl`. Surface on dashboard. Use cumulative realized P&L to detect systematic strategy losses and trigger automatic strategy parameter re-evaluation.

**Expected benefit:** Visibility into which strategies and assets are actually profitable.

#### F4. Minimum Absolute Profit Threshold ★★ [Easy]
Add `MIN_ROTATION_PROFIT_USD` config (default: `$2.00`). Reject any rotation where `estimatedGainPct * sellAmount / 100 < MIN_ROTATION_PROFIT_USD`. This prevents micro-trades where fees consume all profit regardless of percentage.

---

### Category: Risk Management

#### R1. Add Stop-Loss to ThresholdStrategy ★★★ [Easy]
Add `STOP_LOSS_PCT` config (default: `5.0`). When price drops more than `STOP_LOSS_PCT` below the *original* entry price (not the reset entry), emit `sell` regardless of current target. Reset state. This prevents the death spiral.

#### R2. Apply RiskGuard to executeForAsset ★★★ [Easy]
Call `this.riskGuard.checkAssetTrade(symbol, amount, portfolioUsd)` at the top of `executeForAsset`. Minimum checks: portfolio floor, daily loss limit, max position size. This brings per-asset trades under the same safety envelope as rotations.

#### R3. Trailing Stop-Loss for Profitable Positions ★★ [Medium]
Track peak price since entry for each held asset. If price drops more than `TRAILING_STOP_PCT` (default: `3.0`) from the peak, emit sell. This locks in gains without requiring a fixed target — lets winners run further while protecting downside.

#### R4. Volatility-Adjusted Position Sizing ★★ [Medium]
Currently position size is a fixed % of balance. Replace with ATR-based sizing: `positionSize = (riskPerTrade / ATR14) * price`. This naturally reduces size in high-volatility periods (when losses are larger) and increases it when conditions are calm.

#### R5. Maximum Drawdown Circuit Breaker ★★★ [Easy]
If portfolio drops >X% from its all-time high within the session, pause all trading and send Telegram alert. Different from daily loss limit — this catches multi-day drawdown that daily resets miss. Config: `MAX_DRAWDOWN_PCT` (default: `15`). Store session high-water in DB.

---

### Category: Strategy Quality

#### S1. Trend Filter — Only Trade With Momentum ★★★ [Medium]
Add a macro trend filter using 200-period EMA on 1h candles. Only allow buys when price > EMA200 (uptrend). Only allow shorts/sells when price < EMA200 (downtrend). This prevents the bot from buying into sustained bear trends, which is the primary loss mode for Threshold strategy.

#### S2. Fix Threshold Entry Price Averaging ★★ [Easy]
Instead of resetting `entryPrice` to current on each buy, compute a volume-weighted average entry: `newEntry = (prevEntry * prevQty + currentPrice * newQty) / totalQty`. Exit target is then based on average cost, not last buy price. Much more realistic P&L targeting.

#### S3. Fix Non-ETH Asset Pricing in Optimizer ★★★ [Easy]
Replace the `symbol === 'ETH' ? price : 0` fallback with a price lookup from `candleService.getStoredCandles(symbol, network, '15m', 1)[0]?.close ?? 0`. This immediately enables multi-asset rotation for CBBTC and CBETH.

#### S4. Wire Real Candle Data to Grid Bounds ★★ [Easy]
In `engine.ts`, replace `() => null` with actual candle queries:
```ts
getCandleHigh24h: () => candleService.getStoredCandles(symbol, network, '24h', 1)[0]?.high ?? null,
getCandleLow24h:  () => candleService.getStoredCandles(symbol, network, '24h', 1)[0]?.low ?? null,
```
Grid bounds will now reflect actual daily range instead of an arbitrary ±5%.

#### S5. Confidence-Weighted Score Threshold ★★ [Medium]
Current rotation threshold (`MIN_ROTATION_SCORE_DELTA = 40`) ignores signal confidence. A score of 40 with `confidence = 0.4` (synthetic candles) should require a higher delta than a score of 40 with `confidence = 1.0` (Coinbase candles). Adjust: `effectiveDelta = delta * confidence`. Only rotate when `effectiveDelta >= MIN_ROTATION_SCORE_DELTA`.

#### S6. Rotation Frequency Throttle with Cool-Off ★★ [Easy]
Add `MIN_HOURS_BETWEEN_SAME_PAIR_ROTATION` config (default: `4`). After rotating A→B, prevent rotating back B→A for at least 4 hours. This prevents the optimizer from oscillating between two assets and paying fees twice.

#### S7. Paper Trading Mode with Simulated P&L ★ [Hard]
Implement a shadow execution mode where trades are simulated with realistic slippage and fees applied to a virtual portfolio. Run paper trading in parallel with live trading to measure strategy performance before committing capital. Log simulated vs actual trades.

---

### Category: Infrastructure & Correctness

#### I1. Fix Rotation Leg 2 Stale Balance ★★★ [Easy]
After leg 1 succeeds, call `await this.tools.getBalance('USDC')` to fetch fresh balance before sizing leg 2. Use the returned value instead of `botState.lastUsdcBalance`.

#### I2. Record All Trades from executeForAsset ★★★ [Easy]
Add `this.recordTrade(...)` call after the swap in `executeForAsset`. Match the shape of `execute()`. Without this, per-asset trades are invisible to the dashboard and P&L calculations.

#### I3. Wrap Critical DB Operations in Transactions ★★ [Easy]
Wrap grid state flip + trade record in a single `db.transaction()`. Wrap optimizer's `upsertDailyPnl` + rotation status update. This prevents half-written state on crashes.

#### I4. Deduplicate EMA Implementation ★ [Easy]
Move `ema()` to `src/strategy/indicators.ts`. Import from there in both `candle.ts` and `sma.ts`. Remove duplicate. Also move `computeRSI`, `computeMACD`, `computeBollingerBands` to the shared file — they are utility functions, not strategy-specific.

#### I5. Cooldown Extraction ★ [Easy]
Extract the cooldown check from `executeEnso` and `executeManual` into a private `checkCooldown()` method. Two identical blocks → one call.

#### I6. Add Error Handling to executeForAsset ★★ [Easy]
Wrap the `swap` call in a try/catch. On failure, log the error and return early. In the engine's asset loop, use `.catch(err => logger.error(...))` on the async tick call to prevent silent process crashes.

#### I7. Fix Grid Division-by-Zero ★★ [Easy]
Add guard in `grid.ts` `initializeLevels`: `if (this.upperBound <= this.lowerBound || this.gridLevelCount < 2) { logger.warn('Grid: invalid bounds, skipping init'); return; }`.

---

## 5. Recommended Configuration Changes

Once code fixes are applied, update `.env` / runtime config:

| Parameter | Current Default | Recommended | Reason |
|-----------|----------------|-------------|--------|
| `DEFAULT_FEE_ESTIMATE_PCT` | `1.0` | `2.0` | Covers both rotation legs |
| `MIN_ROTATION_SCORE_DELTA` | `40` | `60` | Raise bar until fee gate is properly calibrated |
| `MAX_DAILY_ROTATIONS` | `10` | `4` | Reduce churn while fee math is being fixed |
| `TRADE_COOLDOWN_SECONDS` | `300` | `600` | Less frequent per-asset trading |
| `PRICE_DROP_THRESHOLD_PCT` | `2.0` | `3.0` | Reduce noise triggers |
| `PRICE_RISE_TARGET_PCT` | `3.0` | `4.5` | Must exceed round-trip fees with margin |
| `MAX_POSITION_PCT` | `40` | `30` | Reduce concentration risk |
| `PORTFOLIO_FLOOR_USD` | `100` | `150` | Earlier safety halt |

---

## 6. What NOT to Change (Yet)

- **Don't add new strategies** until P&L tracking is working. You can't evaluate what you can't measure.
- **Don't increase rotation frequency** until the fee gate is fixed. More trades = more losses until fee math is right.
- **Don't enable Grid strategy on new assets** until `getCandleHigh/Low24h` is wired to real data.
- **Don't add ML/AI scoring** until a paper trading backtester exists to evaluate it.
