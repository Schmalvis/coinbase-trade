# Coinbase Trade Bot — Profit Improvement Implementation Plan

**Date:** 2026-03-31
**Spec:** `docs/superpowers/specs/2026-03-31-profit-improvement-spec.md`
**Strategy:** Fix the money-losing bugs first, then improve strategy quality, then infrastructure polish.

---

## Guiding Principle

> **Measure before you optimise.** The first two phases are purely defensive — stop the active haemorrhage. Phase 3 adds strategy improvements. Phase 4 adds infrastructure. Nothing gets added until you can measure whether it's working.

---

## Phase 1 — Stop the Bleeding (Do This First)

These are the changes that will have the most immediate impact on daily losses. Each is isolated and low-risk. Target: complete before re-enabling live trading.

**Estimated effort: 2–4 hours of focused implementation.**

---

### Task 1.1 — Fix the fee gate unit mismatch

**File:** `src/trading/optimizer.ts`
**Spec ref:** F1, F2, M4

The `estimatedGainPct` field is set to a raw score delta (40–200 range) and compared against `estimatedFeePct` (1.0). They are not the same unit. The check passes for every rotation.

**Changes:**

1. In `optimizer.ts`, change the rotation proposal construction:
   ```ts
   // Before:
   estimatedGainPct: candidate.buy.score - candidate.sell.score,
   estimatedFeePct: config.DEFAULT_FEE_ESTIMATE_PCT,

   // After:
   // Convert score delta to a conservative estimated gain percentage.
   // Score range is -100 to +100; assume 1 score point ≈ 0.02% edge (very conservative).
   // This mapping should be recalibrated once realized P&L data exists.
   const rawDelta = candidate.buy.score - candidate.sell.score;
   const estimatedGainPct = rawDelta * 0.02;        // e.g. score delta 50 → 1.0% expected gain
   const estimatedFeePct = config.DEFAULT_FEE_ESTIMATE_PCT * 2; // both legs
   ```

2. In `config.ts`, update `DEFAULT_FEE_ESTIMATE_PCT` default from `1.0` to `2.0` (covers both swap legs).

3. In `risk-guard.ts:78`, tighten the fee check to require a profit margin:
   ```ts
   // Before:
   if (proposal.estimatedFeePct >= proposal.estimatedGainPct)

   // After:
   // Require gain to be at least 1.5× fees (50% profit margin above cost)
   if (proposal.estimatedGainPct < proposal.estimatedFeePct * 1.5)
   ```

4. Add `MIN_ROTATION_PROFIT_USD` to config schema (default: `2.0`). Add check in `risk-guard.ts`:
   ```ts
   const minProfitUsd = this.runtimeConfig.get('MIN_ROTATION_PROFIT_USD') as number;
   const estimatedProfitUsd = (proposal.estimatedGainPct / 100) * proposal.sellAmount;
   if (estimatedProfitUsd < minProfitUsd) {
     return { approved: false, vetoReason: `Estimated profit $${estimatedProfitUsd.toFixed(2)} < minimum $${minProfitUsd}` };
   }
   ```

**Test:** `tests/risk-guard.test.ts` — add cases for the new profit margin check and minimum USD threshold.

---

### Task 1.2 — Fix rotation leg 2 stale balance

**File:** `src/trading/executor.ts:204–216`
**Spec ref:** H1

After leg 1 succeeds, fetch fresh USDC balance before sizing leg 2.

```ts
// After leg 1 succeeds:
// OLD: const usdcAvailable = botState.lastUsdcBalance * 0.95;
// NEW:
let freshUsdc: number;
try {
  const balanceResult = await this.tools.getBalance('USDC');
  freshUsdc = parseFloat(balanceResult.balance ?? '0');
} catch {
  freshUsdc = botState.lastUsdcBalance; // fallback to stale value, log warning
  logger.warn('executeRotation: could not fetch fresh USDC balance, using stale value');
}
const usdcAvailable = freshUsdc * 0.95;
```

---

### Task 1.3 — Record trades from executeForAsset

**File:** `src/trading/executor.ts:77–111`
**Spec ref:** M2

Add `this.recordTrade(...)` at the end of `executeForAsset` after a successful swap. Match the shape used in `execute()`. Without this, per-asset trades are invisible to P&L calculations and the dashboard.

```ts
this.recordTrade({
  signal,
  amountEth,
  price: botState.lastPrice ?? 0,
  txHash,
  triggeredBy: `strategy:${symbol}`,
  status: 'executed',
  dryRun,
  reason: `${symbol} ${signal} via ${strategy ?? 'unknown'}`,
});
```

---

### Task 1.4 — Add stop-loss to ThresholdStrategy

**File:** `src/strategy/threshold.ts`
**Spec ref:** R1, M1

Add `STOP_LOSS_PCT` config key (default: `5.0`). Track `originalEntryPrice` separately from the reset `entryPrice`.

```ts
private originalEntryPrice: number | null = null;

// In evaluate(), when first buy fires:
if (this.originalEntryPrice === null) this.originalEntryPrice = current;

// Add stop-loss check before existing logic:
const stopLossPct = this.opts?.stopLossPct ?? config.STOP_LOSS_PCT;
if (this.originalEntryPrice !== null) {
  const drawdownPct = ((this.originalEntryPrice - current) / this.originalEntryPrice) * 100;
  if (drawdownPct >= stopLossPct) {
    this.entryPrice = null;
    this.originalEntryPrice = null;
    this.consecutiveBuys = 0;
    return { signal: 'sell', reason: `Stop-loss triggered: ${drawdownPct.toFixed(2)}% drawdown from original entry` };
  }
}

// On sell (profit target hit), reset originalEntryPrice too:
this.originalEntryPrice = null;
```

Add `STOP_LOSS_PCT: z.coerce.number().default(5.0)` to config schema.

---

### Task 1.5 — Apply RiskGuard to executeForAsset

**File:** `src/trading/executor.ts:77`, `src/trading/risk-guard.ts`
**Spec ref:** C3, R2

Add a lightweight asset trade check to `executeForAsset`. The existing `checkRotation` takes a full rotation proposal — add a simpler `checkAssetTrade` method to `RiskGuard`:

```ts
// risk-guard.ts — new method:
checkAssetTrade(symbol: string, amountUsd: number, portfolioUsd: number, network: string): RiskDecision {
  // 1. Portfolio floor check (same as rotation)
  const floor = this.runtimeConfig.get('PORTFOLIO_FLOOR_USD') as number;
  if (portfolioUsd < floor) {
    botState.setStatus('paused');
    return { approved: false, vetoReason: `Portfolio floor breached` };
  }

  // 2. Daily loss check (same as rotation)
  const maxLossPct = this.runtimeConfig.get('MAX_DAILY_LOSS_PCT') as number;
  const todayPnl = dailyPnlQueries.getTodayPnl.get(network) as any;
  if (todayPnl?.high_water > 0) {
    const lossPct = ((todayPnl.high_water - portfolioUsd) / todayPnl.high_water) * 100;
    if (lossPct > maxLossPct) {
      botState.setStatus('paused');
      return { approved: false, vetoReason: `Daily loss limit exceeded` };
    }
  }

  // 3. Max position size check
  const maxPosPct = this.runtimeConfig.get('MAX_POSITION_PCT') as number;
  const positionPct = (amountUsd / portfolioUsd) * 100;
  if (positionPct > maxPosPct) {
    return { approved: false, adjustedAmount: portfolioUsd * maxPosPct / 100, vetoReason: `Position size reduced to ${maxPosPct}%` };
  }

  return { approved: true };
}
```

Call at top of `executeForAsset` with `isPaused` check:
```ts
if (botState.isPaused) return { signal: 'hold', reason: 'Bot is paused' };
const riskCheck = this.riskGuard.checkAssetTrade(symbol, amountUsd, portfolioUsd, network);
if (!riskCheck.approved) {
  logger.warn(`executeForAsset risk veto for ${symbol}: ${riskCheck.vetoReason}`);
  return;
}
```

---

### Task 1.6 — Fix non-ETH asset pricing in optimizer

**File:** `src/trading/optimizer.ts:269–272`
**Spec ref:** H2, S3

Replace the hardcoded price lookup:

```ts
// Before:
sellUsdValue = balance * (symbol === 'USDC' ? 1 : symbol === 'ETH' ? price : 0)

// After:
let assetPrice: number;
if (symbol === 'USDC') {
  assetPrice = 1;
} else if (symbol === 'ETH') {
  assetPrice = botState.lastPrice ?? 0;
} else {
  // Look up latest close from candle service for any other asset
  const recentCandles = this.candleService.getStoredCandles(symbol, network, '15m', 1);
  assetPrice = recentCandles.length > 0 ? recentCandles[0].close : 0;
}
sellUsdValue = balance * assetPrice;
```

---

### Task 1.7 — Raise config defaults

**File:** `src/config.ts`
**Spec ref:** Section 5

Update defaults in the Zod schema:

```ts
MIN_ROTATION_SCORE_DELTA: z.coerce.number().default(60),   // was 40
MAX_DAILY_ROTATIONS: z.coerce.number().default(4),          // was 10
TRADE_COOLDOWN_SECONDS: z.coerce.number().default(600),     // was 300
PRICE_DROP_THRESHOLD_PCT: z.coerce.number().default(3.0),   // was 2.0
PRICE_RISE_TARGET_PCT: z.coerce.number().default(4.5),      // was 3.0
MAX_POSITION_PCT: z.coerce.number().default(30),            // was 40
PORTFOLIO_FLOOR_USD: z.coerce.number().default(150),        // was 100
DEFAULT_FEE_ESTIMATE_PCT: z.coerce.number().default(2.0),   // was 1.0
```

Add new keys:
```ts
STOP_LOSS_PCT: z.coerce.number().default(5.0),
TRAILING_STOP_PCT: z.coerce.number().default(3.0),
MIN_ROTATION_PROFIT_USD: z.coerce.number().default(2.0),
MIN_HOURS_BETWEEN_SAME_PAIR: z.coerce.number().default(4),
MAX_DRAWDOWN_PCT: z.coerce.number().default(15),
```

---

## Phase 2 — P&L Visibility (Measure What's Happening)

Do this immediately after Phase 1. You need this data to evaluate whether any strategy is worth keeping.

**Estimated effort: 2–3 hours.**

---

### Task 2.1 — Realized P&L per trade

**Files:** `src/data/schema.ts`, `src/trading/executor.ts`, `src/trading/optimizer.ts`
**Spec ref:** F3

1. Add `entry_price REAL` and `realized_pnl REAL` columns to the `trades` table (migration via `try { ALTER TABLE }` pattern).

2. In `recordTrade`, accept an optional `entryPrice` parameter. If the signal is `'sell'`, compute `realizedPnl = (price - entryPrice) * amountEth - feeEstimate`.

3. To track entry price: when a buy trade is recorded, store it in an in-memory map `this.openPositions.set(symbol, { price, qty })`. When a sell fires, retrieve it.

4. In the optimizer's `upsertDailyPnl` call, sum realized P&L from today's trades:
   ```ts
   const todayTrades = queries.getTodayTrades.all(network) as TradeRow[];
   const realizedPnl = todayTrades
     .filter(t => t.realized_pnl != null)
     .reduce((sum, t) => sum + t.realized_pnl, 0);
   ```

5. Surface on dashboard: add "Today's P&L" card showing realized vs unrealized with green/red colouring.

---

### Task 2.2 — Per-strategy trade tagging

**Files:** `src/data/schema.ts`, `src/trading/executor.ts`
**Spec ref:** F3

Add `strategy TEXT` column to trades table. Pass through from caller:
- Optimizer rotations: `strategy = 'optimizer'`
- Threshold: `strategy = 'threshold'`
- SMA: `strategy = 'sma'`
- Grid: `strategy = 'grid'`
- Manual: `strategy = 'manual'`

Add a `/api/trades/summary` endpoint that groups by strategy and returns win rate, avg P&L, total fees per strategy. Show on dashboard. This reveals which strategies are net-positive and which are not.

---

### Task 2.3 — Session high-water mark for drawdown protection

**Files:** `src/data/schema.ts`, `src/trading/risk-guard.ts`
**Spec ref:** R5

Add `session_high_water REAL` to `daily_pnl`. Update it whenever current portfolio value exceeds it. Add drawdown check in `RiskGuard.checkRotation()`:

```ts
const maxDrawdownPct = this.runtimeConfig.get('MAX_DRAWDOWN_PCT') as number;
if (todayPnl?.session_high_water > 0) {
  const drawdownPct = ((todayPnl.session_high_water - portfolioUsd) / todayPnl.session_high_water) * 100;
  if (drawdownPct > maxDrawdownPct) {
    botState.setStatus('paused');
    botState.emitAlert(`MAX DRAWDOWN breached (${drawdownPct.toFixed(1)}%). All trading halted.`);
    return { approved: false, vetoReason: `Drawdown ${drawdownPct.toFixed(1)}% exceeds limit ${maxDrawdownPct}%` };
  }
}
```

---

## Phase 3 — Strategy Quality Improvements

Do this after Phase 2 is deployed and you have at least 3 days of P&L data to evaluate.

**Estimated effort: 4–8 hours.**

---

### Task 3.1 — 200 EMA trend filter

**Files:** `src/strategy/candle.ts`, `src/strategy/threshold.ts`, `src/strategy/sma.ts`
**Spec ref:** S1

1. Add `computeEMA200(closes: number[]): number | null` to `src/strategy/indicators.ts` (the new shared file from Task 3.5).

2. In `CandleStrategy.evaluate()`, compute the 200-period EMA on 1h closes. Add `trendBias: 'bullish' | 'bearish' | 'neutral'` to the returned signal.

3. In `ThresholdStrategy.evaluate()`: fetch 200 EMA via the candle service. If trend is bearish, only allow sells (no buys). If bullish, allow both. If neutral, allow both but reduce position size by 50%.

4. In `SmaStrategy.evaluate()`: add same trend filter — crossover buys only fire when price > EMA200.

---

### Task 3.2 — Fix ThresholdStrategy entry averaging

**File:** `src/strategy/threshold.ts`
**Spec ref:** S2

Replace entry price reset with volume-weighted average cost (VWAC):

```ts
private positions: Array<{ price: number; qty: number }> = [];

// On buy:
this.positions.push({ price: current, qty: tradeQty });

// Compute VWAC:
get avgEntryPrice(): number {
  if (this.positions.length === 0) return 0;
  const totalValue = this.positions.reduce((sum, p) => sum + p.price * p.qty, 0);
  const totalQty = this.positions.reduce((sum, p) => sum + p.qty, 0);
  return totalValue / totalQty;
}

// Exit target based on VWAC:
const gainPct = ((current - this.avgEntryPrice) / this.avgEntryPrice) * 100;
```

---

### Task 3.3 — Trailing stop-loss

**Files:** `src/strategy/threshold.ts`, `src/strategy/sma.ts`
**Spec ref:** R3

Track `peakPriceSinceEntry` per position. On each tick, update if current > peak. Check:
```ts
const trailingStopPct = config.TRAILING_STOP_PCT;
const trailingDrawdown = ((this.peakPriceSinceEntry - current) / this.peakPriceSinceEntry) * 100;
if (trailingDrawdown >= trailingStopPct) {
  return { signal: 'sell', reason: `Trailing stop: ${trailingDrawdown.toFixed(2)}% from peak` };
}
```

---

### Task 3.4 — Wire real candle data to grid bounds

**File:** `src/trading/engine.ts:153–154`
**Spec ref:** S4, L1

Replace `() => null` callbacks:
```ts
getCandleHigh24h: () => {
  const c = this.candleService.getStoredCandles(symbol, network, '24h', 1);
  return c.length > 0 ? c[0].high : null;
},
getCandleLow24h: () => {
  const c = this.candleService.getStoredCandles(symbol, network, '24h', 1);
  return c.length > 0 ? c[0].low : null;
},
```

Also add guard in `grid.ts` `initializeLevels`:
```ts
if (this.upperBound <= this.lowerBound || this.gridLevelCount < 2) {
  logger.warn(`GridStrategy: invalid bounds [${this.lowerBound}, ${this.upperBound}], skipping init`);
  return;
}
```

---

### Task 3.5 — Confidence-weighted rotation threshold

**File:** `src/trading/optimizer.ts`
**Spec ref:** S5

In `findRotationCandidate`, apply confidence weighting:
```ts
// Effective score = raw score × average signal confidence
const effectiveBuyScore = candidate.buy.score * candidate.buy.confidence;
const effectiveSellScore = candidate.sell.score * candidate.sell.confidence;
const effectiveDelta = effectiveBuyScore - effectiveSellScore;

if (effectiveDelta < minDelta) return null; // reject low-confidence rotations
```

---

### Task 3.6 — Same-pair rotation cooldown

**File:** `src/trading/optimizer.ts`
**Spec ref:** S6

After executing a rotation (sell A, buy B), record `{ sell: A, buy: B, timestamp }` in a new `rotation_pairs` table (or in-memory map). In `findRotationCandidate`, skip any pair where the reverse was rotated within `MIN_HOURS_BETWEEN_SAME_PAIR * 3600 * 1000` ms.

---

## Phase 4 — Code Quality & Infrastructure

Do this after Phase 3 is stable. These are correctness improvements that reduce operational risk.

**Estimated effort: 2–3 hours.**

---

### Task 4.1 — Extract shared indicators

**Files:** new `src/strategy/indicators.ts`, `src/strategy/candle.ts`, `src/strategy/sma.ts`
**Spec ref:** S1 (simplification)

1. Create `src/strategy/indicators.ts` with exports: `ema`, `computeRSI`, `computeMACD`, `computeBollingerBands`.
2. Remove duplicated `ema` from `sma.ts`. Import from `indicators.ts`.
3. The candle.ts helpers can remain or also import — either way, remove the duplication.

---

### Task 4.2 — Extract cooldown helper

**File:** `src/trading/executor.ts`
**Spec ref:** S2 (simplification)

```ts
private checkCooldown(): void {
  const cooldown = this.runtimeConfig.get('TRADE_COOLDOWN_SECONDS') as number;
  const lastTrade = botState.lastTradeAt;
  if (lastTrade) {
    const elapsed = (Date.now() - lastTrade.getTime()) / 1000;
    if (elapsed < cooldown) {
      throw new Error(`Cooldown active, ${Math.ceil(cooldown - elapsed)}s remaining`);
    }
  }
}
```

Replace the two copy-pasted cooldown blocks in `executeEnso` and `executeManual` with `this.checkCooldown()`.

---

### Task 4.3 — DB transactions for critical operations

**Files:** `src/data/db.ts`, `src/trading/executor.ts`, `src/strategy/grid.ts`
**Spec ref:** H5

Wrap in `db.transaction()`:
1. Grid level state flip + trade record (in `grid.ts` and wherever grid trades are recorded)
2. Optimizer `upsertDailyPnl` + rotation status update (in `optimizer.ts`)
3. Any multi-step write in `executeRotation`

---

### Task 4.4 — Error handling in asset loops

**File:** `src/trading/engine.ts`, `src/trading/executor.ts`
**Spec ref:** M3

1. Wrap `swap` call in `executeForAsset` in try/catch. Return early on error, log it.
2. In `engine.ts` asset loop, change `void this.tickAsset(...)` to `this.tickAsset(...).catch(err => logger.error('Asset tick error', { symbol, err }))`.

---

### Task 4.5 — Fix portfolio_usd = 0 for ETH snapshots

**File:** `src/portfolio/tracker.ts`
**Spec ref:** L4

When inserting a portfolio snapshot for ETH, compute `portfolio_usd = ethBalance * lastPrice`. This is used by the dashboard's portfolio value graph and should reflect real USD value.

---

## Phase 5 — Monitoring & Observability (Future / Optional)

These are lower priority but improve ongoing operations.

- **Per-strategy P&L dashboard panel** — win rate, avg gain, avg loss, Sharpe ratio per strategy. Allows disabling strategies that are net-negative.
- **Rotation replay log** — show each rotation proposal with: proposed gain, estimated fees, actual outcome. Helps calibrate the score→gain mapping.
- **Telegram daily digest** — at configured times (already configurable), send daily summary: rotations executed, realized P&L, best/worst trade, current portfolio breakdown.
- **Paper trading shadow mode** — run a simulated portfolio in parallel without executing real trades. Compare simulated vs actual P&L to detect slippage and market impact.

---

## Recommended Implementation Order

```
Phase 1 (fix losses):     1.1 → 1.2 → 1.3 → 1.4 → 1.5 → 1.6 → 1.7
Phase 2 (visibility):     2.1 → 2.2 → 2.3
  [Deploy, monitor 3+ days]
Phase 3 (strategy):       3.1 → 3.4 → 3.2 → 3.3 → 3.5 → 3.6
  [Deploy, monitor 5+ days]
Phase 4 (quality):        4.1 → 4.2 → 4.4 → 4.3 → 4.5
Phase 5 (observability):  as time permits
```

## Success Criteria

| Metric | Current | Target |
|--------|---------|--------|
| Daily P&L | Consistently negative | Break-even within 7 days of Phase 1 |
| Rotations/day | 3–10 (lossy) | 1–3 (profitable) |
| Fee gate pass rate | ~100% | <30% (most rejected) |
| Stop-loss triggers | Never | Working as expected |
| Realized P&L tracked | Never | Every trade |
| Leg 2 skip rate | Unknown (but likely non-zero) | 0% |
