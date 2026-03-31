# Peer Review Findings — Profit Improvement Plan

**Date:** 2026-03-31
**Reviewers:** Two independent agents (trading strategy focus + engineering/correctness focus)
**Plan reviewed:** `docs/superpowers/plans/2026-03-31-profit-improvement-plan.md`

---

## Consensus Issues (both reviewers flagged)

These were independently identified by both reviewers and carry the highest confidence.

### C1. `rawDelta * 0.02` is indefensible — redesign Task 1.1

The proposed `estimatedGainPct = rawDelta * 0.02` conversion is a magic constant with no derivation. The score (composite of RSI/MACD/BB signals) is not a return forecast — the relationship to actual price movement is neither linear nor validated. This replaces one unit-mismatch bug with a different unfounded assumption.

**Recommended fix:** Gate rotation on two independent conditions, not one conflated one:
1. Score delta exceeds `MIN_ROTATION_SCORE_DELTA` (as now)
2. A separate return forecast (e.g. momentum of recent candle closes over N periods) exceeds `estimatedFeePct * 1.5`

These are orthogonal signals. Don't convert the score into a gain estimate — use the score as a directional signal and a price-momentum measure as the profitability gate.

---

### C2. In-memory `openPositions` will be lost on restart — Task 2.1 must persist to DB

The plan proposes `this.openPositions.set(symbol, { price, qty })` in-memory. After any crash or restart, all entry prices are gone — the bot will compute garbage P&L (every sell looks like a zero-cost entry). This is a significant regression hidden as an improvement.

**Fix:** Persist open positions to a new SQLite table (`open_positions`) on write, reload on startup. The in-memory map is fine as a cache but DB must be authoritative.

---

### C3. Stop-loss signals must bypass the daily rotation cap — Tasks 1.4 and 1.7 interact badly

`MAX_DAILY_ROTATIONS: 10→4` means after 4 rotations, stop-loss signals from ThresholdStrategy are silently blocked for the rest of the day. Stop-losses are risk management, not alpha — they must not be subject to rotation counting.

**Fix:** Add a `priority: 'stop-loss' | 'normal'` field to the signal (or check `reason` string). RiskGuard's rotation cap check should skip signals with `priority: 'stop-loss'`. Do not ship Task 1.7 until this exemption is implemented.

---

### C4. DB transactions (Task 4.3) should be Phase 1, not Phase 4

Phase 1 adds trade recording (1.3) and P&L tracking (later 2.1). Partially-committed records during a crash are actively harmful — worse than no records. Wrapping multi-step writes in `db.transaction()` is a prerequisite for the new writes introduced in Phase 1, not a cleanup item.

**Fix:** Move DB transaction wrapping to Phase 1 as Task 1.0 (first thing done).

---

## Trading Strategy Findings (Reviewer 1)

### T1. Circuit breaker (R5) belongs in Phase 1, not Phase 2

A 15% drawdown limit is a hard safety rail. If Phase 1 changes introduce a bug, the circuit breaker is the last line of defence. Move to Phase 1.

### T2. Paper trading / shadow mode should be Phase 0

Without a baseline to compare against, you won't know if Phase 1 changes helped or hurt. Even a lightweight shadow executor (simulate the trade, record hypothetical P&L) should run before live changes are deployed. The plan gates Phase 3 on "3 days of Phase 2 data" — but that data is only meaningful if there's a paper baseline to compare it against.

### T3. MEV / sandwich attack risk is unaddressed

On Base DEXes, every swap is exposed to sandwich risk. A sandwiched rotation can cost 2–5% immediately — more than the entire expected gain. The plan should specify: (a) slippage tolerance passed to swap calls, (b) transaction deadline/TTL on swap orders. This belongs in Phase 1 or it should be called out explicitly as a known accepted risk.

### T4. Partial rotation recovery is unaddressed

Leg 1 (sell → USDC) can succeed while leg 2 (buy target) fails or is blocked by the MCP server going down. The portfolio is stranded in USDC. Task I1 fixes the stale balance but doesn't address recovery. There should be a startup check: if a rotation is in `leg1_done` state in the DB, attempt leg 2 before starting new rotations.

### T5. Trailing stop (R3) makes fixed stop (R1) redundant

A trailing stop is strictly superior to a fixed stop for long positions — it protects downside and locks in gains. Implementing both adds conflicting exit logic. Drop R1 (fixed stop-loss) and implement only the trailing stop. Or: fixed stop as a floor, trailing stop as the primary exit. Make the relationship explicit.

### T6. PORTFOLIO_FLOOR_USD should be percentage-based

A fixed `$150` floor on an unknown portfolio size is meaningless. If the portfolio is $5000, that's a 3% floor — effectively no protection. Express as a percentage of initial portfolio value, or at minimum document the expected portfolio size this default was calibrated for.

### T7. ATR sizing (R4) adds noise before basics are fixed

ATR-based position sizing adds a variable that makes it harder to isolate what's causing losses or gains. Move to Phase 4 minimum.

### T8. No mention of backtesting

Every config change is being deployed blind. The SQLite DB already has candle history. Even a naive backtest replaying the signal logic against historical closes would let you validate that raising `MIN_ROTATION_SCORE_DELTA: 40→60` reduces trade count without eliminating all profitable setups. This is a meaningful gap.

### T9. No global cooldown after a losing trade

S6 adds same-pair cooldown (4h) but there's no global cooldown after a realized loss. A losing rotation followed immediately by another rotation is a cascading drawdown pattern.

---

## Engineering / Correctness Findings (Reviewer 2)

### E1. `this.tools.getBalance('USDC')` — verify the API contract (Task 1.2)

The plan assumes this method exists and returns `{ balance: string }`. Coinbase AgentKit MCP tools may not expose a typed `getBalance` with this exact signature — it may be a natural language tool with an unparsed text response. **Verify against `src/mcp/tools.ts` before implementing.** If not available, use the portfolio tracker's existing balance refresh path instead.

### E2. Return type mismatch in `executeForAsset` (Task 1.5)

`executeForAsset` is `void`-returning. The plan shows `return { signal: 'hold', reason: '...' }` — this is a StrategySignal shape that the caller won't use. Fix: use bare `return;` with a `logger.warn()` call for the skip reason.

### E3. VWAC requires qty the strategy doesn't have (Task 3.2)

Strategies emit signals; executors size positions. The strategy's `positions` array can't be populated with accurate trade qty without a callback from the executor after fill. Without this, VWAC silently computes wrong averages.

**Better design:** Move position tracking entirely to the executor/DB layer. The strategy doesn't need to own position state — it just needs to know the average entry price, which can be passed in as a parameter to `evaluate()` or queried from DB.

### E4. Non-ETH pricing still falls back to $0 on cold start (Task 1.6)

The fix ends with `assetPrice = recentCandles.length > 0 ? recentCandles[0].close : 0`. On cold start or for a newly added asset, this is still $0. Add a candle warmup guard: log a warning and skip rotation candidate for this asset until at least 1 candle is available.

### E5. `confidence` field assumed non-null in Task 3.5

`buy.confidence` is referenced but if it's `undefined` (e.g. HOLD signal with no confidence set), `delta * undefined = NaN`, which fails all threshold comparisons silently — effectively disabling rotation without any log output. Add `?? 1.0` default.

### E6. DB migration `try/catch` — SQLITE_BUSY can silently fail

If migrations run while a write transaction is in flight (e.g. optimizer ticks during startup), SQLite throws `SQLITE_BUSY` — swallowed silently, column never added, runtime crashes later with "no such column". **Migrations must run synchronously before any loop starts**, not concurrently with them.

### E7. 200 EMA cold-start behaviour not specified (Task 3.1)

200 x 1h candles = 8+ days of history required. If unavailable, the filter must halt trading for that asset (not default to "neutral"), or it will open positions based on a meaningless partial EMA. Specify the minimum candle count and the fallback behaviour explicitly.

---

## Recommended Plan Revisions

### Reorder Phase 1

```
1.0  DB transactions (moved from Phase 4.3)
1.0  Partial rotation recovery on startup (new — check for leg1_done state)
1.1  Fix fee gate — redesign to use score delta + separate price momentum gate (not rawDelta * 0.02)
1.2  Fix rotation leg 2 stale balance (verify getBalance API contract first)
1.3  Record trades from executeForAsset
1.4  Add stop-loss to ThresholdStrategy (trailing stop only — drop fixed stop)
1.5  Apply RiskGuard to executeForAsset (fix return type — bare return, not StrategySignal)
1.5a Stop-loss signals exempt from rotation cap
1.6  Fix non-ETH asset pricing (add cold-start guard)
1.7  Circuit breaker / drawdown protection (moved from Phase 2.3)
1.8  Raise config defaults (only after 1.5a is in place for rotation cap)
```

### Reorder Phase 2

```
2.0  Persist openPositions to DB (prerequisite for 2.1)
2.1  Realized P&L per trade
2.2  Per-strategy trade tagging
```

### Phase 3 — Add before deployment

```
0.x  Lightweight paper trading baseline (shadow executor logging hypothetical P&L)
     — even a simple daily log of "would have traded X, estimated outcome Y" is enough
```

### Phase 3 — Strategy changes

```
3.1  200 EMA trend filter (add explicit cold-start halt guard, not neutral default)
3.2  Fix ThresholdStrategy entry averaging — move position tracking to executor/DB layer
3.3  Trailing stop-loss (primary exit — replaces fixed stop from 1.4 if desired, or set as floor)
3.4  Wire real candle data to grid bounds
3.5  Confidence-weighted threshold (add ?? 1.0 null-coalescing)
3.6  Same-pair rotation cooldown + global post-loss cooldown (new)
```

---

## Things the Plan Gets Right

Both reviewers agreed the following are correctly identified and appropriately prioritised:
- Fee gate unit mismatch as the primary loss cause (correct diagnosis)
- Leg 2 stale balance as a race condition causing real missed trades
- Non-ETH $0 pricing making multi-asset rotation non-functional
- `executeForAsset` bypassing risk guards as a critical safety gap
- "Measure before you optimise" framing for Phase 2
- Not adding new strategies before P&L tracking works
- MAX_DAILY_ROTATIONS reduction as the highest-leverage single config change
