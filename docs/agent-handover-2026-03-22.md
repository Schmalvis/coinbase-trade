# Agent Handover — 2026-03-22

Review of trading activity, config, bugs, and improvement opportunities. Intended for the next agent picking up this project.

> **Note on codebase version:** This review was conducted against the source code visible in the repo. The `CLAUDE.md` was updated during the session to reflect Phases 4.5, 5, and 5.5 as complete. The running container may be on an older image — verify deployed version against source before assuming Phase 5.5 changes are live. Key Phase 5.5 change: registry assets (ETH, CBBTC, CBETH) are now seeded into `discovered_assets` on boot, and the separate global ETH-only strategy loop has been removed.

---

## Current Runtime State

Bot runs as Docker container on **RPi5** (`192.168.68.139`), managed via Portainer.
Live env (from `docker inspect coinbase-trade`):

| Key | Value | Notes |
|-----|-------|-------|
| `NETWORK_ID` | `base-sepolia,base-mainnet` | Both networks available; UI has mainnet selected as active |
| `DRY_RUN` | `FALSE` | Real trades executing (see bug below) |
| `STRATEGY` | `threshold` | Sets default for newly added assets only (per Phase 5.5) |
| `PRICE_DROP_THRESHOLD_PCT` | `2.0` | Too high for stable/ranging market — see below |
| `MCP_SERVER_URL` | `http://192.168.68.139:3002/mcp` | Coinbase AgentKit MCP on RPi5 |

The live `.env` is at `/home/pi/docker/coinbase-trade/.env` on RPi5 (not in repo).
The `stack.env.example` in the repo root is the Portainer deployment template.

---

## Why Trades Are Infrequent

### Root cause: threshold too high for current market conditions

The threshold strategy requires a **2% single-swing drop** from the 10-candle rolling high before buying, then a **3% rise** from entry to sell. ETH mainnet in a stable/ranging period rarely produces moves of this magnitude in a single polling window. The bot is working correctly — the market just isn't triggering it.

**Fix:** Lower `PRICE_DROP_THRESHOLD_PCT` to `0.5`–`1.0` and `PRICE_RISE_TARGET_PCT` to `1.5`–`2.0` for active trading in normal conditions. Alternatively switch to `STRATEGY=sma` which catches micro-trends via crossover and fires more frequently in ranging markets.

### CBBTC and CBETH strategy loop status (version-dependent)

**If running Phase 5.5+ image:** Registry assets (ETH, CBBTC, CBETH) are automatically seeded into `discovered_assets` on boot. All three get independent per-asset strategy loops (threshold/SMA/grid) configurable via the Asset Management modal. The global ETH-only strategy loop no longer exists. ✅

**If running a pre-Phase-5.5 image:** The main strategy loop is ETH-only, hardcoded as `ETH ↔ USDC`. CBBTC and CBETH only participate in optimizer rotations, not independent loops. To fix: add them to the watchlist via Telegram (`/watch CBBTC <address>`) or manually insert into `discovered_assets` via the Asset Management modal.

**Check:** Dashboard header strategy badge shows ETH's per-asset strategy in Phase 5.5+. If it still shows the global `STRATEGY` env value, the container is running an older image.

Base mainnet addresses for reference:
- CBBTC: `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf`
- cbETH: `0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22`

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
- Optimizer architecture solid — RSI, MACD, volume, Bollinger Bands, candle pattern scoring across three timeframes (Phase 4/5)
- Grid strategy available for ranging markets — auto-calculates bounds from 24hr candle data (Phase 5)
- Risk guards well-structured (position limits, daily loss cap, portfolio floor kill switch)
- Telegram bot comprehensive — `/scores`, `/rotations`, `/risk`, `/killswitch`, `/pnl`, `/notify` (Phase 4.5)
- P&L dashboard panel — today/7d/30d/total with portfolio value chart (Phase 4.5)
- Per-asset strategy parameter injection working for all assets including registry assets (Phase 5.5)
- SMA strategy enhanced with EMA, volume filter, RSI filter (Phase 5)
- TOTP authentication on dashboard (Phase 5)
- MCP circuit breaker auto-pauses on server failure and resumes when healthy

---

## Recommended Next Actions (Priority Order)

1. **Verify deployed image version** — confirm the running container includes Phase 5.5 changes. Check dashboard Asset Management: if ETH, CBBTC, CBETH appear with individual strategy controls, Phase 5.5 is live. If not, rebuild and redeploy from latest image.
2. **Fix `DRY_RUN` parsing** — `src/config.ts` line 28, one-line fix, zero risk
3. **Lower trade thresholds** in live `.env` on RPi5: `PRICE_DROP_THRESHOLD_PCT=1.0`, `PRICE_RISE_TARGET_PCT=1.5` — or switch to grid strategy for ETH in ranging conditions
4. **Fix rotation leg 2 USDC sizing** — `src/trading/executor.ts` `executeRotation()` — pass explicit buy amount from optimizer rather than re-reading full USDC balance
5. **Tune optimizer thresholds** via dashboard Settings (no restart needed): lower `ROTATION_BUY_THRESHOLD` to 20, `MIN_ROTATION_SCORE_DELTA` to 25
6. **Consider candle warmup pre-population** — on startup, synthesise historical candles from the existing `snapshots` table to eliminate the 6.5-hour optimizer blind spot after restarts

---

## Key File Locations

| File | Purpose |
|------|---------|
| `src/config.ts` | Zod env parsing — `DRY_RUN` bug is here |
| `src/trading/executor.ts` | Trade execution — leg 2 USDC bug + `as any` cast |
| `src/trading/engine.ts` | Strategy loops — per-asset loops for all assets (Phase 5.5+); global ETH loop removed |
| `src/trading/optimizer.ts` | Portfolio rotation — scoring, risk checks, rotation detection |
| `src/strategy/threshold.ts` | Threshold strategy — `dropPct`/`risePct` logic |
| `src/strategy/sma.ts` | SMA/EMA strategy with volume + RSI filters (Phase 5) |
| `src/strategy/candle.ts` | RSI, MACD, Bollinger Bands, volume scoring — needs 26 candles to warm up |
| `src/strategy/grid.ts` | Grid trading — auto-bounds from 24hr candles (Phase 5) |
| `src/assets/registry.ts` | Static asset list (ETH, USDC, CBBTC, CBETH) |
| `stack.env.example` | Portainer deployment template (not the live env) |
