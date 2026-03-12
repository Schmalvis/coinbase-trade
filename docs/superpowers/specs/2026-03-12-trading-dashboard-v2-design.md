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

| Component | Keys subscribed | Reaction |
|---|---|---|
| `TradingEngine` | `STRATEGY`, `TRADE_INTERVAL_SECONDS`, `PRICE_DROP_THRESHOLD_PCT`, `PRICE_RISE_TARGET_PCT`, `SMA_SHORT_WINDOW`, `SMA_LONG_WINDOW` | Clears interval, rebuilds strategy instance, restarts interval |
| `TradeExecutor` | `DRY_RUN`, `MAX_TRADE_SIZE_ETH`, `MAX_TRADE_SIZE_USDC`, `TRADE_COOLDOWN_SECONDS` | Updates in-memory values immediately (no restart needed) |
| `PortfolioTracker` | `POLL_INTERVAL_SECONDS` | Clears and restarts poll interval |

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

### RuntimeConfig API (`src/core/runtime-config.ts`)

```typescript
class RuntimeConfig {
  get(key: ConfigKey): ConfigValue        // typed getter
  set(key: ConfigKey, value: unknown)     // validates, writes DB, fires event
  subscribe(key, callback)                // single key listener
  subscribeMany(keys[], callback)         // multi-key listener
  getAll(): Record<ConfigKey, ConfigValue> // snapshot for API
}
```

- `set()` rejects unknown keys and values that fail type/range validation (returns error, does not throw)
- All 18 existing config keys are managed: `STRATEGY`, `TRADE_INTERVAL_SECONDS`, `POLL_INTERVAL_SECONDS`, `PRICE_DROP_THRESHOLD_PCT`, `PRICE_RISE_TARGET_PCT`, `SMA_SHORT_WINDOW`, `SMA_LONG_WINDOW`, `MAX_TRADE_SIZE_ETH`, `MAX_TRADE_SIZE_USDC`, `TRADE_COOLDOWN_SECONDS`, `DRY_RUN`, `LOG_LEVEL`, `WEB_PORT`, `MCP_SERVER_URL`, `NETWORK_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`, `DATA_DIR`
- Read-only keys (`WEB_PORT`, `DATA_DIR`, `MCP_SERVER_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`) are exposed in `getAll()` but rejected by `set()` with a clear error

### New API Endpoints

Added to `src/web/server.ts`:

| Method | Path | Body / Query | Response |
|---|---|---|---|
| `GET` | `/api/settings` | — | All current RuntimeConfig values |
| `POST` | `/api/settings` | `{ key, value }` | `{ ok, key, value }` or `{ error }` |
| `GET` | `/api/quote` | `?from=ETH&to=USDC&amount=X&side=from\|to` | `{ fromAmount, toAmount, priceImpact }` or `{ error }` |
| `POST` | `/api/trade` | `{ from, to, amount, side }` | `{ ok, txHash?, dryRun }` or `{ error }` |

**Quote `side` parameter:**
- `side=from` — "spend exactly X of the `from` token" (standard)
- `side=to` — "receive exactly X of the `to` token" (API fetches inverse quote)

**Trade endpoint** routes through `TradeExecutor.execute()` — respects cooldown, dry run flag, and position limits. Fires botState trade event (triggers Telegram notification).

### Updated `src/mcp/tools.ts`

No new MCP tools needed. The existing `getSwapPrice` and `swap` methods cover the trade form requirements.

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

- Strategy selector: `THRESHOLD` / `SMA` pill buttons (updates shown params below)
- **When THRESHOLD active:**
  - Drop % trigger (`PRICE_DROP_THRESHOLD_PCT`) — number input, range 0.1–50
  - Rise % target (`PRICE_RISE_TARGET_PCT`) — number input, range 0.1–100
- **When SMA active:**
  - Short window (`SMA_SHORT_WINDOW`) — integer input, min 2
  - Long window (`SMA_LONG_WINDOW`) — integer input, min 3, must be > short window

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
- SAVE button → `POST /api/settings` for each changed key in sequence → closes on success
- Individual field errors shown inline (e.g. "Short window must be less than long window")
- Unsaved changes prompt confirmation on close

---

### Trade Modal

Triggered by: Buy button (pre-fills ETH→USDC), Sell button (pre-fills USDC→ETH), or a standalone `TRADE` button added to the controls row.

**Flow:**

```
1. Token pair display: [FROM token] → [TO token] (swap arrow to reverse)
2. Amount field + side toggle: [SPEND] / [RECEIVE]
   - SPEND: "I want to spend X [from token]"
   - RECEIVE: "I want to receive X [to token]"
3. GET QUOTE button
   → calls GET /api/quote
   → shows: "Spend ~0.0148 ETH → Receive 50.00 USDC"
   → shows price impact warning if > 1% (amber) or > 3% (red)
4. CONFIRM button (disabled until quoted, re-disabled after click)
   → calls POST /api/trade
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

### Settings Change

```
User edits field → clicks SAVE
  → POST /api/settings { key, value }
  → RuntimeConfig.set(key, value)
      → validates type + range
      → writes to SQLite settings table
      → updates in-memory value
      → fires typed event
  → subscribed component reconfigures live
  → 200 OK → modal closes
  → next /api/status poll reflects new values
```

### Trade

```
User opens Trade modal, enters amount, clicks GET QUOTE
  → GET /api/quote?from=ETH&to=USDC&amount=50&side=to
  → tools.getSwapPrice(...)
  → { fromAmount: "0.0148", toAmount: "50.00", priceImpact: "0.02%" }
  → modal renders quote

User clicks CONFIRM
  → POST /api/trade { from: "ETH", to: "USDC", amount: "50", side: "to" }
  → TradeExecutor.execute()
      → respects cooldown, dry run, max size limits
      → calls tools.swap() if not dry run
      → writes to trades DB table
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
      → overlays each saved key over default
  → components initialise from RuntimeConfig.get(key)
  → saved settings are live immediately
```

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Unknown key in `POST /api/settings` | 400 `{ error: "Unknown config key: X" }` |
| Value fails validation in `POST /api/settings` | 400 `{ error: "POLL_INTERVAL_SECONDS must be >= 5" }` |
| Read-only key in `POST /api/settings` | 400 `{ error: "X is read-only and cannot be changed at runtime" }` |
| Quote fetch fails (MCP unavailable) | 503 `{ error: "Could not fetch quote: ..." }` — modal shows error, stays open |
| Trade fails (cooldown active) | 400 `{ error: "Cooldown active, X seconds remaining" }` — modal shows error |
| Trade fails (insufficient balance) | 400 `{ error: "Insufficient ETH balance" }` — modal shows error |
| Component reconfiguration error | Logged as error, component retains previous config, no crash |

---

## Files to Create / Modify

### New Files
- `src/core/runtime-config.ts` — RuntimeConfig class

### Modified Files
- `src/data/db.ts` — add `settings` table + queries (`getSetting`, `setSetting`, `getAllSettings`)
- `src/core/state.ts` — no change (runtime config is separate concern)
- `src/trading/engine.ts` — swap `config.*` reads for `runtimeConfig.get()`, add subscriptions
- `src/trading/executor.ts` — swap `config.*` reads for `runtimeConfig.get()`, add subscriptions
- `src/portfolio/tracker.ts` — swap `config.*` reads for `runtimeConfig.get()`, add subscription
- `src/index.ts` — instantiate `RuntimeConfig`, pass to components and web server
- `src/web/server.ts` — accept `runtimeConfig`, add `/api/settings`, `/api/quote`, `/api/trade` endpoints
- `src/web/public/index.html` — Settings modal, Trade modal, Faucet modal, header SETTINGS button

### Unchanged Files
- `src/config.ts` — remains the env/Zod defaults source only
- `src/mcp/client.ts` — no change
- `src/mcp/tools.ts` — no change (existing methods sufficient)
- `src/telegram/bot.ts` — no change
- `src/strategy/base.ts`, `threshold.ts`, `sma.ts` — no change

---

## Out of Scope (This Phase)

- DeFi integrations (Compound, Morpho, WETH wrapping)
- Token transfers
- ENS registration
- Additional trading pairs beyond ETH/USDC
- Log viewer in UI
- Telegram bot settings commands
