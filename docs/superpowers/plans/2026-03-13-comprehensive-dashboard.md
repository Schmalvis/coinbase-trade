# Comprehensive Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the coinbase-trade dashboard to support any ERC20 token held in the wallet via Alchemy scanning, per-asset independent strategy loops, a dynamic asset table, an ASSETS header button with badge, and an Asset Management modal.

**Architecture:** AlchemyService discovers wallet tokens; discovered assets are persisted in SQLite with per-asset strategy params; TradingEngine runs independent strategy loops per discovered asset; the dashboard dynamically renders all assets via a new API and an Asset Management modal.

**Tech Stack:** TypeScript ESM, Express, better-sqlite3, Vitest, Chart.js, Alchemy JSON-RPC API, DefiLlama pricing

> **Important:** `src/strategy/base.ts`, `threshold.ts`, and `sma.ts` are **unchanged**. The row-shape adaptation from `asset_snapshots` to the `Snapshot` interface happens inside `tickAsset` in `engine.ts`.

---

## Chunk 1: Foundation (Tasks 1–4)

### Task 1: Add ALCHEMY_API_KEY to config

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Read the file**

Open `src/config.ts` and locate the Zod schema object.

- [ ] **Step 2: Add the optional field**

Inside the `z.object({...})` schema, add after existing entries:

```typescript
ALCHEMY_API_KEY: z.string().optional(),
```

- [ ] **Step 3: Build**

```bash
npm run build
```
Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts
git commit -m "feat: add optional ALCHEMY_API_KEY config"
```

---

### Task 2: Add discovered_assets table and queries

**Files:**
- Modify: `src/data/db.ts`

Follow the `settingQueries` typed-export pattern — export a named `discoveredAssetQueries` object, do NOT add to `queries: Record<string, Statement>`.

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS discovered_assets (
  address       TEXT    NOT NULL,
  network       TEXT    NOT NULL,
  symbol        TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  decimals      INTEGER NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending',
  strategy_type TEXT    NOT NULL DEFAULT 'threshold',
  quote_asset   TEXT    NOT NULL DEFAULT 'USDC',
  drop_pct      REAL    NOT NULL DEFAULT 3.0,
  rise_pct      REAL    NOT NULL DEFAULT 4.0,
  sma_short     INTEGER NOT NULL DEFAULT 5,
  sma_long      INTEGER NOT NULL DEFAULT 20,
  discovered_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (address, network)
)
```

**Interface and queries:**

```typescript
export interface DiscoveredAssetRow {
  address: string; network: string; symbol: string; name: string; decimals: number;
  status: string; strategy_type: string; quote_asset: string;
  drop_pct: number; rise_pct: number; sma_short: number; sma_long: number;
  discovered_at: string;
}

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

  assetPrice24hAgo: db.prepare(`
    SELECT price_usd FROM asset_snapshots
    WHERE symbol = ? AND timestamp <= datetime('now', '-24 hours')
    ORDER BY timestamp DESC LIMIT 1
  `) as Statement<[string], { price_usd: number }>,
};
```

> Note: `asset_snapshots` (not `asset_price_snapshots`) — the existing table name from the multi-asset phase.

- [ ] **Step 1: Write the failing test**

Create `tests/db-discovered-assets.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

const DDL = `
  CREATE TABLE IF NOT EXISTS discovered_assets (
    address TEXT NOT NULL,
    network TEXT NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    decimals INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    strategy_type TEXT NOT NULL DEFAULT 'threshold',
    quote_asset TEXT NOT NULL DEFAULT 'USDC',
    drop_pct REAL NOT NULL DEFAULT 3.0,
    rise_pct REAL NOT NULL DEFAULT 4.0,
    sma_short INTEGER NOT NULL DEFAULT 5,
    sma_long INTEGER NOT NULL DEFAULT 20,
    discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (address, network)
  )
`;

describe('discovered_assets DDL', () => {
  it('inserts and retrieves a row with defaults', () => {
    const db = new Database(':memory:');
    db.prepare(DDL).run();
    db.prepare(`INSERT OR IGNORE INTO discovered_assets (address, network, symbol, name, decimals) VALUES (?, ?, ?, ?, ?)`).run('0xabc', 'base-mainnet', 'PEPE', 'Pepe Token', 18);
    const row = db.prepare(`SELECT * FROM discovered_assets WHERE address = ?`).get('0xabc') as any;
    expect(row.symbol).toBe('PEPE');
    expect(row.status).toBe('pending');
    expect(row.strategy_type).toBe('threshold');
    expect(row.drop_pct).toBe(3.0);
  });

  it('INSERT OR IGNORE does not overwrite existing row', () => {
    const db = new Database(':memory:');
    db.prepare(DDL).run();
    db.prepare(`INSERT OR IGNORE INTO discovered_assets (address, network, symbol, name, decimals) VALUES (?, ?, ?, ?, ?)`).run('0xabc', 'base-mainnet', 'PEPE', 'Pepe Token', 18);
    db.prepare(`UPDATE discovered_assets SET status = ? WHERE address = ?`).run('active', '0xabc');
    db.prepare(`INSERT OR IGNORE INTO discovered_assets (address, network, symbol, name, decimals) VALUES (?, ?, ?, ?, ?)`).run('0xabc', 'base-mainnet', 'PEPE2', 'Different', 6);
    const row = db.prepare(`SELECT * FROM discovered_assets WHERE address = ?`).get('0xabc') as any;
    expect(row.status).toBe('active');  // not overwritten
    expect(row.symbol).toBe('PEPE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/db-discovered-assets.test.ts
```
Expected: FAIL — test validates SQL is correct in isolation against in-memory DB.

- [ ] **Step 3: Add DDL and queries to db.ts**

In `src/data/db.ts`, after existing table DDL calls, apply the DDL via `db.prepare(DDL_CONST).run()`. Add the `DiscoveredAssetRow` interface and `discoveredAssetQueries` export shown above.

- [ ] **Step 4: Run tests and build**

```bash
npx vitest run tests/db-discovered-assets.test.ts
npm run build
```
Expected: pass, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/data/db.ts tests/db-discovered-assets.test.ts
git commit -m "feat: add discovered_assets table and discoveredAssetQueries"
```

---

### Task 3: Add pendingTokenCount to BotState

**Files:**
- Modify: `src/core/state.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/state-pending-tokens.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('BotState pendingTokenCount', () => {
  it('defaults to 0', async () => {
    const { botState } = await import('../src/core/state.js');
    expect(botState.pendingTokenCount).toBe(0);
  });

  it('setPendingTokenCount updates the value', async () => {
    const { botState } = await import('../src/core/state.js');
    botState.setPendingTokenCount(3);
    expect(botState.pendingTokenCount).toBe(3);
  });

  it('setNetwork resets pendingTokenCount to 0', async () => {
    const { botState } = await import('../src/core/state.js');
    botState.setPendingTokenCount(5);
    botState.setNetwork('base-mainnet');
    expect(botState.pendingTokenCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/state-pending-tokens.test.ts
```
Expected: FAIL — `pendingTokenCount` and `setPendingTokenCount` do not exist.

- [ ] **Step 3: Add to state.ts**

In the `BotState` class:
1. Add private field: `private _pendingTokenCount = 0;`
2. Add getter: `get pendingTokenCount(): number { return this._pendingTokenCount; }`
3. Add method (no emit): `setPendingTokenCount(n: number): void { this._pendingTokenCount = n; }`
4. In `setNetwork()`, add: `this._pendingTokenCount = 0;`

- [ ] **Step 4: Run tests and build**

```bash
npx vitest run tests/state-pending-tokens.test.ts
npm run build
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/state.ts tests/state-pending-tokens.test.ts
git commit -m "feat: add pendingTokenCount to BotState, reset on network change"
```

---

### Task 4: Implement AlchemyService with TDD

**Files:**
- Create: `src/services/alchemy.ts`
- Create: `tests/alchemy.test.ts`

**Important design note:** Network is per-call, not stored at construction time. This allows the service instance to work correctly after `botState.setNetwork()` without needing to be re-instantiated.

```typescript
export interface AlchemyTokenBalance {
  contractAddress: string;
  tokenBalance: string;  // hex-encoded, e.g. "0x1a2b..."
}

export class AlchemyService {
  constructor(private readonly apiKey: string) {}

  private baseUrl(network: string): string {
    const host = network === 'base-mainnet'
      ? 'base-mainnet.g.alchemy.com'
      : 'base-sepolia.g.alchemy.com';
    return `https://${host}/v2/${this.apiKey}`;
  }

  private async post(network: string, body: unknown): Promise<unknown> {
    const res = await fetch(this.baseUrl(network), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Alchemy HTTP ${res.status}`);
    const json = await res.json() as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(`Alchemy RPC error: ${json.error.message}`);
    return json.result;
  }

  async getTokenBalances(walletAddress: string, network: string): Promise<AlchemyTokenBalance[]> {
    const result = await this.post(network, {
      jsonrpc: '2.0', method: 'alchemy_getTokenBalances',
      params: [walletAddress, 'erc20'], id: 1,
    }) as { tokenBalances: AlchemyTokenBalance[] };
    return result.tokenBalances;
  }

  async getTokenMetadata(contractAddress: string, network: string): Promise<{ symbol: string; name: string; decimals: number }> {
    return this.post(network, {
      jsonrpc: '2.0', method: 'alchemy_getTokenMetadata',
      params: [contractAddress], id: 1,
    }) as Promise<{ symbol: string; name: string; decimals: number }>;
  }
}
```

- [ ] **Step 1: Write failing tests**

Create `tests/alchemy.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AlchemyService } from '../src/services/alchemy.js';

describe('AlchemyService', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('getTokenBalances — happy path returns tokenBalances array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: { tokenBalances: [
          { contractAddress: '0xabc', tokenBalance: '0x1a4' },
          { contractAddress: '0xdef', tokenBalance: '0x2710' },
        ]},
      }),
    }));
    const svc = new AlchemyService('testkey');
    const result = await svc.getTokenBalances('0xwallet', 'base-mainnet');
    expect(result).toHaveLength(2);
    expect(result[0].contractAddress).toBe('0xabc');
    expect(result[1].tokenBalance).toBe('0x2710');
  });

  it('getTokenMetadata — happy path returns symbol, name, decimals', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { symbol: 'PEPE', name: 'Pepe Token', decimals: 18 } }),
    }));
    const svc = new AlchemyService('testkey');
    const meta = await svc.getTokenMetadata('0xcontract', 'base-mainnet');
    expect(meta.symbol).toBe('PEPE');
    expect(meta.name).toBe('Pepe Token');
    expect(meta.decimals).toBe(18);
  });

  it('getTokenBalances — network error propagates as rejected promise', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    const svc = new AlchemyService('testkey');
    await expect(svc.getTokenBalances('0xwallet', 'base-mainnet')).rejects.toThrow('Network error');
  });

  it('uses base-sepolia host for testnet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { tokenBalances: [] } }),
    }));
    const svc = new AlchemyService('mykey');
    await svc.getTokenBalances('0xwallet', 'base-sepolia');
    const fetchMock = vi.mocked(fetch);
    expect((fetchMock.mock.calls[0][0] as string)).toContain('base-sepolia.g.alchemy.com');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run tests/alchemy.test.ts
```
Expected: FAIL — `src/services/alchemy.ts` does not exist.

- [ ] **Step 3: Create src/services/alchemy.ts**

Create with the implementation shown above.

- [ ] **Step 4: Run tests and build**

```bash
npx vitest run tests/alchemy.test.ts
npm run build
```
Expected: 4/4 pass, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/alchemy.ts tests/alchemy.test.ts
git commit -m "feat: add AlchemyService for ERC20 token discovery"
```

---

## Chunk 2: Trading Engine (Tasks 5–7)

### Task 5: Add executeForAsset to TradeExecutor

**Files:**
- Modify: `src/trading/executor.ts`

**Spec-required signature:** `executeForAsset(symbol: string, signal: Signal, reason: string): Promise<void>`

The method accepts the full `Signal` union (`'buy' | 'sell' | 'hold'`) and returns early on `'hold'`. Per-symbol cooldown via `_assetCooldowns` map keyed by `symbol`. Does NOT check `botState.lastTradeAt`. Does NOT call `botState.recordTrade()`.

Amount sizing: 10% of available balance from `botState.assetBalances.get(symbol)`.

- [ ] **Step 1: Write the failing test**

Create `tests/executor-asset.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('TradeExecutor.executeForAsset', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns early on hold signal without calling tools.swap', async () => {
    // Instantiate TradeExecutor with mocked tools, runtimeConfig, botState
    // Call executeForAsset('PEPE', 'hold', 'test')
    // Assert tools.swap was NOT called
    //
    // Mocks needed:
    //   runtimeConfig.get('DRY_RUN') => false
    //   runtimeConfig.get('TRADE_COOLDOWN_SECONDS') => 3600
    //   botState.assetBalances.get('PEPE') => 100
    //   tools.swap => vi.fn()
    expect(true).toBe(true); // replace with real assertions
  });

  it('skips trade when cooldown active for same symbol', async () => {
    // Call executeForAsset('PEPE', 'sell', 'test') twice rapidly
    // Assert tools.swap called exactly once
    expect(true).toBe(true);
  });
});
```

> Replace placeholders with real assertions using mocked executor dependencies.

- [ ] **Step 2: Add _assetCooldowns and executeForAsset to executor.ts**

Add private field: `private readonly _assetCooldowns = new Map<string, Date>();`

Add the method:

```typescript
async executeForAsset(symbol: string, signal: Signal, reason: string): Promise<void> {
  if (signal === 'hold') return;

  if (this.runtimeConfig.get('DRY_RUN')) {
    logger.info(`[DRY RUN] ${signal} ${symbol}: ${reason}`);
    return;
  }

  const cooldownSecs = this.runtimeConfig.get('TRADE_COOLDOWN_SECONDS') as number;
  const last = this._assetCooldowns.get(symbol);
  if (last && (Date.now() - last.getTime()) < cooldownSecs * 1000) {
    logger.debug(`Cooldown active for ${symbol}, skipping`);
    return;
  }

  const balance = botState.assetBalances.get(symbol) ?? 0;
  if (balance <= 0) {
    logger.warn(`No ${symbol} balance for ${signal} trade`);
    return;
  }

  // 10% of available balance; no max-size cap for discovered assets
  const amount = balance * 0.1;

  const [fromSymbol, toSymbol] = signal === 'buy'
    ? ['USDC', symbol]
    : [symbol, 'USDC'];

  logger.info(`Executing ${signal} ${symbol} amount=${amount}: ${reason}`);
  await this.tools.swap(fromSymbol as any, toSymbol as any, amount.toString());
  this._assetCooldowns.set(symbol, new Date());
  // NOTE: do NOT call botState.recordTrade() here — global last-trade is for ETH/USDC loop only
  logger.info(`executeForAsset complete: ${signal} ${symbol}`);
}
```

Import `Signal` type from `../strategy/base.js` at the top of executor.ts.

- [ ] **Step 3: Run tests and build**

```bash
npx vitest run tests/executor-asset.test.ts
npm run build
```
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add src/trading/executor.ts tests/executor-asset.test.ts
git commit -m "feat: add executeForAsset with per-symbol cooldown to TradeExecutor"
```

---

### Task 6: Add per-asset strategy loops to TradingEngine

**Files:**
- Modify: `src/trading/engine.ts`

Each active discovered asset gets its own interval in `_assetLoops: Map<string, NodeJS.Timeout>`. Loops loaded in constructor (not `start()`).

**New public methods:**

```typescript
startAssetLoop(address: string, symbol: string, params: AssetStrategyParams): void {
  this.stopAssetLoop(symbol); // clear existing (no-op if absent)
  const ms = (this.runtimeConfig.get('TRADE_INTERVAL_SECONDS') as number) * 1000;
  const id = setInterval(() => void this.tickAsset(symbol, address, params), ms);
  this._assetLoops.set(symbol, id);
  logger.info(`Asset loop started: ${symbol} every ${ms}ms`);
}

stopAssetLoop(symbol: string): void {
  const id = this._assetLoops.get(symbol);
  if (id !== undefined) {
    clearInterval(id);
    this._assetLoops.delete(symbol);
    logger.info(`Asset loop stopped: ${symbol}`);
  }
}

reloadAssetConfig(address: string, symbol: string, params: AssetStrategyParams): void {
  this.stopAssetLoop(symbol);
  this.startAssetLoop(address, symbol, params);
}
```

**Private map and tickAsset:**

```typescript
private readonly _assetLoops = new Map<string, NodeJS.Timeout>();

private async tickAsset(symbol: string, address: string, params: AssetStrategyParams): Promise<void> {
  if (botState.isPaused) return;

  const limit = params.smaLong + 5;
  const raw = queries.recentAssetSnapshots.all(symbol, limit) as {
    price_usd: number; balance: number; timestamp: string;
  }[];
  if (raw.length === 0) return;

  // Adapt to Snapshot shape — eth_price/eth_balance are the field names strategies expect
  const snapshots = raw.map(r => ({
    eth_price:     r.price_usd,
    eth_balance:   r.balance,
    portfolio_usd: 0,
    timestamp:     r.timestamp,
  }));

  const strategy = params.strategyType === 'sma'
    ? new SMAStrategy()
    : new ThresholdStrategy();

  // Override evaluate to use per-asset params — strategies read from runtimeConfig by default
  // so instantiate with no params but supply the evaluated signal using params directly
  // NOTE: see spec — strategy classes are UNCHANGED; ThresholdStrategy and SMAStrategy read
  // from RuntimeConfig. For per-asset params, pass a custom evaluation:
  // Alternative: for the first implementation, wire ThresholdStrategy using the RuntimeConfig
  // values and document as a known limitation. Full per-asset param injection is a follow-up.
  // The spec says strategies are unchanged — tickAsset instantiates them normally and calls evaluate().
  const result = strategy.evaluate(snapshots);

  logger.debug(`[${symbol}] Strategy signal: ${result.signal} — ${result.reason}`);
  await this.executor.executeForAsset(symbol, result.signal, 'auto');
}
```

> **Note to implementer:** The spec states strategy classes are unchanged. `tickAsset` instantiates a standard `ThresholdStrategy` or `SMAStrategy` (which read from RuntimeConfig) and passes `params` as metadata context. For full per-asset parameter isolation, this would require strategy constructors to accept explicit params — but the spec explicitly marks those files as unchanged. Implement as shown (RuntimeConfig-driven) and note as a limitation.

**Constructor on-startup loading:**

After `this.strategy = this.buildStrategy()` in the constructor, add:

```typescript
const activeAssets = discoveredAssetQueries.getActiveDiscoveredAssets.all(botState.activeNetwork) as DiscoveredAssetRow[];
for (const row of activeAssets) {
  this.startAssetLoop(row.address, row.symbol, {
    strategyType: row.strategy_type as 'threshold' | 'sma',
    dropPct: row.drop_pct,
    risePct: row.rise_pct,
    smaShort: row.sma_short,
    smaLong: row.sma_long,
  });
}
```

Import `discoveredAssetQueries`, `DiscoveredAssetRow` from `'../data/db.js'` and `botState` from `'../core/state.js'` at top.

Also add `AssetStrategyParams` interface in this file:

```typescript
interface AssetStrategyParams {
  strategyType: 'threshold' | 'sma';
  dropPct: number;
  risePct: number;
  smaShort: number;
  smaLong: number;
}
```

- [ ] **Step 1: Write the failing test**

Create `tests/engine-asset-loops.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('TradingEngine asset loops', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('stopAssetLoop is a no-op when symbol not in map', () => {
    // Instantiate TradingEngine with mocked executor, runtimeConfig
    // Call stopAssetLoop('UNKNOWN') — should not throw
    expect(true).toBe(true);
  });

  it('startAssetLoop replaces existing loop for same symbol', () => {
    vi.stubGlobal('setInterval', vi.fn().mockReturnValue(42));
    vi.stubGlobal('clearInterval', vi.fn());
    // Call startAssetLoop twice for same symbol
    // Assert clearInterval was called on second start
    expect(true).toBe(true);
  });
});
```

> Write meaningful assertions using mocked timer functions.

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run tests/engine-asset-loops.test.ts
```

- [ ] **Step 3: Implement engine.ts changes**

Add `AssetStrategyParams` interface, `_assetLoops` map, three public methods, `tickAsset`, and constructor loading block.

- [ ] **Step 4: Run tests and build**

```bash
npx vitest run tests/engine-asset-loops.test.ts
npm run build
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/trading/engine.ts tests/engine-asset-loops.test.ts
git commit -m "feat: add per-asset strategy loops to TradingEngine"
```

---

### Task 7: Add Alchemy discovery to portfolio tracker

**Files:**
- Modify: `src/portfolio/tracker.ts`

**Updated signature** (return type `Promise<() => void>` UNCHANGED):

```typescript
export async function startPortfolioTracker(
  tools: CoinbaseTools,
  runtimeConfig: RuntimeConfig,
  alchemyService?: AlchemyService,
): Promise<() => void>
```

**Discovery logic** — add at the end of `poll()`, after existing asset loop:

```typescript
if (alchemyService) {
  try {
    const network = botState.activeNetwork;
    const wallet = await tools.getWalletDetails();
    const walletAddress = (wallet as any).address;
    if (!walletAddress) throw new Error('wallet address unavailable');

    // Step 1: Fetch all ERC20 balances for this wallet
    const tokenBalances = await alchemyService.getTokenBalances(walletAddress, network);

    // Build a lookup map: contractAddress (lowercase) → hex balance
    const hexBalanceMap = new Map<string, string>();
    for (const tb of tokenBalances) {
      hexBalanceMap.set(tb.contractAddress.toLowerCase(), tb.tokenBalance);
    }

    // Step 2: Insert new tokens (status='pending', INSERT OR IGNORE)
    const registryAddresses = new Set(
      assetsForNetwork(network).map(a => {
        const addr = a.addresses[network as keyof typeof a.addresses];
        return addr ? addr.toLowerCase() : null;
      }).filter(Boolean)
    );

    for (const tb of tokenBalances) {
      const addr = tb.contractAddress.toLowerCase();
      if (registryAddresses.has(addr)) continue; // skip static registry assets

      const existing = discoveredAssetQueries.getDiscoveredAsset.get(tb.contractAddress, network);
      if (!existing) {
        try {
          const meta = await alchemyService.getTokenMetadata(tb.contractAddress, network);
          discoveredAssetQueries.insertDiscoveredAsset.run(
            tb.contractAddress, network, meta.symbol, meta.name, meta.decimals
          );
          logger.debug(`Discovered new token: ${meta.symbol} (${tb.contractAddress})`);
        } catch (err) {
          logger.debug(`Skipping token ${tb.contractAddress}: metadata unavailable`);
        }
      }
    }

    // Step 3: Update pendingTokenCount
    botState.setPendingTokenCount(discoveredAssetQueries.getPendingAssets.all(network).length);

    // Step 4: Price all active+pending discovered assets via DefiLlama
    const activePending = [
      ...(discoveredAssetQueries.getPendingAssets.all(network) as DiscoveredAssetRow[]),
      ...(discoveredAssetQueries.getActiveDiscoveredAssets.all(network) as DiscoveredAssetRow[]),
    ];
    for (const row of activePending) {
      try {
        const prices = await tools.getTokenPrices([`base:${row.address}`]);
        const price = (prices[`base:${row.address}`] as any)?.usd ?? 0;
        queries.insertAssetSnapshot.run({ symbol: row.symbol, price_usd: price, balance: 0 });

        // Step 5: Update balance from Alchemy hex balance
        const hexBal = hexBalanceMap.get(row.address.toLowerCase());
        const humanBalance = hexBal
          ? Number(BigInt(hexBal)) / Math.pow(10, row.decimals)
          : 0;
        botState.updateAssetBalance(row.symbol, humanBalance);
      } catch (err) {
        logger.error(`Failed to price/balance discovered asset ${row.symbol}`, err);
      }
    }
  } catch (err) {
    logger.warn('Alchemy discovery step failed, skipping', err);
  }
}
```

Import `AlchemyService` from `'../services/alchemy.js'` and `discoveredAssetQueries`, `DiscoveredAssetRow` from `'../data/db.js'`.

- [ ] **Step 1: Update tracker.ts**

Add third param, imports, discovery block.

- [ ] **Step 2: Build**

```bash
npm run build
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/portfolio/tracker.ts
git commit -m "feat: Alchemy token discovery in portfolio tracker"
```

---

## Chunk 3: API and Dashboard (Tasks 8–11)

### Task 8: Update server.ts for engine and asset management

**Files:**
- Modify: `src/web/server.ts`

**Updated signature:**

```typescript
export function startWebServer(
  tools: CoinbaseTools,
  runtimeConfig: RuntimeConfig,
  executor: TradeExecutor,
  engine: TradingEngine,
): void
```

**Fix `/api/status`:** add `pendingTokenCount` and fix `portfolioUsd`:

```typescript
// Replace: portfolioUsd: price * eth + usdc
// With:
let portfolioUsd = 0;
for (const [sym, bal] of botState.assetBalances) {
  const priceRow = (queries.recentAssetSnapshots.all(sym, 1) as any[])[0];
  portfolioUsd += bal * (priceRow?.price_usd ?? 0);
}

// Add to response:
res.json({
  // ...existing fields...
  portfolioUsd,
  pendingTokenCount: botState.pendingTokenCount,
});
```

**Updated `/api/assets`** — returns static + discovered (`status != 'dismissed'`):

```typescript
app.get('/api/assets', (_req, res) => {
  const network = botState.activeNetwork;

  // Static registry assets
  const registryAssets = assetsForNetwork(network).map(a => {
    const sym = a.symbol;
    const priceRow = (queries.recentAssetSnapshots.all(sym, 1) as any[])[0];
    const price = priceRow?.price_usd ?? null;
    const price24h = discoveredAssetQueries.assetPrice24hAgo.get(sym) as any;
    const change24h = (price && price24h?.price_usd && price24h.price_usd !== 0)
      ? ((price - price24h.price_usd) / price24h.price_usd) * 100
      : null;
    return {
      symbol: sym,
      name: (a as any).name ?? sym,
      address: a.addresses[network as keyof typeof a.addresses] ?? null,
      decimals: a.decimals,
      balance: botState.assetBalances.get(sym) ?? null,
      price,
      change24h,
      isNative: a.isNative ?? false,
      tradeMethod: a.tradeMethod,
      priceSource: a.priceSource,
      status: 'active' as const,
      source: 'registry' as const,
      strategyConfig: {
        type: runtimeConfig.get('STRATEGY') as string,
        dropPct: runtimeConfig.get('PRICE_DROP_THRESHOLD_PCT') as number,
        risePct: runtimeConfig.get('PRICE_RISE_TARGET_PCT') as number,
        smaShort: runtimeConfig.get('SMA_SHORT_WINDOW') as number,
        smaLong: runtimeConfig.get('SMA_LONG_WINDOW') as number,
      },
    };
  });

  // Discovered assets (status != 'dismissed')
  const allDiscovered = [
    ...(discoveredAssetQueries.getPendingAssets.all(network) as DiscoveredAssetRow[]),
    ...(discoveredAssetQueries.getActiveDiscoveredAssets.all(network) as DiscoveredAssetRow[]),
  ].map(d => {
    const priceRow = (queries.recentAssetSnapshots.all(d.symbol, 1) as any[])[0];
    const price = priceRow?.price_usd ?? null;
    const price24h = discoveredAssetQueries.assetPrice24hAgo.get(d.symbol) as any;
    const change24h = (price && price24h?.price_usd && price24h.price_usd !== 0)
      ? ((price - price24h.price_usd) / price24h.price_usd) * 100
      : null;
    return {
      symbol: d.symbol,
      name: d.name,
      address: d.address,
      decimals: d.decimals,
      balance: botState.assetBalances.get(d.symbol) ?? null,
      price,
      change24h,
      isNative: false,
      tradeMethod: 'agentkit',
      priceSource: 'defillama',
      status: d.status,
      source: 'discovered' as const,
      strategyConfig: {
        type: d.strategy_type,
        dropPct: d.drop_pct,
        risePct: d.rise_pct,
        smaShort: d.sma_short,
        smaLong: d.sma_long,
      },
    };
  });

  res.json([...registryAssets, ...allDiscovered]);
});
```

**New asset management endpoints:**

```typescript
// POST /api/assets/:address/enable
app.post('/api/assets/:address/enable', (req, res) => {
  const { address } = req.params;
  const network = botState.activeNetwork;
  const body = req.body as Record<string, unknown>;

  // Validate params FIRST (per spec flow order), then 404 check
  const errors = validateAssetParams(body);
  if (errors.length) return res.status(400).json({ error: errors[0], field: errors[0].split(' ')[0] });

  const row = discoveredAssetQueries.getDiscoveredAsset.get(address, network) as DiscoveredAssetRow | undefined;
  if (!row) return res.status(404).json({ error: `Asset ${address} not found on ${network}` });

  const params = body as { strategyType: string; dropPct: number; risePct: number; smaShort: number; smaLong: number };
  discoveredAssetQueries.updateAssetStrategyConfig.run({
    address, network,
    strategyType: params.strategyType,
    dropPct: params.dropPct, risePct: params.risePct,
    smaShort: params.smaShort, smaLong: params.smaLong,
  });
  discoveredAssetQueries.updateAssetStatus.run('active', address, network);
  engine.startAssetLoop(address, row.symbol, {
    strategyType: params.strategyType as 'threshold' | 'sma',
    dropPct: params.dropPct, risePct: params.risePct,
    smaShort: params.smaShort, smaLong: params.smaLong,
  });
  botState.setPendingTokenCount(discoveredAssetQueries.getPendingAssets.all(network).length);
  res.json({ ok: true });
});

// POST /api/assets/:address/dismiss
app.post('/api/assets/:address/dismiss', (req, res) => {
  const { address } = req.params;
  const network = botState.activeNetwork;
  const row = discoveredAssetQueries.getDiscoveredAsset.get(address, network) as DiscoveredAssetRow | undefined;
  if (!row) return res.status(404).json({ error: `Asset ${address} not found on ${network}` });
  discoveredAssetQueries.updateAssetStatus.run('dismissed', address, network);
  engine.stopAssetLoop(row.symbol);
  botState.setPendingTokenCount(discoveredAssetQueries.getPendingAssets.all(network).length);
  res.json({ ok: true });
});

// PUT /api/assets/:address/config
app.put('/api/assets/:address/config', (req, res) => {
  const { address } = req.params;
  const network = botState.activeNetwork;
  const body = req.body as Record<string, unknown>;
  const row = discoveredAssetQueries.getDiscoveredAsset.get(address, network) as DiscoveredAssetRow | undefined;
  if (!row) return res.status(404).json({ error: `Asset ${address} not found on ${network}` });

  const errors = validateAssetParams(body);
  if (errors.length) return res.status(400).json({ error: errors[0], field: errors[0].split(' ')[0] });

  const params = body as { strategyType: string; dropPct: number; risePct: number; smaShort: number; smaLong: number };
  discoveredAssetQueries.updateAssetStrategyConfig.run({
    address, network,
    strategyType: params.strategyType,
    dropPct: params.dropPct, risePct: params.risePct,
    smaShort: params.smaShort, smaLong: params.smaLong,
  });
  engine.reloadAssetConfig(address, row.symbol, {
    strategyType: params.strategyType as 'threshold' | 'sma',
    dropPct: params.dropPct, risePct: params.risePct,
    smaShort: params.smaShort, smaLong: params.smaLong,
  });
  res.json({ ok: true });
});
```

**validateAssetParams helper:**

```typescript
function validateAssetParams(p: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if ('strategyType' in p && !['threshold', 'sma'].includes(p.strategyType as string)) {
    errors.push('strategyType must be threshold or sma');
  }
  for (const k of ['dropPct', 'risePct']) {
    if (k in p && (typeof p[k] !== 'number' || (p[k] as number) < 0.1)) {
      errors.push(`${k} must be a number >= 0.1`);
    }
  }
  if ('smaShort' in p && (typeof p.smaShort !== 'number' || !Number.isInteger(p.smaShort) || (p.smaShort as number) < 2)) {
    errors.push('smaShort must be an integer >= 2');
  }
  if ('smaLong' in p && (typeof p.smaLong !== 'number' || !Number.isInteger(p.smaLong) || (p.smaLong as number) < 3)) {
    errors.push('smaLong must be an integer >= 3');
  }
  return errors;
}
```

Also add imports at top: `discoveredAssetQueries`, `DiscoveredAssetRow` from `'../data/db.js'`; `TradingEngine` type from `'../trading/engine.js'`.

- [ ] **Step 1: Write failing tests**

Create `tests/server-asset-endpoints.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
// Spin up express app with in-memory SQLite and mocked tools/engine
// Tests:
//   POST /api/assets/0xunkown/enable => 404
//   POST /api/assets/:address/enable with missing strategyType => 400
//   validateAssetParams with dropPct = 0 => error
//   valid enable call => 200 { ok: true }, calls engine.startAssetLoop
//   PUT /api/assets/:address/config => calls engine.reloadAssetConfig
//   POST /api/assets/:address/dismiss => calls engine.stopAssetLoop
```

> Replace comments with real test code using supertest or direct handler invocation.

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run tests/server-asset-endpoints.test.ts
```

- [ ] **Step 3: Implement all changes in server.ts**

- [ ] **Step 4: Run tests and build**

```bash
npx vitest run tests/server-asset-endpoints.test.ts
npm run build
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/web/server.ts tests/server-asset-endpoints.test.ts
git commit -m "feat: update server API for discovered assets and engine integration"
```

---

### Task 9: Wire AlchemyService in index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Read index.ts**

Open `src/index.ts` to understand current wiring order.

- [ ] **Step 2: Instantiate AlchemyService conditionally**

After config is loaded:

```typescript
import { AlchemyService } from './services/alchemy.js';

const alchemyService = config.ALCHEMY_API_KEY
  ? new AlchemyService(config.ALCHEMY_API_KEY)
  : undefined;
```

- [ ] **Step 3: Pass to startPortfolioTracker**

```typescript
const pollNow = await startPortfolioTracker(tools, runtimeConfig, alchemyService);
```

- [ ] **Step 4: Pass engine to startWebServer**

```typescript
startWebServer(tools, runtimeConfig, executor, engine);
```

- [ ] **Step 5: Build**

```bash
npm run build
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire AlchemyService into portfolio tracker and web server"
```

---

### Task 10: Dashboard HTML/JS

**Files:**
- Modify: `src/web/public/index.html`

Changes: ASSETS header button with badge; dynamic asset table replacing hardcoded ETH/USDC grid; Asset Management modal; inline ENABLE/DISMISS actions on pending rows.

- [ ] **Step 1: Read current index.html**

Open `src/web/public/index.html` to understand existing structure, CSS variables, and JavaScript patterns.

- [ ] **Step 2: Add CSS to existing `<style>` block**

```css
/* ASSETS header button */
.assets-btn { position: relative; }
.badge {
  position: absolute; top: -6px; right: -6px;
  background: var(--red, #e74c3c); color: #fff;
  border-radius: 50%; font-size: 11px; width: 18px; height: 18px;
  display: none; align-items: center; justify-content: center;
}
.badge.visible { display: flex; }

/* Asset table */
#asset-table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
#asset-table th, #asset-table td {
  padding: 8px 12px; text-align: left;
  border-bottom: 1px solid var(--border, #333);
}
.change-positive { color: var(--green, #27ae60); }
.change-negative { color: var(--red, #e74c3c); }
.row-pending { background: rgba(255, 180, 0, 0.08); }

/* Asset management modal */
#asset-modal {
  display: none; position: fixed; inset: 0;
  background: rgba(0,0,0,0.6); z-index: 1000;
  align-items: center; justify-content: center;
}
#asset-modal.open { display: flex; }
.modal-box {
  background: var(--surface, #1e1e2e); border-radius: 8px;
  padding: 2rem; max-width: 640px; width: 90%;
  max-height: 80vh; overflow-y: auto;
}
.asset-item { border: 1px solid var(--border, #333); border-radius: 6px; margin-bottom: 0.75rem; }
.asset-item.pending { border-style: dashed; border-color: var(--accent, #f39c12); }
.asset-item-header {
  padding: 0.75rem 1rem; cursor: pointer;
  display: flex; justify-content: space-between; align-items: center;
}
.asset-item-body { display: none; padding: 1rem; border-top: 1px solid var(--border, #333); }
.asset-item-body.open { display: block; }
.pill-group { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; }
.pill {
  padding: 0.25rem 0.75rem; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--border, #333); background: transparent;
  color: var(--text, #eee);
}
.pill.active { background: var(--accent, #f39c12); border-color: var(--accent, #f39c12); color: #000; }
```

- [ ] **Step 3: Update HTML structure**

1. Add ASSETS button to the header nav alongside existing SETTINGS button:
```html
<button class="assets-btn" id="assets-btn" onclick="openAssetModal()">
  ASSETS
  <span id="assets-badge" class="badge">0</span>
</button>
```

2. Replace hardcoded ETH/USDC summary cards with 3-card summary row:
```html
<div id="summary-cards" class="grid"></div>
```

3. Replace hardcoded asset table with dynamic version:
```html
<div class="card">
  <h3>Assets</h3>
  <table id="asset-table">
    <thead><tr>
      <th>ASSET</th><th>PRICE</th><th>BALANCE</th><th>VALUE</th>
      <th>24H</th><th>STRATEGY</th><th></th>
    </tr></thead>
    <tbody id="asset-table-body"></tbody>
  </table>
</div>
```

4. Add modal before closing `</body>`:
```html
<div id="asset-modal">
  <div class="modal-box">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
      <h3 style="margin:0">Asset Management</h3>
      <button onclick="closeAssetModal()">Close</button>
    </div>
    <div id="asset-modal-list"></div>
  </div>
</div>
```

- [ ] **Step 4: Add JavaScript using DOM methods**

Build the asset table using DOM methods (`createElement`, `textContent`, `appendChild`).

`renderAssets()` — reads from `assetList` variable (populated by `loadAssets()` via `/api/assets`):

```javascript
let assetList = [];

async function loadAssets() {
  assetList = await fetchJSON('/api/assets');
  renderAssets();
  // discovered asset pills in price chart
  renderAssetPills();
}

function renderAssets() {
  const tbody = document.getElementById('asset-table-body');
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

  for (const a of assetList) {
    const row = document.createElement('tr');
    if (a.status === 'pending') row.className = 'row-pending';

    const value = (a.balance ?? 0) * (a.price ?? 0);
    const ch = a.change24h;
    const changeText = ch != null ? (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%' : '—';
    const changeClass = ch == null ? '' : ch >= 0 ? 'change-positive' : 'change-negative';

    const cells = [
      { text: a.symbol, cls: '' },
      { text: a.price != null ? '$' + a.price.toFixed(4) : '—', cls: '' },
      { text: a.balance != null ? a.balance.toFixed(6) : '—', cls: '' },
      { text: '$' + value.toFixed(2), cls: '' },
      { text: changeText, cls: changeClass },
    ];
    cells.forEach(({ text, cls }) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      row.appendChild(td);
    });

    // STRATEGY column
    const stratTd = document.createElement('td');
    if (a.status === 'active') {
      stratTd.textContent = '● ' + (a.strategyConfig?.type ?? '');
      stratTd.style.color = 'var(--green, #27ae60)';
    } else if (a.status === 'pending') {
      stratTd.textContent = '⚠ new token';
      stratTd.style.color = 'var(--accent, #f39c12)';
    }
    row.appendChild(stratTd);

    // ACTIONS column
    const actionTd = document.createElement('td');
    if (a.status === 'pending') {
      const enableBtn = document.createElement('button');
      enableBtn.textContent = 'ENABLE';
      enableBtn.onclick = () => enableAsset(a.address);
      actionTd.appendChild(enableBtn);
      actionTd.appendChild(document.createTextNode(' '));
      const dismissBtn = document.createElement('button');
      dismissBtn.textContent = 'DISMISS';
      dismissBtn.onclick = () => dismissAsset(a.address);
      actionTd.appendChild(dismissBtn);
    }
    row.appendChild(actionTd);

    tbody.appendChild(row);
  }
}
```

`updateBadge()` — reads `pendingTokenCount` from `/api/status`:

```javascript
function updateBadge(status) {
  const count = status.pendingTokenCount ?? 0;
  const badge = document.getElementById('assets-badge');
  badge.textContent = String(count);
  badge.classList.toggle('visible', count > 0);
}
```

Modal functions:

```javascript
async function openAssetModal(focusAddress) {
  document.getElementById('asset-modal').classList.add('open');
  await renderModalList(focusAddress);
}

function closeAssetModal() {
  document.getElementById('asset-modal').classList.remove('open');
}

async function renderModalList(focusAddress) {
  const list = document.getElementById('asset-modal-list');
  while (list.firstChild) list.removeChild(list.firstChild);

  if (!assetList.length) {
    const p = document.createElement('p');
    p.textContent = 'No assets. Set ALCHEMY_API_KEY to enable discovery.';
    list.appendChild(p);
    return;
  }

  for (const a of assetList) {
    const item = document.createElement('div');
    item.className = 'asset-item' + (a.status === 'pending' ? ' pending' : '');
    item.id = 'modal-item-' + a.address;

    const header = document.createElement('div');
    header.className = 'asset-item-header';
    if (a.status === 'active') {
      header.onclick = () => toggleModalItem(a.address);
    }

    const titleSpan = document.createElement('span');
    titleSpan.textContent = a.symbol + ' — ' + a.name;
    header.appendChild(titleSpan);

    const statusSpan = document.createElement('span');
    statusSpan.textContent = a.status === 'pending' ? '⚠ pending' : '● active';
    statusSpan.style.color = a.status === 'pending' ? 'var(--accent, #f39c12)' : 'var(--green, #27ae60)';
    header.appendChild(statusSpan);
    item.appendChild(header);

    const body = document.createElement('div');
    body.className = 'asset-item-body' + (focusAddress === a.address ? ' open' : '');
    body.id = 'modal-body-' + a.address;

    // Build config form (shared by pending-ENABLE and active-SAVE)
    buildConfigForm(body, a);

    if (a.status === 'pending') {
      const enableBtn = document.createElement('button');
      enableBtn.textContent = 'ENABLE';
      enableBtn.onclick = () => enableAsset(a.address);
      body.appendChild(enableBtn);
      body.appendChild(document.createTextNode(' '));
      const dismissBtn = document.createElement('button');
      dismissBtn.textContent = 'DISMISS';
      dismissBtn.onclick = () => dismissAsset(a.address);
      body.appendChild(dismissBtn);

      // Auto-open for pending items when focused
      if (focusAddress === a.address) body.classList.add('open');

      // Show body toggle for pending
      header.onclick = () => toggleModalItem(a.address);
    } else {
      const saveBtn = document.createElement('button');
      saveBtn.textContent = 'SAVE';
      saveBtn.onclick = () => saveAssetConfig(a.address);
      body.appendChild(saveBtn);
      body.appendChild(document.createTextNode(' '));
      const disableBtn = document.createElement('button');
      disableBtn.textContent = 'Disable strategy';
      disableBtn.onclick = () => dismissAsset(a.address);
      body.appendChild(disableBtn);
    }

    item.appendChild(body);
    list.appendChild(item);
  }
}

function buildConfigForm(container, asset) {
  const cfg = asset.strategyConfig ?? {};
  const pills = document.createElement('div');
  pills.className = 'pill-group';
  ['threshold', 'sma'].forEach(type => {
    const pill = document.createElement('button');
    pill.className = 'pill' + (cfg.type === type ? ' active' : '');
    pill.textContent = type.toUpperCase();
    pill.dataset.strategy = type;
    pill.onclick = (e) => {
      e.preventDefault();
      pills.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
    };
    pill.id = 'pill-' + asset.address + '-' + type;
    pills.appendChild(pill);
  });
  container.appendChild(pills);
  container.dataset.address = asset.address;

  const fields = [
    { id: 'drop', label: 'Buy on drop %', val: cfg.dropPct ?? 3, step: '0.1', min: '0.1' },
    { id: 'rise', label: 'Sell on rise %', val: cfg.risePct ?? 4, step: '0.1', min: '0.1' },
    { id: 'smaShort', label: 'SMA short window', val: cfg.smaShort ?? 5, step: '1', min: '2' },
    { id: 'smaLong', label: 'SMA long window', val: cfg.smaLong ?? 20, step: '1', min: '3' },
  ];
  fields.forEach(f => {
    const row = document.createElement('div');
    const lbl = document.createElement('label');
    lbl.textContent = f.label + ' ';
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.id = 'cfg-' + asset.address + '-' + f.id;
    inp.value = String(f.val);
    inp.step = f.step;
    inp.min = f.min;
    inp.style.width = '70px';
    lbl.appendChild(inp);
    row.appendChild(lbl);
    container.appendChild(row);
  });
}

function toggleModalItem(address) {
  const body = document.getElementById('modal-body-' + address);
  if (body) body.classList.toggle('open');
}

function readConfigForm(address) {
  const strategyType = document.querySelector(`#modal-item-${address} .pill.active`)?.dataset?.strategy ?? 'threshold';
  return {
    strategyType,
    dropPct:  parseFloat(document.getElementById('cfg-' + address + '-drop').value),
    risePct:  parseFloat(document.getElementById('cfg-' + address + '-rise').value),
    smaShort: parseInt(document.getElementById('cfg-' + address + '-smaShort').value),
    smaLong:  parseInt(document.getElementById('cfg-' + address + '-smaLong').value),
  };
}

async function enableAsset(address) {
  const params = readConfigForm(address);
  const res = await postJSON('/api/assets/' + address + '/enable', params);
  if (res.ok) { await loadAssets(); closeAssetModal(); }
  else alert('Error: ' + res.error);
}

async function dismissAsset(address) {
  const res = await postJSON('/api/assets/' + address + '/dismiss', {});
  if (res.ok) { await loadAssets(); closeAssetModal(); }
  else alert('Error: ' + res.error);
}

async function saveAssetConfig(address) {
  const params = readConfigForm(address);
  const res = await fetch('/api/assets/' + address + '/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  }).then(r => r.json());
  if (res.ok) { await loadAssets(); closeAssetModal(); }
  else alert('Error: ' + res.error);
}
```

Ensure `postJSON` helper is present (or add it):

```javascript
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}
```

Update the existing `loadStatus()` function:
- Use `s.portfolioUsd` directly (no longer compute `price * eth + usdc`)
- Call `updateBadge(s)` with the status object
- Replace hardcoded ETH/USDC summary cards with portfolio/status cards using the summary-cards container

Also call `loadAssets()` in the existing polling interval or on `DOMContentLoaded`.

- [ ] **Step 5: Manual smoke test**

Run `npm run dev` and open the dashboard. Verify:
- Asset table renders with ETH and USDC rows (STRATEGY column shows `● threshold`)
- ASSETS button visible; badge hidden when no pending tokens
- Modal opens and shows asset list
- No console errors
- ASSETS badge shows count when `pendingTokenCount > 0` (test by manually inserting a pending row in SQLite)

- [ ] **Step 6: Commit**

```bash
git add src/web/public/index.html
git commit -m "feat: dynamic asset table, ASSETS modal and badge in dashboard"
```

---

### Task 11: Update docs and stack.env

**Files:**
- Modify: `stack.env`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add ALCHEMY_API_KEY to stack.env**

After existing entries:
```
# Optional: Alchemy API key for ERC20 token auto-discovery
ALCHEMY_API_KEY=
```

- [ ] **Step 2: Update CLAUDE.md**

Add to the `.env Keys` table:

| `ALCHEMY_API_KEY` | (unset) | Optional. Enables ERC20 token auto-discovery via Alchemy. Get a key at dashboard.alchemy.com |

Add to `src/` architecture tree:
```
  services/
    alchemy.ts     # AlchemyService: ERC20 token discovery via Alchemy JSON-RPC
```

- [ ] **Step 3: Commit**

```bash
git add stack.env CLAUDE.md
git commit -m "docs: add ALCHEMY_API_KEY to stack.env and CLAUDE.md"
```

---

## Summary

| Task | File(s) | Tests |
|------|---------|-------|
| 1 | config.ts | build check |
| 2 | db.ts | db-discovered-assets.test.ts |
| 3 | state.ts | state-pending-tokens.test.ts |
| 4 | services/alchemy.ts | alchemy.test.ts (4 tests) |
| 5 | trading/executor.ts | executor-asset.test.ts |
| 6 | trading/engine.ts | engine-asset-loops.test.ts |
| 7 | portfolio/tracker.ts | build check |
| 8 | web/server.ts | server-asset-endpoints.test.ts |
| 9 | index.ts | build check |
| 10 | web/public/index.html | manual smoke test |
| 11 | stack.env, CLAUDE.md | — |
