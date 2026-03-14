# Portfolio Optimizer — Plan B: Optimizer & Execution

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the PortfolioOptimizer, RiskGuard, WatchlistManager, and wire rotation execution into the existing TradeExecutor and TradingEngine.

**Architecture:** PortfolioOptimizer collects CandleSignal scores across timeframes, ranks assets, identifies rotation candidates, and checks RiskGuard before emitting execution orders. TradeExecutor gains a two-leg rotation method. TradingEngine runs the optimizer on its own interval.

**Tech Stack:** TypeScript ESM, better-sqlite3, Vitest

**Spec:** `docs/superpowers/specs/2026-03-14-portfolio-optimizer-design.md`

**Prerequisites:** Plan A complete (DB tables, CandleService, CandleStrategy exist)

**Conventions:**
- TypeScript ESM — all imports use `.js` extensions even for `.ts` source files
- `better-sqlite3` is synchronous — never `await` DB calls
- `botState` is a singleton — do not instantiate it
- `runtimeConfig.get('KEY')` for live-reloadable settings
- Vitest with `vi.hoisted()` for mock hoisting in ESM
- Run tests with `npx vitest run`

---

## Chunk 1: WatchlistManager & RiskGuard

### Task 1: WatchlistManager

**Files:**
- Create: `src/portfolio/watchlist.ts`
- Test: `tests/watchlist.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/watchlist.test.ts` that verifies:
- `add()` inserts a watchlist item to DB; can be retrieved with `getAll(network)`
- `add()` with duplicate symbol+network is silently ignored (INSERT OR IGNORE)
- `remove()` sets status to 'removed'; item no longer appears in `getAll()`
- `promote()` inserts into `discovered_assets` with status='active' and updates watchlist status to 'promoted'
- `promote()` throws if address is null (required for discovered_assets)

Use real DB (it's synchronous SQLite, same test pattern as existing tests). Clean up test rows in afterEach.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/watchlist.test.ts`

- [ ] **Step 3: Implement WatchlistManager**

Create `src/portfolio/watchlist.ts`:

```typescript
import { watchlistQueries, discoveredAssetQueries } from '../data/db.js';
import { logger } from '../core/logger.js';

export interface WatchlistRow {
  id: number; symbol: string; network: string; address: string | null;
  source: string; added_at: string; status: string; coinbase_pair: string | null;
}

export class WatchlistManager {
  add(symbol: string, network: string, address?: string, coinbasePair?: string, source = 'manual'): void {
    watchlistQueries.insertWatchlistItem.run({
      symbol, network, address: address ?? null, coinbase_pair: coinbasePair ?? null, source,
    });
    logger.info(`Watchlist: added ${symbol} on ${network}`);
  }

  remove(symbol: string, network: string): void {
    watchlistQueries.removeWatchlistItem.run(symbol, network);
    logger.info(`Watchlist: removed ${symbol} on ${network}`);
  }

  getAll(network: string): WatchlistRow[] {
    return watchlistQueries.getWatchlist.all(network) as WatchlistRow[];
  }

  promote(symbol: string, network: string): void {
    const items = this.getAll(network);
    const item = items.find(i => i.symbol === symbol);
    if (!item) throw new Error(`${symbol} not on watchlist for ${network}`);
    if (!item.address) throw new Error(`Cannot promote ${symbol}: address is required`);

    discoveredAssetQueries.upsertDiscoveredAsset.run({
      address: item.address, network, symbol, name: symbol, decimals: 18,
    });
    discoveredAssetQueries.updateAssetStatus.run({ status: 'active', address: item.address, network });
    watchlistQueries.updateWatchlistStatus.run({ status: 'promoted', symbol, network });
    logger.info(`Watchlist: promoted ${symbol} to active discovered asset`);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/watchlist.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add src/portfolio/watchlist.ts tests/watchlist.test.ts
git commit -m "feat: add WatchlistManager for external asset tracking"
```

---

### Task 2: RiskGuard

**Files:**
- Create: `src/trading/risk-guard.ts`
- Test: `tests/risk-guard.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/risk-guard.test.ts` that verifies:

Mock `runtimeConfig` as a simple object with a `get()` method returning preset values. Mock `dailyPnlQueries` and `rotationQueries` to return controlled data. Mock `botState`.

Tests:
- `checkRotation()` approves a rotation when all limits are within bounds
- `checkRotation()` vetoes when portfolio_usd < PORTFOLIO_FLOOR_USD (reason includes 'portfolio floor')
- `checkRotation()` vetoes when daily loss exceeds MAX_DAILY_LOSS_PCT
- `checkRotation()` vetoes when daily rotation count >= MAX_DAILY_ROTATIONS
- `checkRotation()` reduces rotation amount when it would exceed MAX_POSITION_PCT, vetoes if reduced amount is too small
- `checkRotation()` vetoes when estimated fees exceed expected gain
- Veto decisions are logged to bot_events via queries.insertEvent

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/risk-guard.test.ts`

- [ ] **Step 3: Implement RiskGuard**

Create `src/trading/risk-guard.ts`:

```typescript
import { queries, dailyPnlQueries, rotationQueries } from '../data/db.js';
import { botState } from '../core/state.js';
import { logger } from '../core/logger.js';
import type { RuntimeConfig } from '../core/runtime-config.js';

export interface RotationProposal {
  sellSymbol: string;
  buySymbol: string;
  sellAmount: number;       // USD value
  estimatedGainPct: number;
  estimatedFeePct: number;
  buyTargetWeightPct: number; // what % of portfolio the buy asset would be after rotation
}

export interface RiskDecision {
  approved: boolean;
  adjustedAmount?: number;  // may be reduced from original
  vetoReason?: string;
}

export class RiskGuard {
  constructor(private readonly runtimeConfig: RuntimeConfig) {}

  checkRotation(proposal: RotationProposal, network: string, portfolioUsd: number): RiskDecision {
    const detail = JSON.stringify({ ...proposal, network, portfolioUsd });

    // 1. Portfolio floor
    const floor = this.runtimeConfig.get('PORTFOLIO_FLOOR_USD') as number;
    if (portfolioUsd < floor) {
      this.logDecision('risk_halt', `Portfolio floor breached: $${portfolioUsd} < $${floor}. ${detail}`);
      botState.setStatus('paused');
      botState.emitAlert(`PORTFOLIO FLOOR BREACHED ($${portfolioUsd.toFixed(2)} < $${floor}). ALL TRADING HALTED.`);
      return { approved: false, vetoReason: `Portfolio floor breached ($${portfolioUsd} < $${floor})` };
    }

    // 2. Daily loss limit
    const maxLossPct = this.runtimeConfig.get('MAX_DAILY_LOSS_PCT') as number;
    const todayPnl = dailyPnlQueries.getTodayPnl.get(network) as { high_water: number; current_usd: number } | undefined;
    if (todayPnl && todayPnl.high_water > 0) {
      const lossPct = ((todayPnl.high_water - portfolioUsd) / todayPnl.high_water) * 100;
      if (lossPct > maxLossPct) {
        this.logDecision('risk_halt', `Daily loss limit: ${lossPct.toFixed(1)}% > ${maxLossPct}%. ${detail}`);
        botState.setStatus('paused');
        botState.emitAlert(`Daily loss limit hit (${lossPct.toFixed(1)}%). Trading paused.`);
        return { approved: false, vetoReason: `Daily loss ${lossPct.toFixed(1)}% exceeds limit ${maxLossPct}%` };
      }
    }

    // 3. Daily rotation count
    const maxRotations = this.runtimeConfig.get('MAX_DAILY_ROTATIONS') as number;
    const todayCount = (rotationQueries.getTodayRotationCount.get(network) as { count: number })?.count ?? 0;
    if (todayCount >= maxRotations) {
      this.logDecision('risk_veto', `Daily rotation cap: ${todayCount} >= ${maxRotations}. ${detail}`);
      return { approved: false, vetoReason: `Daily rotation cap reached (${todayCount}/${maxRotations})` };
    }

    // 4. Position size limit
    const maxPosPct = this.runtimeConfig.get('MAX_POSITION_PCT') as number;
    let adjustedAmount = proposal.sellAmount;
    if (proposal.buyTargetWeightPct > maxPosPct) {
      const reduction = (proposal.buyTargetWeightPct - maxPosPct) / proposal.buyTargetWeightPct;
      adjustedAmount = proposal.sellAmount * (1 - reduction);
      if (adjustedAmount < portfolioUsd * 0.01) { // too small to be worthwhile
        this.logDecision('risk_veto', `Position limit: reduced amount too small. ${detail}`);
        return { approved: false, vetoReason: `Position limit would reduce rotation below minimum` };
      }
    }

    // 5. Single rotation size
    const maxRotPct = this.runtimeConfig.get('MAX_ROTATION_PCT') as number;
    const rotPct = (adjustedAmount / portfolioUsd) * 100;
    if (rotPct > maxRotPct) {
      adjustedAmount = portfolioUsd * maxRotPct / 100;
    }

    // 6. Fee check
    if (proposal.estimatedFeePct >= proposal.estimatedGainPct) {
      this.logDecision('risk_veto', `Fees exceed gain: fee=${proposal.estimatedFeePct}% >= gain=${proposal.estimatedGainPct}%. ${detail}`);
      return { approved: false, vetoReason: `Fees (${proposal.estimatedFeePct}%) exceed gain (${proposal.estimatedGainPct}%)` };
    }

    this.logDecision('risk_approved', detail);
    return { approved: true, adjustedAmount };
  }

  private logDecision(event: string, detail: string): void {
    queries.insertEvent.run(event, detail);
    logger.info(`RiskGuard: ${event} — ${detail.slice(0, 200)}`);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/risk-guard.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add src/trading/risk-guard.ts tests/risk-guard.test.ts
git commit -m "feat: add RiskGuard with position limits, loss limits, rotation caps"
```

---

## Chunk 2: PortfolioOptimizer & Execution

### Task 3: PortfolioOptimizer

**Files:**
- Create: `src/trading/optimizer.ts`
- Test: `tests/optimizer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/optimizer.test.ts` that verifies:

Mock CandleService, CandleStrategy, RiskGuard, TradeExecutor, botState.

Tests:
- `computeScores()` returns an OpportunityScore per asset with score in -100 to +100 range
- Score uses correct formula: `(component_15m * 0.5 + component_1h * 0.3 + component_24h * 0.2) * confidence`
- Hold signals contribute 0 to score
- Confidence multiplier: coinbase=1.0, dex=0.7, synthetic=0.4
- `findRotationCandidate()` returns best sell/buy pair when score delta exceeds MIN_ROTATION_SCORE_DELTA
- `findRotationCandidate()` returns null when no candidates meet thresholds
- Risk-off mode: when all scores < RISK_OFF_THRESHOLD, optimizer enters risk-off
- Risk-on: exits risk-off when any score > RISK_ON_THRESHOLD

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/optimizer.test.ts`

- [ ] **Step 3: Implement PortfolioOptimizer**

Create `src/trading/optimizer.ts` with:

**OpportunityScore interface** (from spec Section 3.3)

**PortfolioOptimizer class:**
- Constructor takes: CandleService, CandleStrategy, RiskGuard, TradeExecutor, RuntimeConfig
- `computeScores(assets, network)` — for each asset, evaluate CandleStrategy 3x (15m, 1h, 24h candles from CandleService.getStoredCandles). Compute signed score per spec formula.
- `findRotationCandidate(scores)` — find best sell candidate (held, score < ROTATION_SELL_THRESHOLD) and best buy candidate (score > ROTATION_BUY_THRESHOLD) where delta > MIN_ROTATION_SCORE_DELTA
- `tick(network)` — main loop: compute scores, check risk-off/risk-on mode, find rotation, check RiskGuard, execute if approved
- `isRiskOff` getter
- Determine candle source confidence: check the most recent candle's `source` field for each asset
- Store latest scores on the instance for dashboard API access (`getLatestScores()`)

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/optimizer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add src/trading/optimizer.ts tests/optimizer.test.ts
git commit -m "feat: add PortfolioOptimizer with scoring, rotation detection, risk-off mode"
```

---

### Task 4: TradeExecutor — Rotation Execution

**Files:**
- Modify: `src/trading/executor.ts`
- Test: `tests/executor-rotation.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/executor-rotation.test.ts` that verifies:

Mock CoinbaseTools (swap/ensoRoute), runtimeConfig, botState.

Tests:
- `executeRotation()` executes sell leg then buy leg, returns status='executed' with both tx hashes
- `executeRotation()` returns status='leg1_done' when sell succeeds but buy fails
- `executeRotation()` returns status='failed' when sell fails (buy not attempted)
- `executeRotation()` in DRY_RUN mode simulates both legs without calling swap, records dry_run=1
- Cooldown is NOT enforced between leg 1 and leg 2 (both execute in quick succession)
- Cooldown timestamp is set after full rotation completes

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/executor-rotation.test.ts`

- [ ] **Step 3: Implement executeRotation**

Add to `src/trading/executor.ts`:

```typescript
async executeRotation(
  sellSymbol: string,
  buySymbol: string,
  sellAmount: number,
  rotationId: number,
): Promise<{ status: 'executed' | 'leg1_done' | 'failed'; sellTxHash?: string; buyTxHash?: string }> {
  const dryRun = this.runtimeConfig.get('DRY_RUN') as boolean;

  // Leg 1: Sell → USDC
  let sellTxHash: string | undefined;
  if (!dryRun) {
    try {
      const result = await this.tools.swap(sellSymbol as any, 'USDC' as any, sellAmount.toString());
      sellTxHash = result.txHash;
    } catch (err) {
      logger.error(`Rotation leg 1 failed (sell ${sellSymbol})`, err);
      return { status: 'failed' };
    }
  }

  // Leg 2: USDC → Buy (no cooldown between legs)
  let buyTxHash: string | undefined;
  if (!dryRun) {
    try {
      // Use USDC balance from sell proceeds
      const usdcAmount = (botState.lastUsdcBalance ?? 0) * 0.95; // leave 5% buffer
      const result = await this.tools.swap('USDC' as any, buySymbol as any, usdcAmount.toString());
      buyTxHash = result.txHash;
    } catch (err) {
      logger.error(`Rotation leg 2 failed (buy ${buySymbol})`, err);
      botState.recordTrade(new Date()); // set cooldown after partial
      return { status: 'leg1_done', sellTxHash };
    }
  }

  botState.recordTrade(new Date()); // set cooldown after full rotation
  return { status: 'executed', sellTxHash, buyTxHash };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/executor-rotation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add src/trading/executor.ts tests/executor-rotation.test.ts
git commit -m "feat: add two-leg rotation execution to TradeExecutor"
```

---

### Task 5: TradingEngine — Optimizer Integration + index.ts Wiring

**Files:**
- Modify: `src/trading/engine.ts`
- Modify: `src/index.ts`
- Modify: `src/portfolio/tracker.ts`

- [ ] **Step 1: Add optimizer loop to TradingEngine**

Modify `src/trading/engine.ts`:
- Add `private optimizer: PortfolioOptimizer | null = null`
- Add `private optimizerIntervalId: ReturnType<typeof setInterval> | null = null`
- Add `setOptimizer(optimizer: PortfolioOptimizer): void` — stores reference
- Add `enableOptimizer()` — starts optimizer tick on `OPTIMIZER_INTERVAL_SECONDS` interval
- Add `disableOptimizer()` — clears optimizer interval
- Add `get optimizerEnabled(): boolean`
- Optimizer tick calls `this.optimizer.tick(botState.activeNetwork)`
- Subscribe to OPTIMIZER_INTERVAL_SECONDS changes to restart optimizer interval

- [ ] **Step 2: Wire CandleService into portfolio tracker**

Modify `src/portfolio/tracker.ts`:
- Accept optional `CandleService` parameter in `startPortfolioTracker()`
- After fetching each asset price, call `candleService.recordSpotPrice(asset.symbol, network, price)` if candleService is provided
- Also call for discovered assets

- [ ] **Step 3: Wire everything in index.ts**

Modify `src/index.ts`:
- Import and instantiate CandleService, CandleStrategy, RiskGuard, WatchlistManager, PortfolioOptimizer
- Pass CandleService to startPortfolioTracker
- Create PortfolioOptimizer with all dependencies
- Call engine.setOptimizer(optimizer) and engine.enableOptimizer()
- Start CandleService polling
- Add candleService.stopPolling() to shutdown handler
- On network change, update CandleService network

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```
git add src/trading/engine.ts src/portfolio/tracker.ts src/index.ts
git commit -m "feat: wire optimizer into TradingEngine and startup"
```
