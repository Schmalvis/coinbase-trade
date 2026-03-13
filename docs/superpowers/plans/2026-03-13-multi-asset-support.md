# Multi-Asset Support Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the trading bot to track and display balances and price history for assets beyond ETH + USDC. Phase 1 covers CBBTC and CBETH on base-mainnet (plus ETH and USDC on both networks). Strategy engine continues to trade ETH↔USDC only; multi-asset is tracking and display first.

**Architecture:** A new `src/assets/registry.ts` module defines tracked assets statically. `db.ts` gains two new normalised tables (`asset_snapshots`, `portfolio_snapshots`). The portfolio tracker iterates the registry each poll cycle, writing per-asset rows. `botState` gains an `assetBalances` map. The web server exposes three new endpoints. The dashboard chart gains an asset selector and the status grid gains a Holdings section.

**Tech Stack:** TypeScript ESM, better-sqlite3 (sync), Express, Chart.js (existing), vitest (existing)

---

## Setup for agentic workers

**Repository:** `https://github.com/Schmalvis/coinbase-trade`
**Base branch:** `main`
**Working directory:** repo root (all paths in this plan are relative to it)

**Create a feature branch before starting:**
```bash
git checkout -b feat/multi-asset-support
```

**Run checks:**
```bash
npm install          # install deps (node_modules not committed)
npx tsc --noEmit     # must pass before and after your changes
npm test             # vitest — 32 tests must pass before you start; keep them passing
```

**Key project facts (read CLAUDE.md for full context):**
- TypeScript ESM — all imports need `.js` extensions even for `.ts` source files
- `better-sqlite3` is synchronous — no `await` on DB calls
- DB migration pattern: `try { db.exec("ALTER TABLE...") } catch {}` — never drop tables
- MCP tool calls are network I/O — mock them in tests, never call live in unit tests
- The dashboard is a single HTML file (`src/web/public/index.html`, ~1400 lines) — edit carefully; the existing modal and chart patterns are the reference
- `botState` is a singleton imported from `src/core/state.ts` — do not instantiate it
- All existing tests must continue to pass after every task

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `src/assets/registry.ts` | **Create** | Static asset registry — symbols, addresses, price sources, tradeability |
| `src/data/db.ts` | **Modify** | Add `asset_snapshots` + `portfolio_snapshots` tables and queries |
| `src/core/state.ts` | **Modify** | Add `assetBalances: Map<string, number>` and `updateAssetBalance()` |
| `src/mcp/tools.ts` | **Modify** | Make `tokenAddress` public as `getTokenAddress`; widen `TokenSymbol` type |
| `src/portfolio/tracker.ts` | **Modify** | Iterate registry per poll cycle; write to new tables; update state |
| `src/web/server.ts` | **Modify** | Add `/api/assets`, `/api/portfolio`; extend `/api/prices` with asset filter; extend `/api/status` |
| `src/web/public/index.html` | **Modify** | Asset selector for price chart; Holdings section in status grid; wider trade pair support |
| `tests/asset-registry.test.ts` | **Create** | Unit tests for registry shape and address lookup |
| `tests/asset-snapshots.test.ts` | **Create** | Unit tests for new DB queries |

---

## Chunk 1: Foundation — Registry and DB

### Task 1: Asset registry

**Goal:** Define the canonical list of tracked assets as a static, typed module. Everything downstream reads from this — the tracker, the API, the dashboard.

**Files:**
- Create: `src/assets/registry.ts`
- Create: `tests/asset-registry.test.ts`

- [ ] **Step 1.1: Create `src/assets/registry.ts`**

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
  pythSymbol?: string;     // e.g. 'BTC' for CBBTC — Pyth ticker, not contract symbol
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
    priceSource: 'defillama',  // DefiLlama gives accurate cbETH/USD; Pyth only has ETH/USD
    tradeMethod: 'agentkit',
  },
];

/** Return assets available on the given network */
export function assetsForNetwork(network: string): AssetDefinition[] {
  return ASSET_REGISTRY.filter(a => a.addresses[network as keyof typeof a.addresses] !== undefined);
}

/** Look up a single asset by symbol (throws if not found) */
export function getAsset(symbol: string): AssetDefinition {
  const a = ASSET_REGISTRY.find(a => a.symbol === symbol);
  if (!a) throw new Error(`Asset not found in registry: ${symbol}`);
  return a;
}
```

- [ ] **Step 1.2: Write unit tests — `tests/asset-registry.test.ts`**

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

- [ ] **Step 1.3: Run tests**

```bash
cd /home/pi/share/coinbase-trade && npm test -- tests/asset-registry.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 1.4: Commit**

```bash
git add src/assets/registry.ts tests/asset-registry.test.ts
git commit -m "feat: add static asset registry (ETH, USDC, CBBTC, CBETH)"
```

---

### Task 2: DB schema — asset_snapshots and portfolio_snapshots

**Goal:** Add two normalised tables. Keep `price_snapshots` intact — the tracker will continue writing ETH rows there for backward compat.

**Files:**
- Modify: `src/data/db.ts`
- Create: `tests/asset-snapshots.test.ts`

- [ ] **Step 2.1: Write failing tests first — `tests/asset-snapshots.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

function makeTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE asset_snapshots (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT    NOT NULL DEFAULT (datetime('now')),
      symbol    TEXT    NOT NULL,
      price_usd REAL    NOT NULL,
      balance   REAL    NOT NULL
    );
    CREATE TABLE portfolio_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     TEXT    NOT NULL DEFAULT (datetime('now')),
      portfolio_usd REAL    NOT NULL
    );
  `);
  return {
    insertAssetSnapshot:     db.prepare(`INSERT INTO asset_snapshots (symbol, price_usd, balance) VALUES (@symbol, @price_usd, @balance)`),
    recentAssetSnapshots:    db.prepare(`SELECT * FROM asset_snapshots WHERE symbol = ? ORDER BY id DESC LIMIT ?`),
    insertPortfolioSnapshot: db.prepare(`INSERT INTO portfolio_snapshots (portfolio_usd) VALUES (@portfolio_usd)`),
    recentPortfolioSnapshots: db.prepare(`SELECT * FROM portfolio_snapshots ORDER BY id DESC LIMIT ?`),
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

Run to confirm the tests pass in isolation (they use `:memory:` DB):

```bash
cd /home/pi/share/coinbase-trade && npm test -- tests/asset-snapshots.test.ts
```

- [ ] **Step 2.2: Add tables to `src/data/db.ts`**

After the existing `db.exec(...)` block, add:

```typescript
db.exec(`
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
`);
```

- [ ] **Step 2.3: Add queries to `queries` export**

```typescript
  insertAssetSnapshot: db.prepare(`
    INSERT INTO asset_snapshots (symbol, price_usd, balance)
    VALUES (@symbol, @price_usd, @balance)
  `),

  recentAssetSnapshots: db.prepare(`
    SELECT * FROM asset_snapshots WHERE symbol = ? ORDER BY id DESC LIMIT ?
  `),

  insertPortfolioSnapshot: db.prepare(`
    INSERT INTO portfolio_snapshots (portfolio_usd) VALUES (@portfolio_usd)
  `),

  recentPortfolioSnapshots: db.prepare(`
    SELECT * FROM portfolio_snapshots ORDER BY id DESC LIMIT ?
  `),
```

- [ ] **Step 2.4: Run full test suite**

```bash
cd /home/pi/share/coinbase-trade && npm test
```

Expected: all existing tests + new asset-snapshots tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add src/data/db.ts tests/asset-snapshots.test.ts
git commit -m "feat: add asset_snapshots and portfolio_snapshots DB tables and queries"
```

---

## Chunk 2: State and Tools

### Task 3: BotState — per-asset balance map

**Goal:** Add `assetBalances` to `botState` so the web server can read per-asset balances. Keep existing `lastBalance` / `lastUsdcBalance` working via delegation.

**Files:**
- Modify: `src/core/state.ts`

- [ ] **Step 3.1: Add `_assetBalances` private field**

```typescript
private _assetBalances: Map<string, number> = new Map();
```

- [ ] **Step 3.2: Add getter**

```typescript
get assetBalances(): ReadonlyMap<string, number> { return this._assetBalances; }
```

- [ ] **Step 3.3: Add `updateAssetBalance` and delegate existing methods**

```typescript
updateAssetBalance(symbol: string, balance: number) {
  this._assetBalances.set(symbol, balance);
  if (symbol === 'ETH')  this._lastBalance     = balance;
  if (symbol === 'USDC') this._lastUsdcBalance  = balance;
}

updateBalance(balance: number)     { this.updateAssetBalance('ETH', balance); }
updateUsdcBalance(balance: number) { this.updateAssetBalance('USDC', balance); }
```

- [ ] **Step 3.4: Clear map on network switch**

In `setNetwork()`, add `this._assetBalances.clear();` alongside the existing null assignments.

- [ ] **Step 3.5: Verify build**

```bash
cd /home/pi/share/coinbase-trade && npx tsc --noEmit
```

- [ ] **Step 3.6: Commit**

```bash
git add src/core/state.ts
git commit -m "feat: add assetBalances map to BotState"
```

---

### Task 4: Tools — widen TokenSymbol and expose getTokenAddress

**Goal:** Widen `TokenSymbol` from a union of two literals to `string`. Make the `tokenAddress` private method public as `getTokenAddress` so the tracker can resolve addresses by symbol for any asset.

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
cd /home/pi/share/coinbase-trade && npx tsc --noEmit && npm test
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

**Goal:** For each asset on the active network, fetch balance + price, write to `asset_snapshots`, compute portfolio total, write to `portfolio_snapshots`, and update `botState`. Keep legacy `insertSnapshot` call for ETH so existing chart data is uninterrupted.

**Files:**
- Modify: `src/portfolio/tracker.ts`

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

Replace the existing body with:

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

- [ ] **Step 5.5: Verify build**

```bash
cd /home/pi/share/coinbase-trade && npx tsc --noEmit
```

- [ ] **Step 5.6: Smoke test (live)**

Start `npm run dev` against base-sepolia. After one poll cycle (~30s):

```bash
sqlite3 /home/pi/.coinbase-trade/trades.db \
  "SELECT symbol, price_usd, balance, timestamp FROM asset_snapshots ORDER BY id DESC LIMIT 6;"

sqlite3 /home/pi/.coinbase-trade/trades.db \
  "SELECT portfolio_usd, timestamp FROM portfolio_snapshots ORDER BY id DESC LIMIT 3;"
```

Expected: rows for ETH and USDC in `asset_snapshots`, rows in `portfolio_snapshots`.

- [ ] **Step 5.7: Commit**

```bash
git add src/portfolio/tracker.ts
git commit -m "feat: portfolio tracker iterates asset registry, writes asset_snapshots + portfolio_snapshots"
```

---

## Chunk 4: API Endpoints

### Task 6: New and updated API endpoints

**Goal:** Expose per-asset data to the dashboard via three new/updated endpoints.

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

Replace the existing handler with:

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

Add to the existing response object:

```typescript
assetBalances: Object.fromEntries(botState.assetBalances),
```

- [ ] **Step 6.6: Manual endpoint check**

```bash
curl http://localhost:3003/api/assets | jq .
curl "http://localhost:3003/api/prices?asset=ETH&limit=3" | jq .
curl "http://localhost:3003/api/portfolio?limit=3" | jq .
curl http://localhost:3003/api/status | jq .assetBalances
```

- [ ] **Step 6.7: Commit**

```bash
git add src/web/server.ts
git commit -m "feat: add /api/assets, /api/portfolio; extend /api/prices with asset filter; extend /api/status"
```

---

## Chunk 5: Dashboard Updates

### Task 7: Dashboard — asset-aware price chart

**Goal:** Replace the hardcoded ETH-only chart with an asset-selector-driven chart that can display any tracked asset's price history, plus a portfolio USD chart.

**Files:**
- Modify: `src/web/public/index.html`

- [ ] **Step 7.1: Add asset selector to chart title HTML**

Find the chart title element and replace it with:

```html
<div class="chart-title" style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap">
  <span>Price — 24h</span>
  <span id="assetSelector" style="display:flex;gap:0.25rem;flex-wrap:wrap"></span>
</div>
```

- [ ] **Step 7.2: Add module-level state variables**

```javascript
let activeChartAsset = 'ETH';
let assetList = [];
```

- [ ] **Step 7.3: Add selector render and switch functions**

```javascript
function renderAssetSelector() {
  const el = document.getElementById('assetSelector');
  if (!el) return;
  el.innerHTML = assetList.map(a =>
    `<button class="pill ${a.symbol === activeChartAsset ? 'active' : ''}"
      onclick="switchChartAsset('${a.symbol}')"
      style="font-size:0.65rem;padding:0.1rem 0.5rem">${a.symbol}</button>`
  ).join('');
}

async function switchChartAsset(symbol) {
  activeChartAsset = symbol;
  renderAssetSelector();
  await loadPriceChart();
}
```

- [ ] **Step 7.4: Split `loadCharts` into `loadPriceChart` + `loadPortfolioChart`**

```javascript
async function loadPriceChart() {
  const data   = await fetch(`/api/prices?asset=${activeChartAsset}&limit=288`).then(r => r.json());
  const labels = [...data].reverse().map(d => d.timestamp);
  const prices = [...data].reverse().map(d => d.price_usd);
  if (priceChart) {
    priceChart.data.labels = labels;
    priceChart.data.datasets[0].data = prices;
    priceChart.update('none');
  }
}

async function loadPortfolioChart() {
  const data   = await fetch('/api/portfolio?limit=288').then(r => r.json());
  const labels = [...data].reverse().map(d => d.timestamp);
  const values = [...data].reverse().map(d => d.portfolio_usd);
  if (portfolioChart) {
    portfolioChart.data.labels = labels;
    portfolioChart.data.datasets[0].data = values;
    portfolioChart.update('none');
  }
}

async function loadCharts() {
  await Promise.all([loadPriceChart(), loadPortfolioChart()]);
}
```

- [ ] **Step 7.5: Add `loadAssets` function and call from `refresh`**

```javascript
async function loadAssets() {
  try {
    assetList = await fetch('/api/assets').then(r => r.json());
    renderAssetSelector();
    renderHoldings();
  } catch (e) {
    console.warn('loadAssets failed', e);
  }
}
```

Add `loadAssets()` to the `refresh()` call. It can run in parallel with `loadStatus()` and `loadCharts()`.

- [ ] **Step 7.6: Verify in browser**

Price chart asset selector appears. Clicking USDC/CBBTC loads that asset's price history. Portfolio chart loads from `/api/portfolio`.

- [ ] **Step 7.7: Commit**

```bash
git add src/web/public/index.html
git commit -m "feat: dashboard price chart asset selector; portfolio chart reads portfolio_snapshots"
```

---

### Task 8: Dashboard — Holdings section and wider trade pairs

**Goal:** Show non-ETH/USDC asset balances in a Holdings section. Populate Standard trade tab token buttons dynamically from the registry.

**Files:**
- Modify: `src/web/public/index.html`

- [ ] **Step 8.1: Add Holdings section HTML**

After the main `.grid` closing tag, add:

```html
<div class="section-title" id="holdingsTitle" style="display:none">Holdings</div>
<div class="grid" id="holdingsGrid" style="display:none"></div>
```

- [ ] **Step 8.2: Add `renderHoldings` function**

```javascript
function renderHoldings() {
  const grid  = document.getElementById('holdingsGrid');
  const title = document.getElementById('holdingsTitle');
  if (!grid || !title) return;
  const extras = assetList.filter(a => a.symbol !== 'ETH' && a.symbol !== 'USDC' && a.balance != null);
  if (!extras.length) {
    grid.style.display = 'none';
    title.style.display = 'none';
    return;
  }
  title.style.display = '';
  grid.style.display = '';
  grid.innerHTML = extras.map(a => {
    const usdValue = (a.balance != null && a.price != null) ? (a.balance * a.price).toFixed(2) : null;
    const balFmt = a.balance != null ? Number(a.balance).toFixed(a.decimals <= 8 ? a.decimals : 6) : '—';
    return `
      <div class="card">
        <div class="label">${a.symbol}</div>
        <div class="value">${balFmt}</div>
        <div class="sub">${usdValue ? '$' + usdValue : ''}</div>
      </div>`;
  }).join('');
}
```

- [ ] **Step 8.3: Dynamically populate Standard trade tab token buttons**

Replace the hardcoded `tradeFromETH` / `tradeFromUSDC` pill group with a container:

```html
<div class="pill-group" id="tradePairBtns"></div>
```

Add a `renderTradePairButtons()` function:

```javascript
function renderTradePairButtons() {
  const container = document.getElementById('tradePairBtns');
  if (!container) return;
  const tradeable = assetList.filter(a => a.tradeMethod === 'agentkit');
  container.innerHTML = tradeable.map(a =>
    `<button data-symbol="${a.symbol}"
      class="pill ${tradePair.from === a.symbol ? 'active' : ''}"
      onclick="setTradePairFrom('${a.symbol}')">${a.symbol}</button>`
  ).join('');
}

function setTradePairFrom(symbol) {
  // Default: swap to USDC unless symbol IS USDC, then swap to ETH
  const toSymbol = symbol === 'USDC' ? 'ETH' : 'USDC';
  setTradePair(symbol, toSymbol);
}
```

Update `setTradePair` to iterate `#tradePairBtns` buttons by `data-symbol` instead of hardcoded IDs:

```javascript
function setTradePair(from, to) {
  tradePair = { from, to };
  document.querySelectorAll('#tradePairBtns button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.symbol === from);
  });
  document.getElementById('tradeQuoteBox').style.display = 'none';
  document.getElementById('confirmTradeBtn').disabled = true;
  tradeQuotedFromAmount = null;
  updateTradeLabel();
}
```

Call `renderTradePairButtons()` from `openTrade()` and from `loadAssets()`.

- [ ] **Step 8.4: Verify in browser**

- On base-mainnet: Holdings shows CBBTC/CBETH cards if balances > 0. Standard trade tab shows ETH, USDC, CBBTC, CBETH buttons.
- On base-sepolia: Holdings hidden. Standard trade tab shows ETH, USDC only.

- [ ] **Step 8.5: Commit**

```bash
git add src/web/public/index.html
git commit -m "feat: dashboard Holdings section; trade pair buttons populated from asset registry"
```

---

## Chunk 6: Tests and Cleanup

### Task 9: Integration smoke test and documentation

**Goal:** Full test suite passes, build is clean, CLAUDE.md is updated.

- [ ] **Step 9.1: Full test suite**

```bash
cd /home/pi/share/coinbase-trade && npm test
```

Expected: all 6 test files pass (smoke, db-settings, runtime-config, executor-manual, asset-registry, asset-snapshots).

- [ ] **Step 9.2: Build check**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 9.3: Live integration check**

Start `npm run dev`. After one poll cycle:

```bash
curl http://localhost:3003/api/assets | jq '.[].symbol'
curl "http://localhost:3003/api/prices?asset=ETH&limit=3" | jq length
curl "http://localhost:3003/api/portfolio?limit=3" | jq '.[0].portfolio_usd'
curl http://localhost:3003/api/status | jq '.assetBalances'
```

- [ ] **Step 9.4: Update CLAUDE.md**

Add `assets/registry.ts` to the architecture section. Update project status to note multi-asset tracking is live.

- [ ] **Step 9.5: Commit docs**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for multi-asset support"
```

---

## Implementation Order

```
Task 1 (registry) ──────────────────────────────────┐
Task 2 (DB tables) ─────────────────────────────────┤
                                                      ▼
Task 3 (BotState) ──┐                          Task 5 (Tracker)
Task 4 (Tools) ─────┘                               │
                                                      ▼
                                               Task 6 (API endpoints)
                                                /           \
                                         Task 7         Task 8
                                         (Chart)       (Holdings)
                                                \           /
                                               Task 9 (Tests + docs)
```

Tasks 1+2 can be done in parallel. Tasks 3+4 can be done in parallel. Tasks 7+8 can be done in parallel.

---

## Edge Cases and Gotchas

**CBBTC/CBETH on base-sepolia:** No testnet deployment — `assetsForNetwork('base-sepolia')` filters them out automatically. The tracker loop skips any asset without an address on the active network.

**CBETH pricing:** Pyth only has ETH/USD, not cbETH/USD. The registry uses `defillama` for CBETH so the price reflects the actual cbETH market price, which trades at a slight premium/discount to ETH.

**`price_snapshots` legacy:** The tracker keeps writing ETH rows there. The `portfolio_usd` field in those rows will be `0` — harmless, since the dashboard portfolio chart now reads `portfolio_snapshots` instead.

**DefiLlama key format:** The tracker constructs `base:0x...` keys. The return value is `{ "base:0x...": { usd: number } }` — use `prices[\`base:${addr}\`]?.usd`.

**Map serialisation in `/api/status`:** `JSON.stringify(new Map())` returns `{}`. Must use `Object.fromEntries(botState.assetBalances)`.

**Rate limiting:** 4 assets on mainnet = ~6–8 MCP calls per poll cycle. Default 30s interval should be fine. Increase `POLL_INTERVAL_SECONDS` if MCP rate limits become an issue.
