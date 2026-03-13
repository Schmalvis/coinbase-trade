# Remaining Features Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete all unimplemented documented features: Multi-Asset Support (9 tasks) and a live LOG_LEVEL fix for the logger.

**Architecture:** Two workstreams. Multi-Asset: asset registry → DB tables → state → tools → tracker → API → dashboard. Logger: change module-level constant to per-call runtimeConfig lookup. Dashboard v2 modals (Settings, Trade, Faucet) are **already implemented** — do not touch them.

**Tech Stack:** TypeScript ESM, better-sqlite3 (sync), Express, Vitest, Chart.js, vanilla HTML/JS

---

## Context

**Dashboard v2 backend + UI: COMPLETE**
- `src/core/runtime-config.ts` — RuntimeConfig with DB persistence
- `src/data/db.ts` — `settings` table
- Component subscriptions (Engine, Executor, Tracker)
- `/api/settings`, `/api/quote`, `/api/trade` endpoints
- Settings modal, Trade modal, Faucet modal in `index.html`
- Buy/Sell/Faucet/Trade buttons wired to modals

**Multi-Asset Support: NOT STARTED**
- `src/assets/registry.ts` does not exist
- No `asset_snapshots` or `portfolio_snapshots` DB tables
- No `assetBalances` map in `botState`
- `tokenAddress()` is private in `tools.ts`
- Portfolio tracker polls ETH + USDC only (hardcoded)
- No `/api/assets`, `/api/portfolio` endpoints
- Chart asset selector and Holdings section not in dashboard

**Logger LOG_LEVEL: NOT LIVE**
- `src/core/logger.ts` reads level at module init — LOG_LEVEL changes have no effect until restart

---

## Setup

**Working directory:** repo root.
- Dev: `c:\ws\coinbase-trade`
- Pi (deploy): `/home/pi/share/coinbase-trade`

**Create feature branch:**
```bash
git checkout -b feat/multi-asset-support
```

**Verify clean baseline before starting:**
```bash
npm install
npx tsc --noEmit    # must pass with zero errors
npm test            # 4 test files, ~32 tests must pass
```

**Key conventions:**
- TypeScript ESM — all imports use `.js` extensions even for `.ts` source files
- `better-sqlite3` is synchronous — never `await` DB calls
- DB migration: `CREATE TABLE IF NOT EXISTS` — never drop existing tables
- MCP calls are live network I/O — always mock in tests
- `botState` is a singleton from `src/core/state.ts` — do not instantiate it
- All existing tests must continue to pass after every task

---

## File Map

| File | Action | Task |
|---|---|---|
| `src/assets/registry.ts` | **Create** | Task 1 |
| `src/data/db.ts` | **Modify** | Task 2 |
| `src/core/state.ts` | **Modify** | Task 3 |
| `src/mcp/tools.ts` | **Modify** | Task 4 |
| `src/portfolio/tracker.ts` | **Modify** | Task 5 |
| `src/web/server.ts` | **Modify** | Task 6 |
| `src/web/public/index.html` | **Modify** | Tasks 7–8 (see existing plan) |
| `src/core/logger.ts` | **Modify** | Task 9 |
| `tests/asset-registry.test.ts` | **Create** | Task 1 |
| `tests/asset-snapshots.test.ts` | **Create** | Task 2 |

---

## Chunk 1: Foundation

### Task 1: Asset Registry

**Files:**
- Create: `src/assets/registry.ts`
- Create: `tests/asset-registry.test.ts`

- [ ] **Step 1.1: Write failing tests first — `tests/asset-registry.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { ASSET_REGISTRY, assetsForNetwork, getAsset } from '../src/assets/registry.js';

describe('asset registry', () => {
  it('all assets have a symbol and decimals', () => {
    for (const a of ASSET_REGISTRY) {
      expect(typeof a.symbol).toBe('string');
      expect(a.symbol.length).toBeGreaterThan(0);
      expect(typeof a.decimals).toBe('number');
    }
  });

  it('ETH is in the registry with isNative=true', () => {
    const eth = getAsset('ETH');
    expect(eth.isNative).toBe(true);
  });

  it('assetsForNetwork base-mainnet includes ETH, USDC, CBBTC, CBETH', () => {
    const symbols = assetsForNetwork('base-mainnet').map(a => a.symbol);
    expect(symbols).toContain('ETH');
    expect(symbols).toContain('USDC');
    expect(symbols).toContain('CBBTC');
    expect(symbols).toContain('CBETH');
  });

  it('assetsForNetwork base-sepolia does NOT include CBBTC or CBETH', () => {
    const symbols = assetsForNetwork('base-sepolia').map(a => a.symbol);
    expect(symbols).not.toContain('CBBTC');
    expect(symbols).not.toContain('CBETH');
  });

  it('getAsset throws for unknown symbol', () => {
    expect(() => getAsset('FAKECOIN')).toThrow('Asset not found in registry: FAKECOIN');
  });

  it('all pyth assets have a pythSymbol', () => {
    for (const a of ASSET_REGISTRY.filter(a => a.priceSource === 'pyth')) {
      expect(typeof a.pythSymbol).toBe('string');
    }
  });
});
```

- [ ] **Step 1.2: Run tests — confirm they fail**

```bash
npm test -- tests/asset-registry.test.ts
```
Expected: fails with `Cannot find module '../src/assets/registry.js'`

- [ ] **Step 1.3: Implement `src/assets/registry.ts`**

```typescript
export type PriceSource = 'pyth' | 'defillama';
export type TradeMethod = 'agentkit' | 'enso' | 'none';

export interface AssetDefinition {
  symbol:      string;
  decimals:    number;
  addresses: {
    'base-mainnet'?: string;
    'base-sepolia'?: string;
  };
  priceSource: PriceSource;
  pythSymbol?: string;     // Pyth ticker (e.g. 'BTC' for CBBTC)
  tradeMethod: TradeMethod;
  isNative?:   boolean;    // true for ETH (balance via wallet details, not ERC20)
}

export const ASSET_REGISTRY: AssetDefinition[] = [
  {
    symbol: 'ETH',
    decimals: 18,
    addresses: {
      'base-mainnet': '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      'base-sepolia': '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    },
    priceSource: 'pyth',
    pythSymbol: 'ETH',
    tradeMethod: 'agentkit',
    isNative: true,
  },
  {
    symbol: 'USDC',
    decimals: 6,
    addresses: {
      'base-mainnet': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    },
    priceSource: 'defillama',
    tradeMethod: 'agentkit',
  },
  {
    symbol: 'CBBTC',
    decimals: 8,
    addresses: {
      'base-mainnet': '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    },
    priceSource: 'pyth',
    pythSymbol: 'BTC',
    tradeMethod: 'agentkit',
  },
  {
    symbol: 'CBETH',
    decimals: 18,
    addresses: {
      'base-mainnet': '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
    },
    priceSource: 'defillama',  // Pyth only has ETH/USD, not cbETH/USD
    tradeMethod: 'agentkit',
  },
];

/** Return assets available on the given network */
export function assetsForNetwork(network: string): AssetDefinition[] {
  return ASSET_REGISTRY.filter(
    a => a.addresses[network as keyof typeof a.addresses] !== undefined
  );
}

/** Look up a single asset by symbol (throws if not found) */
export function getAsset(symbol: string): AssetDefinition {
  const a = ASSET_REGISTRY.find(a => a.symbol === symbol);
  if (!a) throw new Error(`Asset not found in registry: ${symbol}`);
  return a;
}
```

- [ ] **Step 1.4: Run tests — confirm they pass**

```bash
npm test -- tests/asset-registry.test.ts
```
Expected: 6 tests pass.

- [ ] **Step 1.5: Commit**

```bash
git add src/assets/registry.ts tests/asset-registry.test.ts
git commit -m "feat: add static asset registry (ETH, USDC, CBBTC, CBETH)"
```

---

### Task 2: DB Schema

**Files:**
- Modify: `src/data/db.ts`
- Create: `tests/asset-snapshots.test.ts`

- [ ] **Step 2.1: Write tests — `tests/asset-snapshots.test.ts`**

These tests create their own in-memory SQLite DB and pass without any app code changes. They are the spec for the queries to add in Step 2.4.

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

function makeTestDb() {
  const db = new Database(':memory:');
  // Create schema matching what will be added to src/data/db.ts
  db.prepare(
    'CREATE TABLE asset_snapshots (' +
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    '  timestamp TEXT NOT NULL DEFAULT (datetime("now")),' +
    '  symbol TEXT NOT NULL,' +
    '  price_usd REAL NOT NULL,' +
    '  balance REAL NOT NULL' +
    ')'
  ).run();
  db.prepare(
    'CREATE TABLE portfolio_snapshots (' +
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    '  timestamp TEXT NOT NULL DEFAULT (datetime("now")),' +
    '  portfolio_usd REAL NOT NULL' +
    ')'
  ).run();
  return {
    insertAssetSnapshot:
      db.prepare('INSERT INTO asset_snapshots (symbol, price_usd, balance) VALUES (@symbol, @price_usd, @balance)'),
    recentAssetSnapshots:
      db.prepare('SELECT * FROM asset_snapshots WHERE symbol = ? ORDER BY id DESC LIMIT ?'),
    insertPortfolioSnapshot:
      db.prepare('INSERT INTO portfolio_snapshots (portfolio_usd) VALUES (@portfolio_usd)'),
    recentPortfolioSnapshots:
      db.prepare('SELECT * FROM portfolio_snapshots ORDER BY id DESC LIMIT ?'),
  };
}

describe('asset_snapshots queries', () => {
  let q: ReturnType<typeof makeTestDb>;
  beforeEach(() => { q = makeTestDb(); });

  it('inserts and retrieves an asset snapshot', () => {
    q.insertAssetSnapshot.run({ symbol: 'ETH', price_usd: 2000, balance: 0.5 });
    const rows = q.recentAssetSnapshots.all('ETH', 1) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('ETH');
    expect(rows[0].price_usd).toBe(2000);
    expect(rows[0].balance).toBe(0.5);
  });

  it('recentAssetSnapshots filters by symbol', () => {
    q.insertAssetSnapshot.run({ symbol: 'ETH',   price_usd: 2000,  balance: 0.5   });
    q.insertAssetSnapshot.run({ symbol: 'CBBTC', price_usd: 60000, balance: 0.001 });
    const rows = q.recentAssetSnapshots.all('CBBTC', 5) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('CBBTC');
  });

  it('inserts and retrieves a portfolio snapshot', () => {
    q.insertPortfolioSnapshot.run({ portfolio_usd: 1234.56 });
    const rows = q.recentPortfolioSnapshots.all(1) as any[];
    expect(rows[0].portfolio_usd).toBe(1234.56);
  });
});
```

- [ ] **Step 2.2: Run tests — confirm they pass** (in-memory DB, self-contained)

```bash
npm test -- tests/asset-snapshots.test.ts
```
Expected: 3 tests pass.

- [ ] **Step 2.3: Add tables to `src/data/db.ts`**

After the existing schema initialization block, add a new schema block with the following SQL (follow the same multi-statement pattern used for the existing tables):

```sql
CREATE TABLE IF NOT EXISTS asset_snapshots (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT    NOT NULL DEFAULT (datetime('now')),
  symbol    TEXT    NOT NULL,
  price_usd REAL    NOT NULL,
  balance   REAL    NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT    NOT NULL DEFAULT (datetime('now')),
  portfolio_usd REAL    NOT NULL
);
```

- [ ] **Step 2.4: Add queries to the `queries` export**

```typescript
insertAssetSnapshot: db.prepare(
  'INSERT INTO asset_snapshots (symbol, price_usd, balance) VALUES (@symbol, @price_usd, @balance)'
),

recentAssetSnapshots: db.prepare(
  'SELECT * FROM asset_snapshots WHERE symbol = ? ORDER BY id DESC LIMIT ?'
),

insertPortfolioSnapshot: db.prepare(
  'INSERT INTO portfolio_snapshots (portfolio_usd) VALUES (@portfolio_usd)'
),

recentPortfolioSnapshots: db.prepare(
  'SELECT * FROM portfolio_snapshots ORDER BY id DESC LIMIT ?'
),
```

- [ ] **Step 2.5: Run full test suite**

```bash
npm test
```
Expected: all previous + new tests pass.

- [ ] **Step 2.6: Commit**

```bash
git add src/data/db.ts tests/asset-snapshots.test.ts
git commit -m "feat: add asset_snapshots and portfolio_snapshots DB tables and queries"
```

---

## Chunk 2: State and Tools

### Task 3: BotState — per-asset balance map

**Files:**
- Modify: `src/core/state.ts`

- [ ] **Step 3.1: Add private field and getter**

Add alongside the other private fields:
```typescript
private _assetBalances: Map<string, number> = new Map();
```

Add getter:
```typescript
get assetBalances(): ReadonlyMap<string, number> { return this._assetBalances; }
```

- [ ] **Step 3.2: Add `updateAssetBalance` and delegate existing methods**

```typescript
updateAssetBalance(symbol: string, balance: number) {
  this._assetBalances.set(symbol, balance);
  if (symbol === 'ETH')  this._lastBalance     = balance;
  if (symbol === 'USDC') this._lastUsdcBalance  = balance;
}

updateBalance(balance: number)     { this.updateAssetBalance('ETH', balance); }
updateUsdcBalance(balance: number) { this.updateAssetBalance('USDC', balance); }
```

- [ ] **Step 3.3: Clear map on network switch**

In `setNetwork()`, add `this._assetBalances.clear();` alongside the existing null assignments.

- [ ] **Step 3.4: Verify build and tests**

```bash
npx tsc --noEmit && npm test
```
Expected: zero type errors, all tests pass.

- [ ] **Step 3.5: Commit**

```bash
git add src/core/state.ts
git commit -m "feat: add assetBalances map to BotState"
```

---

### Task 4: Tools — widen TokenSymbol, expose getTokenAddress

**Files:**
- Modify: `src/mcp/tools.ts`

- [ ] **Step 4.1: Widen `TokenSymbol`**

Change:
```typescript
export type TokenSymbol = keyof typeof TOKEN_ADDRESSES;
```
to:
```typescript
export type TokenSymbol = string;
```

- [ ] **Step 4.2: Rename `tokenAddress` → `getTokenAddress` and make it public**

Change:
```typescript
private tokenAddress(symbol: TokenSymbol): string {
```
to:
```typescript
getTokenAddress(symbol: string): string {
```

Update the three internal call sites: `this.tokenAddress(...)` → `this.getTokenAddress(...)`.

- [ ] **Step 4.3: Verify build and tests**

```bash
npx tsc --noEmit && npm test
```
Expected: no type errors, all tests pass.

- [ ] **Step 4.4: Commit**

```bash
git add src/mcp/tools.ts
git commit -m "refactor: widen TokenSymbol to string, make getTokenAddress public"
```

---

## Chunk 3: Portfolio Tracker Refactor

### Task 5: Tracker — iterate registry per poll cycle

**Files:**
- Modify: `src/portfolio/tracker.ts`

**Goal:** For each asset on the active network, fetch balance + price, write to `asset_snapshots`, compute portfolio total, write to `portfolio_snapshots`, update `botState`. Keep legacy `insertSnapshot` for ETH so existing chart data is uninterrupted.

- [ ] **Step 5.1: Update imports**

Add:
```typescript
import { assetsForNetwork, type AssetDefinition } from '../assets/registry.js';
```

- [ ] **Step 5.2: Replace `ethPriceFeedId` module variable with a feed cache map**

Remove:
```typescript
let ethPriceFeedId: string | null = null;
```

Add:
```typescript
const pythFeedIds = new Map<string, string>(); // pythSymbol → feedId
```

- [ ] **Step 5.3: Add `fetchAssetPrice` helper inside `startPortfolioTracker`**

```typescript
async function fetchAssetPrice(asset: AssetDefinition): Promise<number> {
  if (asset.priceSource === 'pyth' && asset.pythSymbol) {
    let feedId = pythFeedIds.get(asset.pythSymbol);
    if (!feedId) {
      feedId = await tools.fetchPriceFeedId(asset.pythSymbol) as unknown as string;
      pythFeedIds.set(asset.pythSymbol, feedId);
    }
    return tools.fetchPrice(feedId);
  }
  if (asset.priceSource === 'defillama') {
    const network = botState.activeNetwork;
    const addr = asset.addresses[network as keyof typeof asset.addresses];
    if (!addr) return 0;
    const prices = await tools.getTokenPrices([`base:${addr}`]);
    const key = `base:${addr}`;
    return (prices[key] as any)?.usd ?? 0;
  }
  return 0;
}
```

- [ ] **Step 5.4: Rewrite the `poll` function body**

```typescript
const poll = async () => {
  if (polling) return;
  polling = true;
  try {
    const network = botState.activeNetwork;
    const assets  = assetsForNetwork(network);
    const wallet  = await tools.getWalletDetails();
    const balanceStr = (wallet as any).balance ?? (wallet as any).nativeBalance ?? '0';
    const ethBalance = parseFloat(String(balanceStr)) || 0;

    let portfolioUsd = 0;

    for (const asset of assets) {
      try {
        let balance: number;
        let price: number;

        if (asset.isNative) {
          balance = ethBalance;
          price   = await fetchAssetPrice(asset);
        } else {
          const addr = asset.addresses[network as keyof typeof asset.addresses]!;
          [balance, price] = await Promise.all([
            tools.getErc20Balance(addr),
            fetchAssetPrice(asset),
          ]);
        }

        portfolioUsd += balance * price;
        queries.insertAssetSnapshot.run({ symbol: asset.symbol, price_usd: price, balance });
        botState.updateAssetBalance(asset.symbol, balance);

        // Keep legacy price_snapshots alive for ETH (existing /api/prices default)
        if (asset.symbol === 'ETH') {
          queries.insertSnapshot.run({ eth_price: price, eth_balance: balance, portfolio_usd: 0 });
          botState.updatePrice(price);
        }

        logger.debug(`${asset.symbol}: balance=${balance} price=$${price.toFixed(2)}`);
      } catch (err) {
        logger.error(`Failed to poll ${asset.symbol}`, err);
      }
    }

    queries.insertPortfolioSnapshot.run({ portfolio_usd: portfolioUsd });
    logger.info(`Portfolio: $${portfolioUsd.toFixed(2)}`);
  } catch (err) {
    logger.error('Portfolio tracker poll failed', err);
  } finally {
    polling = false;
  }
};
```

- [ ] **Step 5.5: Verify build and tests**

```bash
npx tsc --noEmit && npm test
```
Expected: no type errors, all tests pass.

- [ ] **Step 5.6: Commit**

```bash
git add src/portfolio/tracker.ts
git commit -m "feat: portfolio tracker iterates asset registry, writes asset_snapshots + portfolio_snapshots"
```

---

## Chunk 4: API Endpoints

### Task 6: New and updated API endpoints

**Files:**
- Modify: `src/web/server.ts`

- [ ] **Step 6.1: Add import**

```typescript
import { assetsForNetwork } from '../assets/registry.js';
```

- [ ] **Step 6.2: Add `GET /api/assets`**

```typescript
app.get('/api/assets', (_req, res) => {
  const network = botState.activeNetwork;
  const assets  = assetsForNetwork(network);
  res.json(assets.map(a => ({
    symbol:      a.symbol,
    decimals:    a.decimals,
    address:     a.addresses[network as keyof typeof a.addresses] ?? null,
    priceSource: a.priceSource,
    tradeMethod: a.tradeMethod,
    isNative:    a.isNative ?? false,
    balance:     botState.assetBalances.get(a.symbol) ?? null,
    price:       (queries.recentAssetSnapshots.all(a.symbol, 1) as any[])[0]?.price_usd ?? null,
  })));
});
```

- [ ] **Step 6.3: Update `GET /api/prices` to support `?asset=SYMBOL`**

Replace the existing `/api/prices` handler with:

```typescript
app.get('/api/prices', (req, res) => {
  const limit  = parseInt((req.query.limit as string) ?? '288', 10);
  const symbol = (req.query.asset as string | undefined)?.toUpperCase();
  if (symbol) {
    res.json(queries.recentAssetSnapshots.all(symbol, limit));
    return;
  }
  // Default: legacy ETH price_snapshots (backward compat)
  res.json(queries.recentSnapshots.all(limit));
});
```

- [ ] **Step 6.4: Add `GET /api/portfolio`**

```typescript
app.get('/api/portfolio', (req, res) => {
  const limit = parseInt((req.query.limit as string) ?? '288', 10);
  res.json(queries.recentPortfolioSnapshots.all(limit));
});
```

- [ ] **Step 6.5: Extend `GET /api/status` with `assetBalances`**

In the existing `/api/status` response object, add:
```typescript
assetBalances: Object.fromEntries(botState.assetBalances),
```
Note: `JSON.stringify(new Map())` returns `{}` — `Object.fromEntries` is required here.

- [ ] **Step 6.6: Verify build and tests**

```bash
npx tsc --noEmit && npm test
```

- [ ] **Step 6.7: Commit**

```bash
git add src/web/server.ts
git commit -m "feat: add /api/assets, /api/portfolio; extend /api/prices with asset filter; extend /api/status"
```

---

## Chunk 5: Dashboard Updates

> Full JS code for Tasks 7–8 is in `docs/superpowers/plans/2026-03-13-multi-asset-support.md` Tasks 7–8.
> Follow those steps exactly. Summary of changes below.

### Task 7: Asset-aware price chart selector

**Files:**
- Modify: `src/web/public/index.html`

- [ ] **Step 7.1:** Replace `<div class="chart-title">ETH Price — 24h</div>` with a flex container holding a static `<span>Price — 24h</span>` and a dynamic `<span id="assetSelector">` for pill buttons.

- [ ] **Step 7.2:** Add module-level state: `let activeChartAsset = 'ETH'` and `let assetList = []`.

- [ ] **Step 7.3:** Add `renderAssetSelector()` — renders a pill button per asset from `assetList`; active pill matches `activeChartAsset`.

- [ ] **Step 7.4:** Add `switchChartAsset(symbol)` — sets `activeChartAsset`, re-renders selector, calls `loadPriceChart()`.

- [ ] **Step 7.5:** Split `loadCharts()` into `loadPriceChart()` (fetches `/api/prices?asset=${activeChartAsset}&limit=288`) and `loadPortfolioChart()` (fetches `/api/portfolio?limit=288`). Keep `loadCharts()` calling both.

- [ ] **Step 7.6:** Add `loadAssets()` — fetches `/api/assets`, stores in `assetList`, calls `renderAssetSelector()` and `renderHoldings()`. Add to `refresh()` parallel with `loadStatus()` and `loadCharts()`.

- [ ] **Step 7.7: Verify:** Asset pills appear in chart header. Clicking any pill loads that asset's history. Portfolio chart shows portfolio totals.

- [ ] **Step 7.8: Commit**

```bash
git add src/web/public/index.html
git commit -m "feat: dashboard price chart asset selector; portfolio chart reads portfolio_snapshots"
```

---

### Task 8: Holdings section and dynamic trade pair buttons

**Files:**
- Modify: `src/web/public/index.html`

- [ ] **Step 8.1:** After the main status `.grid`, add `id="holdingsTitle"` and `id="holdingsGrid"` elements (both `display:none` by default).

- [ ] **Step 8.2:** Add `renderHoldings()` — filters `assetList` to exclude ETH and USDC, renders a `.card` per asset with balance and USD value. Hides the section if no extras.

- [ ] **Step 8.3:** In the Trade modal's Standard tab, replace hardcoded ETH/USDC pill buttons with `<div class="pill-group" id="tradePairBtns"></div>`.

- [ ] **Step 8.4:** Add `renderTradePairButtons()` — populates `#tradePairBtns` with one pill per `agentkit`-tradeable asset from `assetList`. Add `setTradePairFrom(symbol)` helper. Update `setTradePair()` to toggle `#tradePairBtns` buttons by `data-symbol` attribute instead of hardcoded IDs.

- [ ] **Step 8.5:** Call `renderTradePairButtons()` from both `openTrade()` and `loadAssets()`.

- [ ] **Step 8.6: Verify:** On mainnet with CBBTC/CBETH balances: Holdings cards appear. Trade modal shows 4 asset buttons. On sepolia: Holdings hidden, 2 asset buttons.

- [ ] **Step 8.7: Commit**

```bash
git add src/web/public/index.html
git commit -m "feat: dashboard Holdings section; trade pair buttons populated from asset registry"
```

---

## Chunk 6: Polish

### Task 9: Live LOG_LEVEL in logger

**Files:**
- Modify: `src/core/logger.ts`

The logger reads `LOG_LEVEL` from static `config` at module init. Change to per-call lookup so Settings modal LOG_LEVEL changes take effect immediately.

- [ ] **Step 9.1:** Read `src/core/logger.ts`. Find the module-level level constant — likely derived from `config.LOG_LEVEL` at module scope.

- [ ] **Step 9.2:** Add import for runtimeConfig:

```typescript
import { runtimeConfig } from './runtime-config.js';
```

Add a getter function to replace the static constant:

```typescript
const LEVEL_MAP: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function currentLevel(): number {
  const lvl = runtimeConfig.get('LOG_LEVEL') as string | undefined;
  return LEVEL_MAP[lvl ?? 'info'] ?? 1;
}
```

In each log method, replace the static level comparison with `currentLevel()`.

- [ ] **Step 9.3: Verify build and tests**

```bash
npx tsc --noEmit && npm test
```
Expected: zero type errors, all tests pass.

- [ ] **Step 9.4: Commit**

```bash
git add src/core/logger.ts
git commit -m "fix: logger reads LOG_LEVEL from runtimeConfig on each call"
```

---

### Task 10: Final verification + CLAUDE.md update

- [ ] **Step 10.1: Full test suite**

```bash
npm test
```
Expected: 6 test files pass — smoke, db-settings, runtime-config, executor-manual, asset-registry, asset-snapshots.

- [ ] **Step 10.2: Build check**

```bash
npm run build
```
Expected: zero TypeScript errors.

- [ ] **Step 10.3: Live integration check (Pi)**

After one full poll cycle (~30s):

```bash
curl http://localhost:3003/api/assets | jq '.[].symbol'
curl "http://localhost:3003/api/prices?asset=ETH&limit=3" | jq length
curl "http://localhost:3003/api/portfolio?limit=3" | jq '.[0].portfolio_usd'
curl http://localhost:3003/api/status | jq '.assetBalances'
```

- [ ] **Step 10.4: Update CLAUDE.md**

Add `src/assets/registry.ts` to the architecture section. Update project status: multi-asset tracking live, LOG_LEVEL hot-reload fixed.

- [ ] **Step 10.5: Commit docs**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for multi-asset support"
```

---

## Implementation Order

```
Task 1 (registry) + Task 2 (DB) ──── parallel ───────────────────────────┐
                                                                           ↓
                              Task 3 (state) + Task 4 (tools) ── parallel ┘
                                                                           ↓
                                                                  Task 5 (tracker)
                                                                           ↓
                                                                   Task 6 (API)
                                                                           ↓
                              Task 7 (chart selector) + Task 8 (holdings) ── parallel
                                                                           ↓
                                                                  Task 9 (logger fix)
                                                                           ↓
                                                              Task 10 (verify + docs)
```

---

## Edge Cases and Gotchas

- **CBBTC/CBETH on base-sepolia:** No testnet deployment — `assetsForNetwork('base-sepolia')` filters them out automatically. No special-casing needed in the tracker.
- **CBETH pricing:** Registry uses `defillama` because Pyth only has ETH/USD, not cbETH/USD.
- **DefiLlama key format:** Construct `base:0x...` keys. Response shape: `{ "base:0x...": { usd: number } }`.
- **`price_snapshots` legacy:** Tracker keeps writing ETH rows there with `portfolio_usd: 0` — harmless. Dashboard portfolio chart now reads `portfolio_snapshots`.
- **`Object.fromEntries` in `/api/status`:** `JSON.stringify(new Map())` returns `{}` — always use `Object.fromEntries(botState.assetBalances)`.
- **Rate limiting:** 4 assets on mainnet ≈ 6–8 MCP calls per poll. At 30s intervals this is fine.
- **Dashboard CSS classes:** `.card`, `.label`, `.value`, `.sub` for Holdings cards. `.pill`, `.pill.active` for asset selector buttons.
- **`setTradePair` callers:** Update the function body only; callers remain unchanged.
