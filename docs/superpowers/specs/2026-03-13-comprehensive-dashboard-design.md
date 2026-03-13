# Comprehensive Trading Dashboard — Design Spec
**Date:** 2026-03-13
**Project:** coinbase-trade
**Status:** Approved

---

## Overview

Extend the trading dashboard to support any ERC20 token currently held in the wallet. Alchemy scans the wallet at each poll cycle and surfaces newly discovered tokens inline. Users opt each token into autonomous strategy individually. The strategy engine runs an independent threshold/SMA loop per active asset. All assets are displayed in a dynamic table that replaces the current hardcoded ETH/USDC status grid. Dark and light mode are both supported via existing CSS variables.

**Autonomous trading is preserved** — the bot continues to operate without user intervention. The UI adds visibility and control, not a requirement to act.

---

## Architecture

```
Alchemy API (external)
       ↓
src/services/alchemy.ts          ← NEW: token balance + metadata fetcher
       ↓
src/portfolio/tracker.ts         ← MODIFIED: calls Alchemy each poll; inserts new discoveries
       ↓
src/data/db.ts                   ← MODIFIED: discovered_assets table + queries
       ↓
src/trading/engine.ts            ← MODIFIED: strategy map (symbol → interval); hot-add on enable
src/trading/executor.ts          ← MODIFIED: add executeForAsset() method
       ↓
src/web/server.ts                ← MODIFIED: asset management endpoints; portfolio sum fix
       ↓
src/web/public/index.html        ← MODIFIED: dynamic table, ASSETS badge, modal, inline actions
src/index.ts                     ← MODIFIED: instantiate AlchemyService; wire to tracker + engine
```

### Alchemy Service (`src/services/alchemy.ts`)

Thin HTTP wrapper — no MCP involved. Reads `ALCHEMY_API_KEY` from config. Network mapping: `base-mainnet` → `https://base-mainnet.g.alchemy.com/v2/${key}`, `base-sepolia` → `https://base-sepolia.g.alchemy.com/v2/${key}`.

**Constructor:**
```typescript
constructor(apiKey: string)
```
The `apiKey` is stored on the instance. Network-to-URL mapping is resolved per call.

**Type: `AlchemyTokenBalance`:**
```typescript
interface AlchemyTokenBalance {
  contractAddress: string; // checksummed ERC-20 address
  tokenBalance: string;    // hex-encoded balance (e.g. "0x1a2b..."); divide by 10^decimals for human amount
}
```

**Methods:**

`getTokenBalances(walletAddress: string, network: string): Promise<AlchemyTokenBalance[]>` — POST to `${networkUrl}`:
```json
{ "jsonrpc": "2.0", "method": "alchemy_getTokenBalances", "params": ["<walletAddress>", "erc20"], "id": 1 }
```
Read `response.result.tokenBalances` as `AlchemyTokenBalance[]`.

`getTokenMetadata(contractAddress: string, network: string): Promise<{ symbol: string; name: string; decimals: number }>` — POST to same URL:
```json
{ "jsonrpc": "2.0", "method": "alchemy_getTokenMetadata", "params": ["<contractAddress>"], "id": 1 }
```
Read `response.result` as `{ symbol, name, decimals }`.

Both are plain `fetch` calls to the Alchemy REST API. No caching — called fresh each poll cycle. If `ALCHEMY_API_KEY` is absent from config, `AlchemyService` is not instantiated and discovery is silently disabled (tracker skips the discovery step). If Alchemy is unavailable at runtime, the tracker logs a warning and skips discovery for that cycle — existing known assets still price normally.

### Portfolio Tracker

`startPortfolioTracker` updated signature — return type is preserved from existing implementation:

```typescript
export async function startPortfolioTracker(
  tools: CoinbaseTools,
  runtimeConfig: RuntimeConfig,
  alchemyService?: AlchemyService,
): Promise<() => void>
```

The third parameter is optional. `src/index.ts` passes the instance when `ALCHEMY_API_KEY` is configured; otherwise omits it and discovery is silently disabled. The `Promise<() => void>` return type is unchanged — the existing `pollNow` pattern in `index.ts` must continue to work (see Wiring section).

**`walletAddress` source:** the tracker already calls `tools.getWalletDetails()` at each poll cycle to obtain the current wallet address. The Alchemy call uses the same address: `wallet.address` (the field returned by `getWalletDetails()`). No new network call — reuse the existing `getWalletDetails()` call already present in the poll cycle.

At each poll cycle, after pricing all known (registry) assets:
1. If `alchemyService` is present: call `getTokenBalances(wallet.address, network)` — `walletAddress` from existing `tools.getWalletDetails()` call; `network` from `botState.activeNetwork`
2. For each returned token address, check against static registry addresses + `discovered_assets` table
3. If unknown: call `getTokenMetadata`, insert as `status = 'pending'` (`INSERT OR IGNORE` — idempotent)
4. After all inserts: call `botState.setPendingTokenCount(discoveredAssetQueries.getPendingAssets.all(network).length)`
5. For ALL assets with `status = 'active'` or `'pending'` in `discovered_assets`: price via DefiLlama `base:0xADDRESS`, write to `asset_snapshots`
6. For ALL active/pending discovered assets: parse the `tokenBalance` hex from Alchemy response (if present), convert to human amount (divide by `10 ** decimals`), call `botState.updateAssetBalance(symbol, humanAmount)`. If Alchemy did not return a balance entry for a known active/pending asset (e.g. zero-balance tokens may be omitted), call `botState.updateAssetBalance(symbol, 0)` explicitly — never leave stale non-zero values in `assetBalances`.

USDC pricing note: DefiLlama returns `~1.00` for USDC via `base:0x833589...` — no special-casing needed.

### Trading Engine

Currently: one `setInterval` loop for ETH↔USDC using the global strategy from `RuntimeConfig`.

Becomes: a `Map<string, NodeJS.Timeout>` of `symbol → interval handle`. On startup, the engine imports `queries` from `../data/db.js` directly (same pattern as `tracker.ts`) and calls `queries.getActiveDiscoveredAssets(network)` to load discovered assets that were previously enabled.

**`AssetStrategyParams` type** (used by `tickAsset`, `startAssetLoop`, `reloadAssetConfig`):
```typescript
interface AssetStrategyParams {
  strategyType: 'threshold' | 'sma';
  dropPct: number;
  risePct: number;
  smaShort: number;
  smaLong: number;
}
```
The per-asset loop interval is not configurable per asset — it uses `TRADE_INTERVAL_SECONDS` from `RuntimeConfig`, same as the static ETH/USDC loops.

**Per-asset tick function:**
`tickAsset(symbol: string, address: string, params: AssetStrategyParams): Promise<void>`

Each discovered-asset loop calls `tickAsset`:
1. Fetches using the existing `queries.recentAssetSnapshots` prepared statement (already in `db.ts` from the multi-asset phase): `.all(symbol, params.smaLong + 5)` — rows shaped `{ id, timestamp, symbol, price_usd, balance }`
2. Adapts rows to the shape strategy classes expect: `{ eth_price: row.price_usd, eth_balance: row.balance, portfolio_usd: 0, timestamp: row.timestamp }` — `timestamp` is required by the `Snapshot` interface
3. Instantiates a `ThresholdStrategy` or `SMAStrategy` with per-asset params (not `RuntimeConfig`)
4. Signal is type `Signal` (`'buy' | 'sell' | 'hold'`). Calls `executor.executeForAsset(symbol, signal, 'auto')` on any signal — `executeForAsset` guards internally and returns early on `'hold'`

Static ETH/USDC loops are unchanged — they continue calling the existing `tick()` with `recentSnapshots` and `RuntimeConfig` params.

**Hot-add/remove:**
- `engine.startAssetLoop(address: string, symbol: string, params: AssetStrategyParams): void` — called by `server.ts` after `POST /api/assets/:address/enable`. The strategy map is keyed by `symbol`; `address` is passed through to `tickAsset` for Alchemy response correlation but is not the map key.
- `engine.stopAssetLoop(symbol: string): void` — called by `server.ts` after `POST /api/assets/:address/dismiss` or strategy disabled. Clears the interval and deletes the entry from the map; no-ops silently if symbol is not in the map.
- `engine.reloadAssetConfig(symbol: string, params: AssetStrategyParams): void` — called by `server.ts` after `PUT /api/assets/:address/config`. Stops any existing loop for `symbol` (no-op if not running), then starts a new one. The `address` for the new loop is read from `discoveredAssetQueries.getDiscoveredAsset.get(address, network)` — the server passes it via `engine.reloadAssetConfig`; update the signature to also include `address: string` as first param: `reloadAssetConfig(address: string, symbol: string, params: AssetStrategyParams): void`.

**`TradingEngine` constructor:** the engine imports `botState` as a module-level import (same pattern as the existing `tick()` method). The constructor signature `(executor: TradeExecutor, runtimeConfig: RuntimeConfig)` is unchanged.

**On-startup loading:** load active discovered assets in the **constructor** (not in `start()`). This ensures the loop is created once. `start()` is called by `restart()` on every `STRATEGY_KEYS` config change — loading in `start()` would duplicate interval handles because `restart()` only clears `this.intervalId` (the static loop), not the per-asset map. In the constructor, after `this.strategy = this.buildStrategy()`:
```typescript
const activeAssets = discoveredAssetQueries.getActiveDiscoveredAssets.all(botState.activeNetwork);
for (const row of activeAssets) {
  this.startAssetLoop(row.address, row.symbol, {
    strategyType: row.strategy_type as 'threshold' | 'sma',
    dropPct: row.drop_pct, risePct: row.rise_pct,
    smaShort: row.sma_short, smaLong: row.sma_long,
  });
}
```
The per-asset `_assetLoops: Map<string, NodeJS.Timeout>` is a private instance field. It is NOT cleared or touched by `restart()`.

### Executor — new `executeForAsset` method

`TradeExecutor.executeForAsset(symbol: string, signal: Signal, reason: string): Promise<void>`

`Signal` is `'buy' | 'sell' | 'hold'` (from `src/strategy/base.ts`). The method accepts the full union and guards internally: returns early if `signal === 'hold'`. This matches the pattern in the existing `execute()` method.

- `signal === 'buy'`: swap USDC → `symbol` (spend USDC, receive token)
- `signal === 'sell'`: swap `symbol` → USDC (spend token, receive USDC)
- Respects `DRY_RUN` flag (same as `execute()`)
- Per-symbol cooldown: add `private _assetCooldowns: Map<string, Date> = new Map()` as an instance field on `TradeExecutor`. For each `executeForAsset` call, check `_assetCooldowns.get(symbol)` against `TRADE_COOLDOWN_SECONDS` (same config key as the existing cooldown). Update `_assetCooldowns.set(symbol, new Date())` after a successful trade. **Do NOT check the global `botState.lastTradeAt` cooldown** — the per-symbol map is the only cooldown gate for discovered assets, enabling parallel trading across symbols. Do NOT call `botState.recordTrade()` from `executeForAsset` (the global last-trade timestamp is only for the static ETH/USDC loop).
- Amount sizing: use 10% of available balance with no additional max-size cap (discovered tokens have no `MAX_TRADE_SIZE_*` config). `botState.assetBalances.get(symbol)` returns the human-readable decimal balance (written by the tracker — see Portfolio Tracker step 6). Use this value directly; no unit conversion needed.
- Calls `tools.swap(fromSymbol, toSymbol, amount.toString())` — `amount` is a `number`, convert with `.toString()` as per the existing `execute()` pattern
- Writes to `trades` table with `reason` set to the passed string (e.g. `'auto'`)
- Emits `botState` trade event (Telegram notification fires)

---

## Data Model

### New table: `discovered_assets`

```sql
CREATE TABLE IF NOT EXISTS discovered_assets (
  address       TEXT    NOT NULL,
  network       TEXT    NOT NULL,
  symbol        TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  decimals      INTEGER NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending',   -- 'pending' | 'active' | 'dismissed'
  strategy_type TEXT    NOT NULL DEFAULT 'threshold', -- 'threshold' | 'sma'
  quote_asset   TEXT    NOT NULL DEFAULT 'USDC',
  drop_pct      REAL    NOT NULL DEFAULT 3.0,
  rise_pct      REAL    NOT NULL DEFAULT 4.0,
  sma_short     INTEGER NOT NULL DEFAULT 5,
  sma_long      INTEGER NOT NULL DEFAULT 20,
  discovered_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (address, network)
)
```

**Design decisions:**
- Primary key is `(address, network)` — same token tracked independently per network
- Strategy params stored per asset; changing global RuntimeConfig does not retroactively affect saved per-asset config
- `quote_asset` is always USDC for now — every discovered asset trades X↔USDC
- Static registry assets (ETH, USDC, CBBTC, CBETH) are never inserted here — they use RuntimeConfig
- `asset_snapshots` table is unchanged — discovered assets write rows there by symbol, same as static assets

### New queries added to `src/data/db.ts`

Define `DiscoveredAssetRow` (used in Statement type annotations):
```typescript
interface DiscoveredAssetRow {
  address: string; network: string; symbol: string; name: string; decimals: number;
  status: string; strategy_type: string; quote_asset: string;
  drop_pct: number; rise_pct: number; sma_short: number; sma_long: number;
  discovered_at: string;
}
```

Follow the `settingQueries` pattern — export a separate `discoveredAssetQueries` object (typed explicitly like `settingQueries`, not added to `queries: Record<string, Statement>`):

```typescript
export const discoveredAssetQueries = {
  insertDiscoveredAsset: db.prepare(`
    INSERT OR IGNORE INTO discovered_assets
      (address, network, symbol, name, decimals)
    VALUES (?, ?, ?, ?, ?)
  `),

  getPendingAssets: db.prepare(
    `SELECT * FROM discovered_assets WHERE status = 'pending' AND network = ?`
  ) as Statement<[string], DiscoveredAssetRow>,

  getActiveDiscoveredAssets: db.prepare(
    `SELECT * FROM discovered_assets WHERE status = 'active' AND network = ?`
  ) as Statement<[string], DiscoveredAssetRow>,

  updateAssetStatus: db.prepare(
    `UPDATE discovered_assets SET status = ? WHERE address = ? AND network = ?`
  ),

  updateAssetStrategyConfig: db.prepare(`
    UPDATE discovered_assets
    SET strategy_type = @strategyType, drop_pct = @dropPct, rise_pct = @risePct,
        sma_short = @smaShort, sma_long = @smaLong
    WHERE address = @address AND network = @network
  `),

  getDiscoveredAsset: db.prepare(
    `SELECT * FROM discovered_assets WHERE address = ? AND network = ?`
  ) as Statement<[string, string], DiscoveredAssetRow>,

  // Used by GET /api/assets for change24h computation per asset
  assetPrice24hAgo: db.prepare(`
    SELECT price_usd FROM asset_snapshots
    WHERE symbol = ? AND timestamp <= datetime('now', '-24 hours')
    ORDER BY timestamp DESC LIMIT 1
  `) as Statement<[string], { price_usd: number }>,
};
```

The `DiscoveredAssetRow` type mirrors the `discovered_assets` table columns (all snake_case). All call sites use the prepared-statement method pattern: `.get(...)`, `.all(...)`, `.run(...)`.

The `assetPrice24hAgo` prepared statement (for `change24h`) is defined here and reused per-request in `GET /api/assets` — no inline `db.prepare()` in `server.ts`.

**Note — existing query:** `recentAssetSnapshots` (`.all(symbol, limit)`) was added to `queries` in `db.ts` in the multi-asset support phase. It is already present and does not need to be created. The `portfolioUsd` fix uses it as `queries.recentAssetSnapshots.all(symbol, 1)[0]?.price_usd`.

---

## API Endpoints

### Updated endpoints

| Method | Path | Change |
|--------|------|--------|
| `GET` | `/api/assets` | Returns static + discovered (`status ≠ 'dismissed'`) assets; adds `status`, `name`, `change24h`, `source`, `strategyConfig` fields |
| `GET` | `/api/status` | `portfolioUsd` computed server-side by summing `Object.values(botState.assetBalances)` × latest price from `recentAssetSnapshots`; adds `pendingTokenCount` from `botState.pendingTokenCount` |

**`portfolioUsd` server-side fix:** Replace `price * eth + usdc` with: for each entry in `botState.assetBalances`, fetch the most recent `asset_snapshots` row for that symbol and multiply balance × `price_usd`. Sum all results.

### New endpoints

All asset management endpoints derive `network` from `botState.activeNetwork` — no query param needed.

| Method | Path | Body | Response |
|--------|------|------|----------|
| `POST` | `/api/assets/:address/enable` | `{ strategyType, dropPct, risePct, smaShort, smaLong }` | `{ ok: true }` or `{ error, field }` |
| `POST` | `/api/assets/:address/dismiss` | — | `{ ok: true }` |
| `PUT` | `/api/assets/:address/config` | `{ strategyType, dropPct, risePct, smaShort, smaLong }` | `{ ok: true }` or `{ error, field }` |

**`POST /api/assets/:address/enable` flow:**
1. Validate params (same rules as Settings modal)
2. `const row = discoveredAssetQueries.getDiscoveredAsset.get(address, network)` — resolves `symbol` and confirms asset exists; return 404 if not found
3. `discoveredAssetQueries.updateAssetStrategyConfig.run({ address, network, strategyType: params.strategyType, dropPct: params.dropPct, risePct: params.risePct, smaShort: params.smaShort, smaLong: params.smaLong })`
4. `discoveredAssetQueries.updateAssetStatus.run('active', address, network)`
5. `engine.startAssetLoop(address, row.symbol, params)`
6. `botState.setPendingTokenCount(discoveredAssetQueries.getPendingAssets.all(network).length)`
7. Return `{ ok: true }`

**`POST /api/assets/:address/dismiss` flow:**
1. `const row = discoveredAssetQueries.getDiscoveredAsset.get(address, network)` — resolves `symbol`; return 404 if not found
2. `discoveredAssetQueries.updateAssetStatus.run('dismissed', address, network)`
3. `engine.stopAssetLoop(row.symbol)` — no-ops if not running
4. `botState.setPendingTokenCount(discoveredAssetQueries.getPendingAssets.all(network).length)`
5. Return `{ ok: true }`

**`PUT /api/assets/:address/config` flow:**
1. `const row = discoveredAssetQueries.getDiscoveredAsset.get(address, network)` — resolves `symbol`; return 404 if not found
2. Validate params
3. `discoveredAssetQueries.updateAssetStrategyConfig.run({ address, network, strategyType: params.strategyType, dropPct: params.dropPct, risePct: params.risePct, smaShort: params.smaShort, smaLong: params.smaLong })`
4. `engine.reloadAssetConfig(address, row.symbol, params)` — stops existing loop, starts new one unconditionally
5. Return `{ ok: true }`

### `/api/assets` response shape per asset

```json
{
  "symbol": "AERO",
  "name": "Aerodrome Finance",
  "address": "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
  "decimals": 18,
  "balance": 280.0,
  "price": 0.84,
  "change24h": 5.4,
  "isNative": false,
  "tradeMethod": "agentkit",
  "priceSource": "defillama",
  "status": "pending",
  "source": "discovered",
  "strategyConfig": {
    "type": "threshold",
    "dropPct": 3.0,
    "risePct": 4.0,
    "smaShort": 5,
    "smaLong": 20
  }
}
```

Static registry assets return `"source": "registry"` and `"status": "active"` always. Static assets use RuntimeConfig values for `strategyConfig`. The `name` field for static registry assets uses `a.name ?? a.symbol` — if the registry `AssetDefinition` type does not include a `name` field, fall back to `symbol`. `src/assets/registry.ts` remains unchanged.

**`change24h` computation:** use `discoveredAssetQueries.assetPrice24hAgo.get(symbol)?.price_usd` (see Data Model for the prepared statement). If no row exists (asset less than 24h old), the statement returns `undefined` — return `null` in the response. Dashboard renders `—` when `change24h` is `null`.

**`portfolioUsd` computation:** for each entry in `botState.assetBalances`, use `queries.recentAssetSnapshots.all(symbol, 1)[0]?.price_usd`. No new query is required.

---

## BotState Changes (`src/core/state.ts`)

**Already implemented (multi-asset phase):** `_assetBalances: Map<string, number>`, `updateAssetBalance(symbol, balance)`, `get assetBalances()`, and `setNetwork()` (which clears `_assetBalances`). These are not changed.

**New additions:**
```typescript
private _pendingTokenCount = 0;
get pendingTokenCount(): number { return this._pendingTokenCount; }
setPendingTokenCount(n: number): void { this._pendingTokenCount = n; }
```

**`setNetwork()` update:** the existing `setNetwork()` method in `state.ts` already clears `_assetBalances`. It must also reset `pendingTokenCount`:
```typescript
setNetwork(network: string): void {
  this._activeNetwork = network;
  this._assetBalances.clear();
  this._pendingTokenCount = 0; // ← add this line
  // ... existing onNetworkChange callbacks
}
```

`setPendingTokenCount` is called by:
- Portfolio tracker: after each Alchemy discovery scan (`queries.getPendingAssets(network).length`); network read from `botState.activeNetwork`
- `/api/assets/:address/enable` and `/api/assets/:address/dismiss` handlers: recalculates from DB after status change

**Tracker network resolution:** the tracker already reads `botState.activeNetwork` for all network-dependent logic (existing pattern from `tracker.ts`). `getPendingAssets` calls inside the tracker use the same `botState.activeNetwork` reference.

---

## Dashboard Changes (`src/web/public/index.html`)

### Header

Add `ASSETS` button alongside existing `SETTINGS` button. When `s.pendingTokenCount > 0` (from `/api/status`), render a red badge with the count over the button. Clicking opens the Asset Management modal.

### Status section — replace hardcoded grid with dynamic table

**Remove:** hardcoded ETH Price / ETH Balance / USDC Balance / Portfolio cards and the `loadStatus()` code that reads `s.lastPrice`, `s.ethBalance`, `s.usdcBalance` directly.

**Add:** 3-card summary row followed by a dynamic asset table.

Summary cards: Portfolio (`s.portfolioUsd` from `/api/status`, now correctly summed server-side) + 24h change; Bot status + active strategy count; Last trade.

Asset table columns: `ASSET | PRICE | BALANCE | VALUE | 24H | STRATEGY | (actions)`

- Rows rendered from `assetList` (populated by `loadAssets()` via `/api/assets`)
- `status = 'active'` rows: strategy column shows `● threshold` or `● sma` in green; no action buttons
- `status = 'pending'` rows: amber highlight, strategy column shows `⚠ new token`, action column shows inline `ENABLE` + `DISMISS` buttons
- `status = 'dismissed'` rows: excluded from `/api/assets` response — not rendered
- `change24h = null`: rendered as `—`

### Price chart

Unchanged in behaviour — asset selector pills already work for any symbol. Discovered assets automatically gain a pill once they appear in `assetList`.

### Asset Management modal

Triggered by the `ASSETS` header button. Full-screen overlay with a scrollable list of all assets (status ≠ `'dismissed'`).

**List item states:**

| State | Appearance | Controls |
|-------|-----------|----------|
| Active (expanded) | Amber border, ▲ chevron | Strategy type pills, param inputs, SAVE → `PUT /api/assets/:address/config`, "Disable strategy" → `POST /api/assets/:address/dismiss` |
| Active (collapsed) | Normal border, ▼ chevron | Click to expand |
| Pending | Amber dashed border | ENABLE expands inline form → `POST /api/assets/:address/enable`; DISMISS → `POST /api/assets/:address/dismiss` |
| Dismissed | Not shown | — |

**Strategy config fields (when expanded):**
- Strategy type: `THRESHOLD` / `SMA` pill selector
- THRESHOLD: Buy on drop % (min 0.1) + Sell on rise % (min 0.1) number inputs
- SMA: Short window (min 2) + Long window (min 3, must be > short) integer inputs
- SAVE → `PUT /api/assets/:address/config` → closes form on success; shows inline error on failure

**Note on active-asset appearance:** the inline asset table (status section) and the Asset Management modal use different presentations for active assets. In the inline table, active-asset rows show read-only strategy info (e.g. `● threshold`) with no edit controls. In the modal, active-asset rows are expandable with full config editing (SAVE, Disable strategy). These are distinct UI contexts — the inline table is for monitoring; the modal is for configuration.

### Trade modal

The existing Trade modal already dynamically populates pair buttons from `assetList`. Discovered assets with `tradeMethod = 'agentkit'` automatically appear as pair options.

### Theme

All new elements use existing CSS variables (`--bg`, `--surface`, `--border`, `--text`, `--accent`, `--green`, `--red`). Dark and light mode work automatically via the existing ☾/☀ toggle.

---

## Config Changes

### `src/config.ts`

Add `ALCHEMY_API_KEY: z.string().optional()`. When absent, `AlchemyService` is not instantiated and token discovery is disabled — the bot operates normally with the static registry only. No startup failure.

### `stack.env` / `CLAUDE.md`

Both updated to document `ALCHEMY_API_KEY` as an optional key that enables wallet-wide token discovery.

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| `ALCHEMY_API_KEY` absent | Discovery disabled; static registry assets tracked normally; no error |
| Alchemy unavailable at poll time | Log warning, skip discovery step, known assets still price normally |
| Alchemy returns token with no metadata | Skip insertion, log debug |
| DefiLlama returns no price for discovered token | Store `price_usd = 0`, show `—` in table; no strategy signals fired (price of 0 produces no meaningful signal) |
| `POST /api/assets/:address/enable` with invalid params | 400 `{ error, field }` |
| Engine fails to start loop for asset | Log error, asset stays `pending` in DB, `setPendingTokenCount` not decremented |
| `change24h` no snapshot older than 24h | Return `null`; dashboard renders `—` |
| Network switch | `botState.setNetwork()` clears `assetBalances` and resets `pendingTokenCount` to 0; tracker reprimes on next poll |

---

## Wiring in `src/index.ts`

```typescript
// After runtimeConfig init:
const alchemyService = config.ALCHEMY_API_KEY
  ? new AlchemyService(config.ALCHEMY_API_KEY)
  : undefined;

// TradingEngine is instantiated as a class (already the case in index.ts).
// engine is the TradingEngine instance — already available as a local variable.
const engine = new TradingEngine(executor, runtimeConfig);

// Pass to tracker — pollNow return value preserved for onNetworkChange:
const pollNow = await startPortfolioTracker(tools, runtimeConfig, alchemyService);

botState.onNetworkChange(network => {
  // ... existing network change logic ...
  pollNow(); // unchanged — still works because return type is preserved
});

// Pass engine reference to server (so enable/dismiss can call engine methods):
// Full updated signature: startWebServer(tools, runtimeConfig, executor, engine)
startWebServer(tools, runtimeConfig, executor, engine);
```

**`startWebServer` updated signature:**
```typescript
export function startWebServer(
  tools: CoinbaseTools,
  runtimeConfig: RuntimeConfig,
  executor: TradeExecutor,
  engine: TradingEngine,
): void
```

`tools` and `executor` are retained for the existing quote, trade, enso, faucet, and wallet endpoints. `engine` is the new fourth parameter added for asset management endpoints.

`TradingEngine` gains three new public methods: `startAssetLoop`, `stopAssetLoop`, `reloadAssetConfig` (see Trading Engine section). The existing `engine` local variable in `index.ts` is already the `TradingEngine` instance — no change to how it is constructed, only to what is passed downstream.

---

## Files to Create / Modify

### New Files
- `src/services/alchemy.ts` — Alchemy HTTP client (`AlchemyService` class)
- `tests/alchemy.test.ts` — unit tests using **Vitest** (`vi.stubGlobal('fetch', vi.fn())`). Minimum test cases:
  1. `getTokenBalances` — happy path: mock `fetch` returning `{ result: { tokenBalances: [...] } }`; assert returned array shape
  2. `getTokenMetadata` — happy path: mock `fetch` returning `{ result: { symbol, name, decimals } }`; assert return shape
  3. `getTokenBalances` — `fetch` rejects (network error): assert the rejected promise propagates

### Modified Files
- `src/config.ts` — add optional `ALCHEMY_API_KEY`
- `src/data/db.ts` — add `discovered_assets` table and 6 new queries
- `src/core/state.ts` — add `pendingTokenCount` field + `setPendingTokenCount()`
- `src/portfolio/tracker.ts` — accept optional `alchemyService`; call Alchemy each cycle; insert discovered assets; price all active+pending tokens; call `setPendingTokenCount`
- `src/trading/engine.ts` — strategy map; `tickAsset()`; `startAssetLoop()` / `stopAssetLoop()` / `reloadAssetConfig()`; load active discovered assets on startup via `queries`
- `src/trading/executor.ts` — add `executeForAsset(symbol, signal, reason)`
- `src/web/server.ts` — accept `engine` ref; new asset management endpoints; server-side `portfolioUsd` fix; `change24h` computation; `pendingTokenCount` in `/api/status`
- `src/web/public/index.html` — dynamic table; ASSETS badge; Asset Management modal; inline Enable/Dismiss; summary cards from `/api/status`
- `src/index.ts` — instantiate `AlchemyService`; pass to tracker; pass `engine` to server
- `stack.env` — document `ALCHEMY_API_KEY`
- `CLAUDE.md` — update architecture + .env keys

### Unchanged Files
- `src/assets/registry.ts` — static registry untouched
- `src/mcp/tools.ts` — no change
- `src/core/runtime-config.ts` — no change
- `src/core/logger.ts` — no change
- `src/strategy/base.ts`, `threshold.ts`, `sma.ts` — no change (row-shape adaptation happens in engine)

---

## Out of Scope (This Phase)

- Per-asset price alerts / notifications
- Portfolio rebalancing (target % allocations)
- Non-USDC quote assets (e.g. ETH as the quote)
- Token transfer UI
- Enso routing for discovered tokens (all use AgentKit swap)
- Historical performance % beyond 24h
