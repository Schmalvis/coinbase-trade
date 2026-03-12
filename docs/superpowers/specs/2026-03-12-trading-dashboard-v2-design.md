# Trading Dashboard v2 — Design Spec
**Date:** 2026-03-12
**Project:** coinbase-trade
**Status:** Approved

---

## Overview

Extend the existing autonomous trading bot dashboard with full user intervention capabilities: live strategy configuration, a proper trade form with price quotes, persistent runtime settings, and improved faucet controls. The bot continues to operate autonomously; the UI adds a control layer on top.

**Scope:** Bot control and configuration only. No new DeFi integrations (Compound, Morpho, WETH, etc.) in this phase.

---

## Architecture

### RuntimeConfig Module

A new `src/core/runtime-config.ts` module sits between the static `.env` config and all running components.

```
.env → config.ts (Zod, read-once at startup)
              ↓
       RuntimeConfig         ← overlays SQLite `settings` table at startup
       (in-memory, live)     ← writes back to SQLite on change
              ↓              ← emits typed change events
    ┌─────────┬──────────┬────────────┐
  Engine   Executor   Tracker    WebServer
```

At startup, `RuntimeConfig` initialises from `config` (env) as defaults, then overlays any rows from the `settings` table. All components read from `RuntimeConfig` rather than `config` directly. When a setting changes via the UI, `RuntimeConfig.set(key, value)` writes to the DB and fires a typed event.

The existing `config.ts` remains unchanged — it becomes the source of defaults only.

### Component Subscriptions

Both `TradingEngine` and `PortfolioTracker` must store their `setInterval` return values (currently they do not) so that intervals can be cleared and restarted on config change. This is a prerequisite refactor noted explicitly in the file changes below.

| Component | Keys subscribed | Reaction |
|---|---|---|
| `TradingEngine` | `STRATEGY`, `TRADE_INTERVAL_SECONDS`, `PRICE_DROP_THRESHOLD_PCT`, `PRICE_RISE_TARGET_PCT`, `SMA_SHORT_WINDOW`, `SMA_LONG_WINDOW` | Clears stored interval handle, rebuilds strategy instance, restarts interval |
| `TradeExecutor` | `DRY_RUN`, `MAX_TRADE_SIZE_ETH`, `MAX_TRADE_SIZE_USDC`, `TRADE_COOLDOWN_SECONDS` | Updates in-memory values immediately (no restart needed) |
| `PortfolioTracker` | `POLL_INTERVAL_SECONDS` | Clears stored interval handle, restarts poll interval |

---

## Backend Changes

### New DB Table

Added to `src/data/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
)
```

Non-scalar values (`TELEGRAM_ALLOWED_CHAT_IDS`, which is `number[]`) are serialised as JSON strings in the `value` column and deserialised by `RuntimeConfig` on read. All other values are stored as plain strings.

### RuntimeConfig API (`src/core/runtime-config.ts`)

```typescript
class RuntimeConfig {
  get(key: ConfigKey): ConfigValue                    // typed getter
  set(key: ConfigKey, value: unknown): void           // validates, writes DB, fires event; throws on invalid
  setBatch(changes: Partial<Record<ConfigKey, unknown>>): void  // validates all, writes all to DB, updates all in-memory, then fires events
  subscribe(key: ConfigKey, callback: (v: ConfigValue) => void): void
  subscribeMany(keys: ConfigKey[], callback: () => void): void
  getAll(): Record<ConfigKey, ConfigValue>            // snapshot for API
}
```

**`setBatch()` event order:** all values are validated, written to DB, and updated in-memory before any change events are fired. This ensures that when a subscriber reacts (e.g. `TradingEngine` rebuilds its strategy on a `STRATEGY` change), all related keys (e.g. `SMA_LONG_WINDOW`) are already at their new values in memory. `subscribeMany` callbacks fire once after all events from the batch are processed.

**Key classification:**

| Category | Keys | Behaviour |
|---|---|---|
| Writable + hot-reload | `STRATEGY`, `TRADE_INTERVAL_SECONDS`, `POLL_INTERVAL_SECONDS`, `PRICE_DROP_THRESHOLD_PCT`, `PRICE_RISE_TARGET_PCT`, `SMA_SHORT_WINDOW`, `SMA_LONG_WINDOW`, `MAX_TRADE_SIZE_ETH`, `MAX_TRADE_SIZE_USDC`, `TRADE_COOLDOWN_SECONDS`, `DRY_RUN`, `LOG_LEVEL` | Persisted + event fired |
| Read-only (displayed only) | `WEB_PORT`, `DATA_DIR`, `MCP_SERVER_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`, `NETWORK_ID` | Exposed in `getAll()`, rejected by `set()` with 400 |

`NETWORK_ID` is read-only in RuntimeConfig because network switching is managed separately via `botState.setNetwork()` and `/api/network`. Merging the two paths would create conflicting state.

`LOG_LEVEL` is writable; the logger reads `runtimeConfig.get('LOG_LEVEL')` on each call rather than caching it at startup.

### Updated `/api/status`

`/api/status` currently reads `config.DRY_RUN` and `config.STRATEGY` directly from the static config. Once RuntimeConfig is in place, it must read from `runtimeConfig.get('DRY_RUN')` and `runtimeConfig.get('STRATEGY')` so the UI reflects live values after a settings change.

### New API Endpoints

Added to `src/web/server.ts`:

| Method | Path | Body / Query | Response |
|---|---|---|---|
| `GET` | `/api/settings` | — | All current RuntimeConfig values (`getAll()`) |
| `POST` | `/api/settings` | `{ changes: Record<ConfigKey, unknown> }` | `{ ok: true }` or `{ error, field? }` |
| `GET` | `/api/quote` | `?from=ETH&to=USDC&amount=X&side=from\|to` | `{ fromAmount, toAmount, priceImpact }` or `{ error }` |
| `POST` | `/api/trade` | `{ from, to, fromAmount }` | `{ ok, txHash?, dryRun }` or `{ error }` |

**Settings batch endpoint:** `POST /api/settings` accepts all changed keys in a single body. It calls `runtimeConfig.setBatch(changes)` which validates every key before applying any — preventing partial-apply states (e.g. `STRATEGY=sma` firing before `SMA_LONG_WINDOW` is updated). Returns 400 with the failing `field` if any key fails validation.

**Quote `side` parameter:**
- `side=from` (default) — "spend exactly X of the `from` token": calls `getSwapPrice(from, to, amount)` directly
- `side=to` — "receive exactly X of the `to` token": calls `getSwapPrice(from, to, estimatedFromAmount)` where `estimatedFromAmount` is derived from a preliminary quote at a fixed reference amount. This is best-effort — the displayed quote shows the estimated `fromAmount` needed. The user sees the approximation and confirms before executing.

**Trade endpoint:** calls `TradeExecutor.executeManual(from, to, fromAmount)` — a new method (see below) that respects cooldown and dry-run but uses the caller-supplied amount directly, bypassing the automatic sizing logic. `fromAmount` is always specified in terms of the `from` token (from the quote's `fromAmount` field).

### Updated `src/mcp/tools.ts`

`tools.ts` is **modified** (not unchanged as originally stated). The `side=to` quote path always uses two-step estimation — the underlying MCP tool (`CdpEvmWalletActionProvider_get_swap_price`) only accepts `fromAmount`, there is no `toAmount` input. The estimation flow:

1. Call `getSwapPrice(from, to, REFERENCE_AMOUNT)` at a fixed reference amount (e.g. `"1"`) to get the approximate exchange rate.
2. Compute `estimatedFromAmount = desiredToAmount / rate`.
3. Call `getSwapPrice(from, to, estimatedFromAmount)` to get the real quote.
4. Return the result of step 3.

No conditional "if the API supports toAmount" path — always use two-step estimation.

### Updated `src/trading/executor.ts`

Add `executeManual(from: TokenSymbol, to: TokenSymbol, fromAmount: string): Promise<void>`:
- Checks cooldown (same as `execute()`)
- Checks dry-run flag (same as `execute()`)
- Does **not** apply the 10%-of-balance or max-size cap — amount is taken as given
- Calls `tools.swap(from, to, fromAmount)` directly
- Derives `amount_eth` for the DB write using the same pattern as `execute()`: `from === 'ETH' ? parseFloat(fromAmount) : parseFloat(fromAmount) / (currentPrice || 1)`
- Writes to `trades` DB table with `reason = 'manual'`
- Emits `botState` trade event (Telegram notification fires)

The Telegram bot's `/buy` and `/sell` commands already route through `engine.manualTrade()` which calls the existing `execute()` with automatic sizing. They continue to work unchanged and will respect any cooldown/dry-run changes made via the Settings modal because `TradeExecutor` subscribes to those keys.

---

## Frontend Changes

### New Controls

**Header:** Add a `SETTINGS` button (text, existing button style) in the header-right group alongside the theme toggle.

**Existing buttons:** Buy and Sell buttons now open the Trade modal pre-filled with direction, instead of firing `confirm()` dialogs.

**Faucet button:** Opens the Faucet modal instead of firing immediately.

---

### Settings Modal

Triggered by: `SETTINGS` header button.

**Structure:** Modal overlay with two tabs — `STRATEGY` and `TRADING`.

#### Strategy Tab

- Strategy selector: `THRESHOLD` / `SMA` pill buttons (shows/hides relevant param fields below)
- **When THRESHOLD active:**
  - Drop % trigger (`PRICE_DROP_THRESHOLD_PCT`) — number input, range 0.1–50
  - Rise % target (`PRICE_RISE_TARGET_PCT`) — number input, range 0.1–100
- **When SMA active:**
  - Short window (`SMA_SHORT_WINDOW`) — integer input, min 2
  - Long window (`SMA_LONG_WINDOW`) — integer input, min 3, must be > short window (validated before save)

#### Trading Tab

- Dry Run toggle (`DRY_RUN`) — amber highlight when enabled
- Max trade size ETH (`MAX_TRADE_SIZE_ETH`) — number input, min 0.0001
- Max trade size USDC (`MAX_TRADE_SIZE_USDC`) — number input, min 0.01
- Cooldown seconds (`TRADE_COOLDOWN_SECONDS`) — integer input, min 0
- Poll interval seconds (`POLL_INTERVAL_SECONDS`) — integer input, min 5
- Trade interval seconds (`TRADE_INTERVAL_SECONDS`) — integer input, min 5

**Behaviour:**
- Fields initialised from `GET /api/settings` on modal open
- Edits are staged in local state (no immediate API calls)
- SAVE button → single `POST /api/settings { changes: { ...dirtyFields } }` → closes on success
- Individual field errors shown inline if server returns `{ error, field }`
- Unsaved changes prompt confirmation on close

---

### Trade Modal

Triggered by: Buy button (pre-fills ETH→USDC), Sell button (pre-fills USDC→ETH), or a standalone `TRADE` button added to the controls row.

**Flow:**

```
1. Token pair display: [FROM token] → [TO token] (swap arrow to reverse)
2. Amount field + side toggle: [SPEND] / [RECEIVE]
   - SPEND (side=from): "I want to spend X [from token]"
   - RECEIVE (side=to): "I want to receive ~X [to token]" (best-effort quote)
3. GET QUOTE button
   → calls GET /api/quote?from=ETH&to=USDC&amount=X&side=from|to
   → shows: "Spend ~0.0148 ETH → Receive ~50.00 USDC"
   → shows note "(estimated)" for side=to quotes
   → shows price impact warning if > 1% (amber) or > 3% (red)
4. CONFIRM button (disabled until quoted, re-disabled after click)
   → calls POST /api/trade { from, to, fromAmount }
     (fromAmount is always taken from the quote's fromAmount field)
   → shows result inline:
       Success: "✓ Trade executed" + tx hash link (or "[dry run]")
       Error:   "✗ [error message]" — modal stays open
```

**Available pairs:** ETH → USDC and USDC → ETH (the only pairs currently supported by the executor).

---

### Faucet Modal

Triggered by: existing `FAUCET` button (testnet only).

- Two buttons: `REQUEST ETH` and `REQUEST USDC`
- Each button independently calls `POST /api/faucet { assetId: 'eth'|'usdc' }`
- Per-button state: idle → "Requesting…" → "Sent!" (5s) → idle
- Buttons disabled while a request is in flight

---

## Data Flows

### Settings Change (Batch)

```
User edits fields → clicks SAVE
  → POST /api/settings { changes: { STRATEGY: "sma", SMA_SHORT_WINDOW: 5, SMA_LONG_WINDOW: 20 } }
  → runtimeConfig.setBatch(changes)
      → validates ALL keys first (fails fast if any invalid, nothing applied)
      → writes all rows to SQLite settings table
      → updates all in-memory values
      → fires a single change event per key
  → subscribed components reconfigure live
  → 200 OK → modal closes
  → next /api/status poll reflects new values
```

### Trade

```
User opens Trade modal, enters amount=50, side=RECEIVE (side=to)
  → GET /api/quote?from=ETH&to=USDC&amount=50&side=to
  → tools.getSwapPrice(ETH, USDC, estimatedFromAmount)
  → { fromAmount: "0.0148", toAmount: "50.00", priceImpact: "0.02%" }
  → modal renders: "Spend ~0.0148 ETH → Receive ~50.00 USDC (estimated)"

User clicks CONFIRM
  → POST /api/trade { from: "ETH", to: "USDC", fromAmount: "0.0148" }
  → TradeExecutor.executeManual("ETH", "USDC", "0.0148")
      → checks cooldown
      → checks dry run
      → calls tools.swap("ETH", "USDC", "0.0148")
      → writes to trades DB table (reason: "manual")
      → emits botState trade event → Telegram notification fires
  → { ok: true, txHash: "0x..." } or { error: "..." }
  → modal shows result
```

### Settings Persistence on Restart

```
Bot starts
  → config.ts reads .env (Zod) → typed defaults
  → RuntimeConfig.init():
      → loads all defaults from config
      → SELECT * FROM settings
      → deserialises each row (JSON parse for array values)
      → overlays each saved key over default
  → components initialise from runtimeConfig.get(key)
  → saved settings are live immediately
```

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Unknown key in `POST /api/settings` | 400 `{ error: "Unknown config key: X", field: "X" }` |
| Value fails validation in `POST /api/settings` | 400 `{ error: "POLL_INTERVAL_SECONDS must be >= 5", field: "POLL_INTERVAL_SECONDS" }` |
| Read-only key in `POST /api/settings` | 400 `{ error: "NETWORK_ID is read-only", field: "NETWORK_ID" }` |
| Any key fails in batch → no keys applied | 400 with first failing field; all-or-nothing |
| Quote fetch fails (MCP unavailable) | 503 `{ error: "Could not fetch quote: ..." }` — modal shows error, stays open |
| Trade fails (cooldown active) | 400 `{ error: "Cooldown active, X seconds remaining" }` — modal shows error |
| Trade fails (insufficient balance) | 400 `{ error: "Insufficient ETH balance" }` — modal shows error |
| Component reconfiguration error | Logged as error, component retains previous config, no crash |

---

## Files to Create / Modify

### New Files
- `src/core/runtime-config.ts` — RuntimeConfig class

### Modified Files
- `src/core/logger.ts` — change `LOG_LEVEL` from a cached module-level constant to a per-call lookup via `runtimeConfig.get('LOG_LEVEL')`, enabling live log level changes
- `src/data/db.ts` — add `settings` table + queries (`getSetting`, `setSetting`, `getAllSettings`)
- `src/trading/engine.ts` — store interval handle; swap `config.*` reads for `runtimeConfig.get()`; add subscriptions; restart interval on config change
- `src/trading/executor.ts` — swap `config.*` reads for `runtimeConfig.get()`; add subscriptions; add `executeManual()` method
- `src/portfolio/tracker.ts` — store interval handle; swap `config.*` reads for `runtimeConfig.get()`; add subscription; restart interval on config change
- `src/mcp/tools.ts` — add optional `toAmount` support to `getSwapPrice()` for `side=to` quote path
- `src/index.ts` — instantiate `RuntimeConfig`; pass to `startPortfolioTracker`, `TradeExecutor`, `TradingEngine`, `startWebServer`; logger reads `runtimeConfig` for `LOG_LEVEL`
- `src/web/server.ts` — accept `runtimeConfig`; update `/api/status` to read `DRY_RUN`/`STRATEGY` from `runtimeConfig`; add `/api/settings`, `/api/quote`, `/api/trade` endpoints
- `src/web/public/index.html` — Settings modal, Trade modal, Faucet modal, header SETTINGS button, Buy/Sell wired to Trade modal

### Unchanged Files
- `src/config.ts` — remains the env/Zod defaults source only
- `src/mcp/client.ts` — no change
- `src/telegram/bot.ts` — no change (implicitly respects runtimeConfig changes via executor subscriptions)
- `src/strategy/base.ts`, `threshold.ts`, `sma.ts` — no change

---

## Out of Scope (This Phase)

- DeFi integrations (Compound, Morpho, WETH wrapping)
- Token transfers
- ENS registration
- Additional trading pairs beyond ETH/USDC
- Log viewer in UI
- Telegram bot settings commands
