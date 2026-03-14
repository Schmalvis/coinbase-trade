# Planned Improvements

This file is the authoritative list of outstanding improvements for the coinbase-trade bot.
Each item includes enough context for an AI coding assistant to implement without further research.
Items are ordered by priority.

For detailed step-by-step implementation plans, see `docs/superpowers/plans/`.

---

## 1. Per-Asset Strategy Parameter Injection

**Status:** Known limitation — partially implemented but not wired
**Priority:** High
**Plan:** No dedicated plan file — implement directly

### Background

The `discovered_assets` DB table stores per-asset strategy configuration:
```sql
CREATE TABLE discovered_assets (
  address     TEXT PRIMARY KEY,
  symbol      TEXT NOT NULL,
  decimals    INTEGER NOT NULL DEFAULT 18,
  drop_pct    REAL NOT NULL DEFAULT 2.0,   -- per-asset buy threshold
  rise_pct    REAL NOT NULL DEFAULT 3.0,   -- per-asset sell target
  ...
);
```

The Asset Management modal in the dashboard (`src/web/public/index.html`) lets the user set
`drop_pct` / `rise_pct` per discovered asset. These values are saved to the DB via
`PUT /api/assets/:address/config` in `src/web/server.ts`. They are displayed correctly in the UI.

However, `src/trading/engine.ts` creates `ThresholdStrategy` instances for discovered-asset
loops using the **global** `PRICE_DROP_THRESHOLD_PCT` and `PRICE_RISE_TARGET_PCT` from
`RuntimeConfig` — ignoring the per-asset DB values entirely.

### What Needs Changing

**`src/strategy/threshold.ts`** — `ThresholdStrategy` constructor currently reads from
`RuntimeConfig` internally. It needs to accept explicit `dropPct` and `risePct` params:

```typescript
// CURRENT (reads global config internally)
const strategy = new ThresholdStrategy(runtimeConfig);

// TARGET (accepts explicit overrides)
const strategy = new ThresholdStrategy(runtimeConfig, { dropPct: 2.5, risePct: 4.0 });
// When explicit params provided, use them; otherwise fall back to runtimeConfig values
```

**`src/trading/engine.ts`** — `TradingEngine.startDiscoveredAssetLoops()` (or equivalent)
should read per-asset config from DB before starting each loop:

```typescript
const assetConfig = discoveredAssetQueries.getAsset.get(asset.address);
const strategy = new ThresholdStrategy(runtimeConfig, {
  dropPct: assetConfig?.drop_pct,
  risePct: assetConfig?.rise_pct,
});
```

**`src/strategy/sma.ts`** — same pattern if SMA strategy is used for discovered assets:
accept explicit `shortWindow` / `longWindow` params.

### Verification

After implementing:
1. Set custom `drop_pct=1.0` / `rise_pct=1.5` for a discovered asset via the dashboard
2. Confirm bot logs show the asset loop using those values, not the global defaults
3. Unit test: `ThresholdStrategy` instantiated with explicit params uses them; without params,
   falls back to `runtimeConfig.get('PRICE_DROP_THRESHOLD_PCT')`

---

## 2. Multi-Chain Support (Ethereum, Arbitrum, Optimism, Polygon)

**Status:** Not started
**Priority:** Medium
**Full plan:** `docs/superpowers/plans/2026-03-13-multi-chain-support.md`

### Summary

The architecture already supports multiple networks (comma-separated `NETWORK_ID`, `botState.setNetwork()`,
`onNetworkChange()` listener, `network` column in `trades` table). The gaps are:

1. **Asset registry** (`src/assets/registry.ts`) only has Base mainnet/sepolia addresses
2. **`asset_snapshots` table** has no `network` column — data from different chains gets mixed
3. **DefiLlama price fetcher** in `src/portfolio/tracker.ts` hardcodes `base:${addr}` prefix
4. **No `/api/network` switch endpoint** (exists for the MCP server switch but not for chain switch)
5. **No dashboard network switcher UI**

### New Assets / Chains to Add

| Chain | NETWORK_ID | Key assets |
|---|---|---|
| Ethereum Mainnet | `ethereum-mainnet` | ETH, USDC (`0xA0b86991...`), CBETH (`0xBe989514...`), SKY (`0x56072C95...`) |
| Arbitrum | `arbitrum-mainnet` | ETH, USDC (`0xaf88d065...`) |
| Optimism | `optimism-mainnet` | ETH, USDC |
| Polygon | `polygon-mainnet` | ETH (MATIC), USDC |

SKY (MakerDAO governance token) — Ethereum mainnet only, `tradeMethod: 'enso'`.
Verify Pyth `SKY/USD` feed exists before using `priceSource: 'pyth'`; fall back to `defillama`.

**DefiLlama chain prefix map** (add to `src/assets/registry.ts`):
```typescript
export const DEFILLAMA_PREFIX: Record<string, string> = {
  'base-mainnet':     'base',
  'base-sepolia':     'base',
  'ethereum-mainnet': 'ethereum',
  'arbitrum-mainnet': 'arbitrum',
  'optimism-mainnet': 'optimism',
  'polygon-mainnet':  'polygon',
};
```

### Conventions
- TypeScript ESM — all imports use `.js` extensions even for `.ts` source files
- `better-sqlite3` is synchronous — never `await` DB calls
- DB migration: `ALTER TABLE` in try/catch — never drop tables
- MCP calls are live network I/O — always mock in tests
- `botState` is a singleton — do not instantiate it

See the full plan at `docs/superpowers/plans/2026-03-13-multi-chain-support.md` for step-by-step
SQL migrations, code snippets, and a verification checklist.

---

## 3. MCP Server Wallet Address Monitoring

**Status:** Not implemented — identified 2026-03-14 after incident
**Priority:** High
**Plan:** No plan file — implement directly

### Background

On 2026-03-13 23:51, the `coinbase-mcp-server` image was auto-updated by Watchtower. The new
image created a fresh random EVM wallet instead of restoring the previous one. The trade bot
kept running, polling the new MCP server, but the wallet address had silently changed from
`0x7dD5Acd498BCF96832f82684584734cF48c7318D` to `0x5F814507117A1Ee4EdD916ff5ef418dF78aB1142`.
ETH purchased and sent to the old address became inaccessible until manually restored.

The bot had **no detection or alerting** for this scenario.

### What to Build

**`src/portfolio/tracker.ts`** — after fetching wallet details on each poll, compare the
returned address against a stored expected address:

```typescript
// On first successful fetch, store expected address
if (!expectedWalletAddress) {
  expectedWalletAddress = wallet.address;
  queries.upsertSetting.run('EXPECTED_WALLET_ADDRESS', wallet.address); // persist
  logger.info(`Wallet address established: ${wallet.address}`);
  return;
}

// On subsequent fetches, compare
if (wallet.address.toLowerCase() !== expectedWalletAddress.toLowerCase()) {
  const msg = `⚠️ WALLET ADDRESS CHANGED: expected ${expectedWalletAddress}, got ${wallet.address}`;
  logger.error(msg);
  botState.setPaused(true); // halt trading immediately
  // Emit Telegram alert (botState.emitAlert or similar)
}
```

Load `expectedWalletAddress` from the `settings` DB table on startup (key: `EXPECTED_WALLET_ADDRESS`).
If not set, populate on first successful poll.

**Telegram alert** — add a new alert type to `src/telegram/bot.ts` or use an existing
`botState.emitTrade`-style event to send a high-priority message to the configured chat ID.

**Dashboard** — show the active wallet address in the status section so it's immediately
visible if wrong.

**Reset command** — add `/resetwallet` Telegram command (and `/api/wallet/reset` endpoint)
that clears `EXPECTED_WALLET_ADDRESS` from the settings table, allowing the bot to
re-establish after a deliberate wallet change.

---

## 4. MCP Server Resilience / Graceful Degradation

**Status:** Not implemented
**Priority:** Medium
**Plan:** No plan file — implement directly

### Background

When the `coinbase-mcp-server` container is restarting (e.g. after a Watchtower update),
the trade bot's MCP calls fail with connection errors. Currently these are logged as errors
but the bot continues its poll loop, accumulating failures silently.

### What to Build

**Exponential backoff on MCP failures** — in `src/mcp/client.ts`, track consecutive
failure count. After N failures (e.g. 3), pause the bot automatically and log a clear
warning. Resume automatically when MCP calls succeed again.

**Health check endpoint on MCP server** — the coinbase-mcp-server exposes `GET /health`
(it's in the Portainer health check config). The trade bot can poll this before attempting
tool calls, and skip the poll cycle if the server is not healthy:

```typescript
// In portfolio tracker or MCPClient
const health = await fetch(`${MCP_SERVER_URL.replace('/mcp', '')}/health`).catch(() => null);
if (!health?.ok) {
  logger.warn('MCP server not healthy — skipping poll cycle');
  return;
}
```

**Telegram alert** — send a Telegram message when MCP server goes unhealthy, and another
when it recovers.

**Circuit breaker state in dashboard** — expose MCP health status in `GET /api/status`:
```json
{ "mcpStatus": "healthy" | "unhealthy", "mcpConsecutiveFailures": 0 }
```

---

## 5. Telegram /status Shows Wallet Addresses

**Status:** Not implemented
**Priority:** Low
**Plan:** No plan file — small change

### What to Build

The `/status` Telegram command currently shows network, balances, price, and bot state.
It should also show the active wallet address per network, so wallet changes are immediately
obvious when checking status:

```
📊 Status
Network: base-mainnet
Wallet: 0x7dD5Acd...8D
ETH: 0.12345 ($320.40)
USDC: 45.23
Price: $2,601.82
Strategy: threshold
Bot: running
```

**Implementation:** `src/telegram/bot.ts` — in the `/status` handler, add the wallet address
from `botState` (add a `walletAddress` field to `BotState` or read from `settings` DB).

---

## Key Files Reference

| File | Purpose |
|---|---|
| `src/core/state.ts` | `BotState` singleton — balances, price, network, trade events |
| `src/core/runtime-config.ts` | Live-reloadable settings from DB |
| `src/data/db.ts` | SQLite schema, all prepared statements |
| `src/mcp/client.ts` | `MCPClient` — injects network into every tool call |
| `src/mcp/tools.ts` | Typed wrappers for Coinbase AgentKit MCP tools |
| `src/assets/registry.ts` | Static asset registry (ETH, USDC, CBBTC, CBETH) |
| `src/portfolio/tracker.ts` | Polls balances/prices per asset, Alchemy ERC20 discovery |
| `src/strategy/threshold.ts` | Buy on drop %, sell on rise % strategy |
| `src/strategy/sma.ts` | SMA crossover strategy |
| `src/trading/engine.ts` | Runs strategy loop(s), calls executor |
| `src/trading/executor.ts` | Risk checks + swap execution |
| `src/web/server.ts` | Express API + static file server |
| `src/web/public/index.html` | Dashboard (vanilla JS, Chart.js) |
| `src/telegram/bot.ts` | Telegraf bot for Telegram commands |
| `src/services/alchemy.ts` | ERC20 token discovery via Alchemy JSON-RPC |

## Conventions (do not deviate)

- TypeScript ESM — all imports use `.js` extensions even for `.ts` source files
- `better-sqlite3` is synchronous — never `await` DB calls
- DB migration: `CREATE TABLE IF NOT EXISTS` — never drop existing tables
- MCP calls are live network I/O — always mock in tests
- `botState` is a singleton from `src/core/state.ts` — do not instantiate it
- `runtimeConfig.get('KEY')` for live-reloadable settings; `config.KEY` for boot-time-only config
- Ports must be env vars — never hardcode in `docker-compose.yml`

## Dev Environment

```bash
# Install deps
npm install

# Type check
npx tsc --noEmit

# Run tests
npm test

# Dev server (live reload, Pi)
cd /home/pi/share/coinbase-trade && npm run dev

# Check bot API
curl http://192.168.68.139:3003/api/status | jq
```

## Active Deployment

- **Container:** `coinbase-trade` on RPi5 (`192.168.68.139`), Portainer stack ID 68
- **Dashboard:** `http://192.168.68.139:3003`
- **MCP server:** `http://192.168.68.139:3002/mcp` (stack ID 67)
- **Testnet wallet:** `0x9123528571C6aD8fe80eb0cC82f6a388311A3104`
- **Mainnet wallet:** `0x7dD5Acd498BCF96832f82684584734cF48c7318D`
