# Agent Handover — 2026-03-22

Review of trading activity, config, bugs, and improvement opportunities. Intended for the next agent picking up this project.

---

## Current Runtime State

Bot runs as Docker container on **RPi5** (`192.168.68.139`), managed via Portainer.
Live env (from `docker inspect coinbase-trade`):

| Key | Value | Notes |
|-----|-------|-------|
| `NETWORK_ID` | `base-sepolia,base-mainnet` | Both networks available; UI has mainnet selected as active |
| `DRY_RUN` | `FALSE` | Real trades executing (see bug below) |
| `STRATEGY` | `threshold` | Buy on 2% drop, sell on 3% rise from entry |
| `PRICE_DROP_THRESHOLD_PCT` | `2.0` | Too high for stable/ranging market — see below |
| `MCP_SERVER_URL` | `http://192.168.68.139:3002/mcp` | Coinbase AgentKit MCP on RPi5 |

The live `.env` is at `/home/pi/docker/coinbase-trade/.env` on RPi5 (not in repo).
The `stack.env` in the repo root is the Portainer deployment template.

---

## Why Trades Are Infrequent

### Root cause: threshold too high for current market conditions

The threshold strategy requires a **2% single-swing drop** from the 10-candle rolling high before buying, then a **3% rise** from entry to sell. ETH mainnet in a stable/ranging period rarely produces moves of this magnitude in a single polling window. The bot is working correctly — the market just isn't triggering it.

**Fix:** Lower `PRICE_DROP_THRESHOLD_PCT` to `0.5`–`1.0` and `PRICE_RISE_TARGET_PCT` to `1.5`–`2.0` for active trading in normal conditions. Alternatively switch to `STRATEGY=sma` which catches micro-trends via crossover and fires more frequently in ranging markets.

### CBBTC and CBETH are not actively traded

The asset registry includes ETH, USDC, CBBTC, and CBETH, but the main strategy loop (`TradingEngine.tick()`) is **ETH-only** — `executor.ts` hardcodes `ETH ↔ USDC` as the only pair. CBBTC and CBETH only participate in **optimizer rotations** (Phase 4), not in independent threshold/SMA loops.

Independent strategy loops only start for assets in the `discovered_assets` DB table with `status='active'` (populated via Alchemy ERC20 discovery or manual DB insert). Neither CBBTC nor CBETH is in this table by default.

**Fix options:**
1. Add CBBTC and CBETH to the optimizer watchlist via Telegram (`/watch CBBTC <address>`) so they're actively scored and can trigger rotations.
2. Or add them to `discovered_assets` via the dashboard Asset Management modal so they get independent threshold/SMA loops.

### Portfolio optimizer has a 6.5-hour warmup gap

`CandleStrategy` (used by the optimizer) requires **26+ OHLCV candles per timeframe** before it produces any signal. At 15-minute candles that's 6.5 hours of silence after every container restart. During warmup the optimizer outputs `hold` for everything and no rotations fire.

There is no mechanism to pre-populate candle history on startup from existing `snapshots` table data.

### Optimizer rotation thresholds are conservative

For a rotation to fire, all of these must be true simultaneously:
- A held asset scores below **−20** (sell candidate)
- A watchlist/registry asset scores above **+30** (buy candidate)
- Score delta ≥ **40 points** between them
- Estimated net gain > **2%** after fees

In stable markets with few assets scored, this combination is rare. The defaults were written for volatile conditions.

**Suggested tuning for stable markets:**
- `ROTATION_BUY_THRESHOLD` → `15`–`20`
- `MIN_ROTATION_SCORE_DELTA` → `20`–`25`

These are DB-persisted settings, editable live via the dashboard Settings modal without restart.

---

## Bugs Found

### 1. `DRY_RUN` parsing is case-sensitive (silent footgun)

**File:** `src/config.ts` line 28

```ts
// Current — broken for uppercase input
DRY_RUN: z.string().transform(s => s === 'true').default('true'),
```

Only the exact lowercase string `'true'` enables dry run. This means:
- `DRY_RUN=FALSE` → dry run off ✅ (works as intended)
- `DRY_RUN=TRUE` → **dry run also off** ⚠️ (uppercase TRUE silently enables real trading)
- `DRY_RUN=True` → dry run off ⚠️ (same problem)

**Fix:**
```ts
DRY_RUN: z.string().transform(s => s.toLowerCase() === 'true').default('true'),
```

### 2. Rotation leg 2 uses all available USDC, not just the rotation amount

**File:** `src/trading/executor.ts` line 209

```ts
const amount = Math.max(usdcBalance * 0.95, 0);
```

When a rotation fires, leg 1 sells X% of a held asset into USDC. But leg 2 then spends **95% of the entire USDC balance**, not just the proceeds from leg 1. If the wallet already held USDC before the rotation, this over-deploys capital — potentially far exceeding the `MAX_ROTATION_PCT` limit that the optimizer already enforced on leg 1.

**Example:** Optimizer limits rotation to 25% of portfolio. Leg 1 converts $50 ETH → USDC. But wallet had $200 USDC already. Leg 2 spends $237.50 on the buy target — nearly 5× the intended rotation size.

**Fix:** The executor should receive the intended buy amount from the optimizer and use that, rather than re-reading the full USDC balance:
```ts
// Pass explicit buyAmountUsdc from optimizer instead of re-reading balance
const amount = Math.min(buyAmountUsdc, usdcBalance) * 0.95;
```

### 3. `executeForAsset()` suppresses token symbol type safety

**File:** `src/trading/executor.ts` line 108

```ts
await this.tools.swap(fromSymbol as any, toSymbol as any, amount.toString());
```

The `as any` casts bypass the `TokenSymbol` type check. If a discovered asset's symbol doesn't match what the MCP swap tool accepts (e.g. a non-standard ticker), this fails silently at runtime with no compile-time warning.

**Fix:** Validate discovered asset symbols against the accepted token list before starting an asset loop, or handle the error explicitly in `executeForAsset()`.

---

## What's Working Well

- Multi-network support (sepolia + mainnet) with runtime switching via UI/Telegram
- Phase 4 optimizer architecture is solid — RSI, MACD, volume, candle pattern scoring across three timeframes
- Risk guards are well-structured (position limits, daily loss cap, portfolio floor kill switch)
- Telegram bot covers all major commands including `/scores`, `/rotations`, `/risk`, `/killswitch`
- Per-asset strategy parameter injection works correctly for discovered assets
- MCP circuit breaker auto-pauses on server failure and resumes when healthy

---

## Recommended Next Actions (Priority Order)

1. **Fix `DRY_RUN` parsing** — `src/config.ts` line 28, one-line fix, zero risk
2. **Lower trade thresholds** in live `.env` on RPi5: `PRICE_DROP_THRESHOLD_PCT=1.0`, `PRICE_RISE_TARGET_PCT=1.5`
3. **Add CBBTC and CBETH to watchlist** via Telegram so optimizer scores and can rotate into them:
   - Base mainnet CBBTC: `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf`
   - Base mainnet cbETH: `0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22`
4. **Fix rotation leg 2 USDC sizing** — `src/trading/executor.ts` `executeRotation()` — pass explicit buy amount from optimizer
5. **Tune optimizer thresholds** via dashboard Settings: lower `ROTATION_BUY_THRESHOLD` to 20, `MIN_ROTATION_SCORE_DELTA` to 25
6. **Consider candle warmup pre-population** — on startup, synthesise historical candles from the existing `snapshots` table to eliminate the 6.5-hour optimizer blind spot after restarts

---

## Key File Locations

| File | Purpose |
|------|---------|
| `src/config.ts` | Zod env parsing — `DRY_RUN` bug is here |
| `src/trading/executor.ts` | Trade execution — leg 2 USDC bug + `as any` cast |
| `src/trading/engine.ts` | Strategy loops — ETH-only main loop, asset loops for discovered tokens |
| `src/trading/optimizer.ts` | Portfolio rotation — scoring, risk checks, rotation detection |
| `src/strategy/threshold.ts` | Threshold strategy — `dropPct`/`risePct` logic |
| `src/strategy/candle.ts` | RSI, MACD, volume scoring — needs 26 candles to warm up |
| `src/assets/registry.ts` | Static asset list (ETH, USDC, CBBTC, CBETH) |
| `stack.env` | Portainer deployment template (not the live env) |
