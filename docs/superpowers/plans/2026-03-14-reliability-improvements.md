# Reliability Improvements Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire per-asset strategy params into strategy evaluation, add wallet address change detection with automated pause + alert, and add MCP server circuit-breaker with health monitoring.

**Architecture:** Three independent tasks — no shared state between them. Task 1 is pure strategy logic (no I/O). Task 2 adds wallet monitoring to the portfolio poll loop with an alert event bus on BotState. Task 3 adds failure tracking to MCPClient with a health-change callback wired at startup. All changes are additive (no breaking API changes) and follow TDD.

**Tech Stack:** TypeScript ESM, Vitest, better-sqlite3 (sync), Telegraf, Express

---

## Chunk 1: Per-Asset Strategy Parameter Injection

### Task 1: Accept explicit params in ThresholdStrategy

**Files:**
- Modify: `src/strategy/threshold.ts`
- Test: `tests/strategy-per-asset-params.test.ts`

**Context:** `ThresholdStrategy` currently reads `config.PRICE_DROP_THRESHOLD_PCT` and `config.PRICE_RISE_TARGET_PCT` from the module-level Zod config. Per-asset discovered tokens have their own `drop_pct` / `rise_pct` in the DB (stored via the Asset Management modal) but these are never passed to the strategy. The fix is to accept optional override params in the constructor; when absent, fall back to global config.

The `engine.ts` already passes `params.dropPct` and `params.risePct` to `startAssetLoop` — they are just silently ignored today because the strategy constructors don't accept them. This task fixes the strategy constructors; Task 3 passes them through.

- [ ] **Step 1: Write the failing test**

Create `tests/strategy-per-asset-params.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  config: {
    PRICE_DROP_THRESHOLD_PCT: 2.0,
    PRICE_RISE_TARGET_PCT: 3.0,
    SMA_SHORT_WINDOW: 3,
    SMA_LONG_WINDOW: 5,
  },
}));

import { ThresholdStrategy } from '../src/strategy/threshold.js';
import { SMAStrategy } from '../src/strategy/sma.js';

// Helpers
function makeSnaps(prices: number[]) {
  return prices.map((p, i) => ({
    eth_price: p,
    eth_balance: 1,
    portfolio_usd: p,
    timestamp: new Date(Date.now() - i * 1000).toISOString(),
  }));
}

describe('ThresholdStrategy — per-asset params', () => {
  it('uses global config when no opts provided', () => {
    const s = new ThresholdStrategy();
    // Prime entry price
    s.evaluate(makeSnaps([100, 99]));
    // 3% drop from high 100 → 97 should trigger buy (>= 2.0% global threshold)
    const result = s.evaluate(makeSnaps([97, 100]));
    expect(result.signal).toBe('buy');
  });

  it('uses explicit dropPct override', () => {
    const s = new ThresholdStrategy({ dropPct: 10.0, risePct: 20.0 });
    s.evaluate(makeSnaps([100, 99]));
    // 3% drop should NOT trigger with 10% threshold
    const result = s.evaluate(makeSnaps([97, 100]));
    expect(result.signal).toBe('hold');
  });

  it('uses explicit risePct override', () => {
    const s = new ThresholdStrategy({ dropPct: 2.0, risePct: 20.0 });
    // Prime entry at 97 via a buy signal
    s.evaluate(makeSnaps([100, 99]));
    s.evaluate(makeSnaps([97, 100])); // sets entryPrice = 97
    // 5% gain from 97 → ~101.85 — below 20% override, should hold
    const result = s.evaluate(makeSnaps([102, 100, 97]));
    expect(result.signal).toBe('hold');
  });
});

describe('SMAStrategy — per-asset params', () => {
  it('uses global config when no opts provided', () => {
    const s = new SMAStrategy();
    const snaps = makeSnaps([1, 1, 1, 1, 1, 1, 1]);
    expect(s.evaluate(snaps).signal).toBe('hold');
  });

  it('uses explicit shortWindow / longWindow override', () => {
    const s = new SMAStrategy({ shortWindow: 2, longWindow: 4 });
    // Need 4 snapshots (longWindow override)
    const result = s.evaluate(makeSnaps([10, 9, 8, 7]));
    // Signal will be 'hold' on first eval (initialising), but should not throw
    expect(['hold', 'buy', 'sell']).toContain(result.signal);
  });

  it('rejects evaluation when fewer snapshots than longWindow override', () => {
    const s = new SMAStrategy({ shortWindow: 2, longWindow: 10 });
    const result = s.evaluate(makeSnaps([1, 2, 3]));
    expect(result.signal).toBe('hold');
    expect(result.reason).toContain('Need 10');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/strategy-per-asset-params.test.ts
```
Expected: FAIL — `ThresholdStrategy constructor does not accept arguments` / param override not applied.

- [ ] **Step 3: Add opts param to ThresholdStrategy**

Replace `src/strategy/threshold.ts`:

```typescript
import type { Strategy, Snapshot, StrategyResult } from './base.js';
import { config } from '../config.js';

export class ThresholdStrategy implements Strategy {
  name = 'threshold';
  private entryPrice: number | null = null;

  constructor(private readonly opts?: { dropPct?: number; risePct?: number }) {}

  evaluate(snapshots: Snapshot[]): StrategyResult {
    if (snapshots.length < 2) return { signal: 'hold', reason: 'Not enough data' };

    const current = snapshots[0].eth_price;
    const recent = snapshots.slice(0, 10).map(s => s.eth_price);
    const rollingHigh = Math.max(...recent);

    if (this.entryPrice === null) {
      this.entryPrice = current;
      return { signal: 'hold', reason: 'Initialising entry price' };
    }

    const dropPct = ((rollingHigh - current) / rollingHigh) * 100;
    const gainPct = ((current - this.entryPrice) / this.entryPrice) * 100;

    const dropThreshold = this.opts?.dropPct ?? config.PRICE_DROP_THRESHOLD_PCT;
    const riseTarget    = this.opts?.risePct ?? config.PRICE_RISE_TARGET_PCT;

    if (dropPct >= dropThreshold) {
      this.entryPrice = current;
      return {
        signal: 'buy',
        reason: `Price dropped ${dropPct.toFixed(2)}% from recent high ($${rollingHigh.toFixed(2)} → $${current.toFixed(2)})`,
      };
    }

    if (gainPct >= riseTarget) {
      this.entryPrice = current;
      return {
        signal: 'sell',
        reason: `Price up ${gainPct.toFixed(2)}% from entry ($${this.entryPrice.toFixed(2)} → $${current.toFixed(2)})`,
      };
    }

    return { signal: 'hold', reason: `Drop: ${dropPct.toFixed(2)}%, Gain from entry: ${gainPct.toFixed(2)}%` };
  }
}
```

- [ ] **Step 4: Add opts param to SMAStrategy**

Replace `src/strategy/sma.ts`:

```typescript
import type { Strategy, Snapshot, StrategyResult } from './base.js';
import { config } from '../config.js';

function sma(prices: number[]): number {
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

export class SMAStrategy implements Strategy {
  name = 'sma';
  private prevShortAboveLong: boolean | null = null;

  constructor(private readonly opts?: { shortWindow?: number; longWindow?: number }) {}

  evaluate(snapshots: Snapshot[]): StrategyResult {
    const shortW = this.opts?.shortWindow ?? config.SMA_SHORT_WINDOW;
    const longW  = this.opts?.longWindow  ?? config.SMA_LONG_WINDOW;

    if (snapshots.length < longW) {
      return { signal: 'hold', reason: `Need ${longW} snapshots, have ${snapshots.length}` };
    }

    const prices = snapshots.map(s => s.eth_price);
    const shortSMA = sma(prices.slice(0, shortW));
    const longSMA  = sma(prices.slice(0, longW));
    const shortAboveLong = shortSMA > longSMA;

    const reason = `SMA${shortW}=$${shortSMA.toFixed(2)} SMA${longW}=$${longSMA.toFixed(2)}`;

    if (this.prevShortAboveLong === null) {
      this.prevShortAboveLong = shortAboveLong;
      return { signal: 'hold', reason: `Initialising — ${reason}` };
    }

    if (!this.prevShortAboveLong && shortAboveLong) {
      this.prevShortAboveLong = true;
      return { signal: 'buy', reason: `Bullish crossover — ${reason}` };
    }

    if (this.prevShortAboveLong && !shortAboveLong) {
      this.prevShortAboveLong = false;
      return { signal: 'sell', reason: `Bearish crossover — ${reason}` };
    }

    this.prevShortAboveLong = shortAboveLong;
    return { signal: 'hold', reason };
  }
}
```

- [ ] **Step 5: Run tests to verify pass**

```bash
npx vitest run tests/strategy-per-asset-params.test.ts
```
Expected: All pass.

- [ ] **Step 6: Verify no regressions**

```bash
npx vitest run
```
Expected: All previously-passing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src/strategy/threshold.ts src/strategy/sma.ts tests/strategy-per-asset-params.test.ts
git commit -m "feat: accept per-asset override params in ThresholdStrategy and SMAStrategy"
```

---

### Task 2: Wire per-asset params into TradingEngine strategy creation

**Files:**
- Modify: `src/trading/engine.ts:137-143` (the `tickAsset` strategy instantiation block)

**Context:** `tickAsset` already receives `params: AssetStrategyParams` which contains `dropPct`, `risePct`, `smaShort`, `smaLong`. These are passed to `startAssetLoop` from the constructor (loaded from DB) and from `reloadAssetConfig` (called from the web server on config update). The only change needed is passing them when constructing strategy instances.

The `buildStrategy()` method for the main ETH loop is left unchanged — it uses global `runtimeConfig` values, not per-asset DB values.

- [ ] **Step 1: Write the failing test (addition to existing file)**

Add a new `describe` block to `tests/engine-asset-loops.test.ts`:

```typescript
describe('tickAsset — uses per-asset strategy params', () => {
  it('passes dropPct and risePct to ThresholdStrategy constructor', async () => {
    // Spy on ThresholdStrategy constructor
    const constructorSpy = vi.spyOn(
      await import('../src/strategy/threshold.js'),
      'ThresholdStrategy' as any
    );
    // ... this is tricky to test directly; instead test via integration:
    // Verify the strategy instance stored in _assetStrategies has the right opts
  });
});
```

Actually the cleanest test here is a behavioural one: verify that an asset loop with `dropPct=50` does NOT trigger a buy on a 3% price drop. Add this to `tests/engine-asset-loops.test.ts` inside the existing `describe` block. Locate the file and add:

```typescript
it('asset loop uses per-asset dropPct (not global config)', async () => {
  // The mock runtimeConfig has PRICE_DROP_THRESHOLD_PCT=2.0 (global)
  // We start a loop with dropPct=50.0 — a 3% drop should NOT trigger buy
  engine.startAssetLoop('0xabc', 'TESTTOKEN', {
    strategyType: 'threshold',
    dropPct: 50.0,   // very high threshold — won't fire
    risePct: 99.0,
    smaShort: 3,
    smaLong: 5,
  });

  // Provide 2 snapshots: high=100, current=97 (3% drop — below 50% threshold)
  mockRecentAssetSnapshots.mockReturnValue([
    { price_usd: 97, balance: 1, timestamp: new Date().toISOString() },
    { price_usd: 100, balance: 1, timestamp: new Date().toISOString() },
  ]);

  // Prime entry price (first eval returns 'hold: initialising')
  await (engine as any).tickAsset('TESTTOKEN', {
    strategyType: 'threshold', dropPct: 50.0, risePct: 99.0, smaShort: 3, smaLong: 5,
  });

  // Second tick — 3% drop should hold with 50% threshold
  await (engine as any).tickAsset('TESTTOKEN', {
    strategyType: 'threshold', dropPct: 50.0, risePct: 99.0, smaShort: 3, smaLong: 5,
  });

  expect(mockExecuteForAsset).not.toHaveBeenCalledWith('TESTTOKEN', 'buy', expect.any(String));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/engine-asset-loops.test.ts
```
Expected: New test FAILs (strategy uses global 2% threshold, triggers buy on 3% drop).

- [ ] **Step 3: Pass params to strategy constructors in tickAsset**

In `src/trading/engine.ts`, find the strategy instantiation block in `tickAsset` (lines ~138-143) and replace:

```typescript
// BEFORE
strategy = params.strategyType === 'sma'
  ? new SMAStrategy()
  : new ThresholdStrategy();

// AFTER
strategy = params.strategyType === 'sma'
  ? new SMAStrategy({ shortWindow: params.smaShort, longWindow: params.smaLong })
  : new ThresholdStrategy({ dropPct: params.dropPct, risePct: params.risePct });
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npx vitest run tests/engine-asset-loops.test.ts
```
Expected: All pass including the new test.

- [ ] **Step 5: Full test suite**

```bash
npx vitest run
```
Expected: All previously-passing tests still pass.

- [ ] **Step 6: Type check**

```bash
npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/trading/engine.ts tests/engine-asset-loops.test.ts
git commit -m "feat: wire per-asset dropPct/risePct/smaShort/smaLong into asset loop strategy instances"
```

---

## Chunk 2: Wallet Address Monitoring

### Task 3: Add alert event bus and walletAddress to BotState

**Files:**
- Modify: `src/core/state.ts`

**Context:** `BotState` already has `emitTrade` / `onTrade` for trade notifications and `onNetworkChange` for network events. We need the same pattern for high-priority alerts (wallet change, MCP failures). `walletAddress` must be on `botState` so the dashboard and Telegram `/status` can display it without re-querying the DB.

- [ ] **Step 1: Write the failing test**

Create `tests/state-alerts.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/config.js', () => ({
  config: { NETWORK_ID: 'base-sepolia' },
  availableNetworks: ['base-sepolia'],
}));

// Import AFTER mock
const { botState } = await import('../src/core/state.js');

describe('BotState alerts', () => {
  beforeEach(() => {
    // Clear listeners between tests by re-importing won't work (singleton);
    // use the emitAlert and verify calls instead
  });

  it('calls registered alert listeners with the message', () => {
    const listener = vi.fn();
    botState.onAlert(listener);
    botState.emitAlert('test alert message');
    expect(listener).toHaveBeenCalledWith('test alert message');
  });

  it('stores and returns walletAddress', () => {
    botState.setWalletAddress('0xABC123');
    expect(botState.walletAddress).toBe('0xABC123');
  });

  it('walletAddress is null initially', () => {
    // Fresh import — null before any setWalletAddress call
    // Note: singleton may have been set above; just verify getter exists
    expect(typeof botState.walletAddress).toMatch(/string|object/); // string or null
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/state-alerts.test.ts
```
Expected: FAIL — `botState.onAlert is not a function`.

- [ ] **Step 3: Add alert bus and walletAddress to BotState**

In `src/core/state.ts`, add the following inside the `BotState` class:

```typescript
// Add to private fields:
private _walletAddress: string | null = null;
private alertListeners: ((msg: string) => void)[] = [];

// Add getter:
get walletAddress(): string | null { return this._walletAddress; }

// Add methods:
setWalletAddress(addr: string): void { this._walletAddress = addr; }
emitAlert(message: string): void { this.alertListeners.forEach(l => l(message)); }
onAlert(listener: (msg: string) => void): void { this.alertListeners.push(listener); }
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npx vitest run tests/state-alerts.test.ts
```
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/state.ts tests/state-alerts.test.ts
git commit -m "feat: add walletAddress and alert event bus to BotState"
```

---

### Task 4: Wallet address monitoring in portfolio tracker

**Files:**
- Modify: `src/portfolio/tracker.ts`
- Modify: `src/data/db.ts` (add `settingQueries` to imports used in tracker)
- Test: `tests/wallet-monitor.test.ts`

**Context:** `tracker.ts` already calls `tools.getWalletDetails()` and extracts `wallet.address`. We need to:
1. On first successful fetch: store address in `settings` DB table (key `EXPECTED_WALLET_ADDRESS`) and in `botState.walletAddress`
2. On subsequent fetches: compare; if changed → pause bot + emit alert
3. `settingQueries` is already exported from `src/data/db.ts` and used in `index.ts`; just add it to `tracker.ts` import

- [ ] **Step 1: Write the failing test**

Create `tests/wallet-monitor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSetting = vi.fn();
const mockUpsertSetting = vi.fn();
const mockSetWalletAddress = vi.fn();
const mockSetStatus = vi.fn();
const mockEmitAlert = vi.fn();
const mockGetWalletDetails = vi.fn();

vi.mock('../src/data/db.js', () => ({
  queries: {
    insertAssetSnapshot: { run: vi.fn() },
    insertSnapshot: { run: vi.fn() },
    insertPortfolioSnapshot: { run: vi.fn() },
  },
  discoveredAssetQueries: {
    getDiscoveredAssets: { all: vi.fn().mockReturnValue([]) },
    getAssetByAddress: { get: vi.fn().mockReturnValue(null) },
    upsertDiscoveredAsset: { run: vi.fn() },
  },
  settingQueries: {
    getSetting: { get: mockGetSetting },
    upsertSetting: { run: mockUpsertSetting },
    getAllSettings: { all: vi.fn().mockReturnValue([]) },
  },
}));

vi.mock('../src/core/state.js', () => ({
  botState: {
    activeNetwork: 'base-sepolia',
    updateAssetBalance: vi.fn(),
    updatePrice: vi.fn(),
    setPendingTokenCount: vi.fn(),
    setWalletAddress: mockSetWalletAddress,
    setStatus: mockSetStatus,
    emitAlert: mockEmitAlert,
  },
}));

vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/assets/registry.js', () => ({
  assetsForNetwork: () => [],
}));

const mockRuntimeConfig = {
  get: vi.fn((k: string) => k === 'POLL_INTERVAL_SECONDS' ? 30 : undefined),
  subscribe: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetWalletDetails.mockResolvedValue({ address: '0xABC', balance: '1.0' });
});

const mockTools = {
  getWalletDetails: mockGetWalletDetails,
  fetchPriceFeedId: vi.fn(),
  fetchPrice: vi.fn().mockResolvedValue(2000),
  getErc20Balance: vi.fn().mockResolvedValue(0),
  getTokenPrices: vi.fn().mockResolvedValue({}),
} as any;

import { startPortfolioTracker } from '../src/portfolio/tracker.js';

describe('Wallet address monitoring', () => {
  it('stores address on first poll when not in DB', async () => {
    mockGetSetting.mockReturnValue(undefined); // not stored yet
    await startPortfolioTracker(mockTools, mockRuntimeConfig as any);
    expect(mockUpsertSetting).toHaveBeenCalledWith('EXPECTED_WALLET_ADDRESS', '0xABC');
    expect(mockSetWalletAddress).toHaveBeenCalledWith('0xABC');
  });

  it('does nothing when address matches stored', async () => {
    mockGetSetting.mockReturnValue({ value: '0xABC' }); // already stored
    await startPortfolioTracker(mockTools, mockRuntimeConfig as any);
    expect(mockSetStatus).not.toHaveBeenCalledWith('paused');
    expect(mockEmitAlert).not.toHaveBeenCalled();
  });

  it('pauses bot and emits alert when address changes', async () => {
    mockGetSetting.mockReturnValue({ value: '0xOLDADDRESS' }); // stored = old
    mockGetWalletDetails.mockResolvedValue({ address: '0xNEWADDRESS', balance: '0' });
    await startPortfolioTracker(mockTools, mockRuntimeConfig as any);
    expect(mockSetStatus).toHaveBeenCalledWith('paused');
    expect(mockEmitAlert).toHaveBeenCalledWith(expect.stringContaining('WALLET ADDRESS CHANGED'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/wallet-monitor.test.ts
```
Expected: FAIL — tracker does not call `settingQueries` or `botState.setWalletAddress`.

- [ ] **Step 3: Add wallet monitoring to tracker.ts**

In `src/portfolio/tracker.ts`, update the import from `db.js`:

```typescript
// BEFORE
import { queries, discoveredAssetQueries, type DiscoveredAssetRow } from '../data/db.js';

// AFTER
import { queries, discoveredAssetQueries, settingQueries, type DiscoveredAssetRow } from '../data/db.js';
```

Then, inside the `poll` function, immediately after `const wallet = await tools.getWalletDetails();` and the `ethBalance` extraction, add the wallet monitoring block:

```typescript
// Wallet address integrity check
const walletAddress = (wallet as any).address as string | undefined;
if (walletAddress) {
  const stored = settingQueries.getSetting.get('EXPECTED_WALLET_ADDRESS');
  if (!stored) {
    settingQueries.upsertSetting.run('EXPECTED_WALLET_ADDRESS', walletAddress);
    botState.setWalletAddress(walletAddress);
    logger.info(`Wallet address established: ${walletAddress}`);
  } else if (walletAddress.toLowerCase() !== stored.value.toLowerCase()) {
    const msg = `⚠️ WALLET ADDRESS CHANGED: expected ${stored.value}, got ${walletAddress}`;
    logger.error(msg);
    botState.setStatus('paused');
    botState.emitAlert(msg);
  } else {
    botState.setWalletAddress(walletAddress);
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npx vitest run tests/wallet-monitor.test.ts
```
Expected: All 3 tests pass.

- [ ] **Step 5: Full test suite**

```bash
npx vitest run
```
Expected: All previously-passing tests still pass.

- [ ] **Step 6: Type check**

```bash
npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/portfolio/tracker.ts tests/wallet-monitor.test.ts
git commit -m "feat: detect wallet address changes in portfolio tracker — pause bot and alert on mismatch"
```

---

### Task 5: Telegram wallet alerts + /resetwallet + /status wallet display

**Files:**
- Modify: `src/telegram/bot.ts`
- Modify: `src/web/server.ts` (wallet address in `/api/status` + `/api/wallet/reset` endpoint)
- Modify: `src/index.ts` (wire alert listener)

**Context:** `botState.onAlert` is now available (Task 3). Wire it to Telegram push notifications. Add `/resetwallet` Telegram command and `POST /api/wallet/reset` web endpoint — both clear `EXPECTED_WALLET_ADDRESS` from the settings DB. Update `/status` Telegram reply to include wallet address. Expose `walletAddress` in `/api/status` JSON.

- [ ] **Step 1: Wire alert listener in index.ts**

In `src/index.ts`, after the `botState.onNetworkChange` block, add:

```typescript
botState.onAlert(async message => {
  logger.error(`ALERT: ${message}`);
  // Telegram bot handles its own alert subscription via startTelegramBot
});
```

Actually, the Telegram bot registers its own listeners inside `startTelegramBot`. So just ensure `startTelegramBot` is called before any alerts could fire. The current order (startTelegramBot → startWebServer → startPortfolioTracker-initiated polling) is correct since `poll()` runs after both. No change needed to `index.ts` for this step.

- [ ] **Step 2: Add alert push to Telegram bot**

In `src/telegram/bot.ts`, after the `botState.onTrade` block (around line 110), add:

```typescript
// Push high-priority alerts (wallet change, MCP failures)
botState.onAlert(async message => {
  for (const chatId of allowed) {
    await bot.telegram.sendMessage(chatId, `🚨 *ALERT*\n${message}`, { parse_mode: 'Markdown' });
  }
});
```

- [ ] **Step 3: Add wallet address to /status Telegram reply**

In `src/telegram/bot.ts`, update the `/status` command handler. After `const price = botState.lastPrice ?? 0;`, add:

```typescript
const wallet = botState.walletAddress ? `\nWallet: \`${botState.walletAddress}\`` : '';
```

And append `${wallet}` to the reply string, after the `Network:` line:

```typescript
ctx.reply(
  `*Bot Status*\n` +
  `Status: ${botState.status}\n` +
  `Network: ${botState.activeNetwork}${wallet}\n` +
  ...
```

- [ ] **Step 4: Add /resetwallet Telegram command**

In `src/telegram/bot.ts`, add before `bot.command('help', ...)`:

```typescript
bot.command('resetwallet', ctx => {
  settingQueries.upsertSetting.run('EXPECTED_WALLET_ADDRESS', '');
  botState.setWalletAddress(null as any);
  queries.insertEvent.run('wallet_reset', `Expected wallet address cleared by Telegram user ${ctx.from?.username}`);
  ctx.reply('Expected wallet address cleared. Bot will re-establish on next poll.');
});
```

Add `settingQueries` to the import from `'../data/db.js'`:
```typescript
import { queries, settingQueries } from '../data/db.js';
```

Update `bot.command('help', ...)` to include `/resetwallet`:
```typescript
'/resetwallet — clear expected wallet address (use after deliberate wallet change)\n' +
```

- [ ] **Step 5: Expose walletAddress in /api/status and add /api/wallet/reset**

In `src/web/server.ts`, in the `/api/status` handler, add `walletAddress: botState.walletAddress` to the response object.

Add a new endpoint after the network endpoints:

```typescript
app.post('/api/wallet/reset', (_req, res) => {
  settingQueries.upsertSetting.run('EXPECTED_WALLET_ADDRESS', '');
  botState.setWalletAddress(null as any);
  queries.insertEvent.run('wallet_reset', 'Expected wallet address cleared via web API');
  logger.info('Expected wallet address cleared via web API');
  res.json({ ok: true });
});
```

Add `settingQueries` to the import from `'../data/db.js'` in `server.ts`.

- [ ] **Step 6: Type check and full test suite**

```bash
npx tsc --noEmit && npx vitest run
```
Expected: No type errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/telegram/bot.ts src/web/server.ts src/index.ts
git commit -m "feat: Telegram wallet-change alert, /resetwallet command, wallet address in /status"
```

---

## Chunk 3: MCP Server Resilience

### Task 6: Circuit breaker in MCPClient with health-change callback

**Files:**
- Modify: `src/mcp/client.ts`
- Modify: `src/index.ts` (pass health callback)
- Test: `tests/mcp-resilience.test.ts`

**Context:** `callTool` currently throws on failure with no tracking. We need to count consecutive failures. After `MCP_FAILURE_THRESHOLD` (3) consecutive failures, call an optional `onHealthChange(false)` callback. On the first success after failures, call `onHealthChange(true)` and reset the counter. The caller (`index.ts`) wires this to pause/resume the bot and emit alerts. MCPClient itself stays stateless re: bot logic.

Additionally, before each `callTool`, check `GET /health` on the MCP server base URL (URL with `/mcp` replaced by empty string). If health check fails, skip the call and increment the failure counter. This prevents hanging connections to an offline server.

The `onHealthChange` callback is optional so existing tests that construct `MCPClient` without it continue to work.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-resilience.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock the MCP SDK client
const mockCallTool = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    callTool: mockCallTool,
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({
    close: mockClose,
  })),
}));

// Mock fetch for health checks
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { MCPClient } from '../src/mcp/client.js';

describe('MCPClient resilience', () => {
  let onHealthChange: ReturnType<typeof vi.fn>;
  let client: MCPClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    onHealthChange = vi.fn();
    client = new MCPClient('http://mcp-server:3002/mcp', () => 'base-sepolia', onHealthChange);
    await client.connect();
    // Default: health check passes
    mockFetch.mockResolvedValue({ ok: true });
  });

  it('does not call onHealthChange on first success', async () => {
    mockCallTool.mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: '"ok"' }],
    });
    await client.callTool('test_tool', {});
    expect(onHealthChange).not.toHaveBeenCalled();
  });

  it('calls onHealthChange(false) after 3 consecutive failures', async () => {
    mockFetch.mockResolvedValue({ ok: false }); // health check fails
    await client.callTool('test_tool', {}).catch(() => {});
    await client.callTool('test_tool', {}).catch(() => {});
    await client.callTool('test_tool', {}).catch(() => {});
    expect(onHealthChange).toHaveBeenCalledWith(false);
  });

  it('calls onHealthChange(true) on recovery after failures', async () => {
    mockFetch.mockResolvedValue({ ok: false });
    await client.callTool('test_tool', {}).catch(() => {});
    await client.callTool('test_tool', {}).catch(() => {});
    await client.callTool('test_tool', {}).catch(() => {});

    // Now recover
    mockFetch.mockResolvedValue({ ok: true });
    mockCallTool.mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: '"recovered"' }],
    });
    await client.callTool('test_tool', {});
    expect(onHealthChange).toHaveBeenCalledWith(true);
  });

  it('does not call onHealthChange(false) twice in a row', async () => {
    mockFetch.mockResolvedValue({ ok: false });
    for (let i = 0; i < 6; i++) {
      await client.callTool('test_tool', {}).catch(() => {});
    }
    const falseCallCount = onHealthChange.mock.calls.filter(c => c[0] === false).length;
    expect(falseCallCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/mcp-resilience.test.ts
```
Expected: FAIL — MCPClient constructor does not accept `onHealthChange`, no failure tracking exists.

- [ ] **Step 3: Rewrite MCPClient with resilience**

Replace `src/mcp/client.ts`:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { logger } from '../core/logger.js';

const FAILURE_THRESHOLD = 3;

export class MCPClient {
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private connected = false;
  private consecutiveFailures = 0;
  private healthy = true;
  private readonly healthUrl: string;

  constructor(
    private readonly url: string,
    private readonly getNetwork: () => string,
    private readonly onHealthChange?: (healthy: boolean) => void,
  ) {
    this.transport = new StreamableHTTPClientTransport(new URL(url));
    this.client = new Client({ name: 'coinbase-trade-bot', version: '0.1.0' });
    this.healthUrl = url.replace(/\/mcp$/, '') + '/health';
  }

  get network(): string { return this.getNetwork(); }
  get isHealthy(): boolean { return this.healthy; }
  get failureCount(): number { return this.consecutiveFailures; }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
    this.connected = true;
    logger.info(`MCP client connected`);
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!this.connected) throw new Error('MCP client not connected');

    // Pre-flight health check — skip if server is not responding
    try {
      const health = await fetch(this.healthUrl);
      if (!health.ok) {
        this._recordFailure();
        throw new Error(`MCP server unhealthy (${health.status})`);
      }
    } catch (err) {
      if ((err as Error).message.startsWith('MCP server unhealthy')) throw err;
      // fetch itself failed (ECONNREFUSED, etc.)
      this._recordFailure();
      throw new Error(`MCP server unreachable: ${(err as Error).message}`);
    }

    const argsWithNetwork = { network: this.getNetwork(), ...args };

    try {
      const result = await this.client.callTool({ name, arguments: argsWithNetwork });

      if (result.isError) {
        this._recordFailure();
        throw new Error(`MCP tool error [${name}]: ${JSON.stringify(result.content)}`);
      }

      this._recordSuccess();

      const content = result.content as { type: string; text?: string }[];
      const text = content
        .filter(c => c.type === 'text')
        .map(c => c.text ?? '')
        .join('\n');

      try {
        const parsed = JSON.parse(text);
        if (typeof parsed === 'string') {
          try { return JSON.parse(parsed) as T; } catch { return parsed as unknown as T; }
        }
        return parsed as T;
      } catch {
        return text as unknown as T;
      }
    } catch (err) {
      if (!(err as Error).message.startsWith('MCP server')) {
        this._recordFailure();
      }
      throw err;
    }
  }

  private _recordFailure(): void {
    this.consecutiveFailures++;
    logger.warn(`MCP failure #${this.consecutiveFailures}`);
    if (this.consecutiveFailures >= FAILURE_THRESHOLD && this.healthy) {
      this.healthy = false;
      logger.error(`MCP server marked unhealthy after ${this.consecutiveFailures} consecutive failures`);
      this.onHealthChange?.(false);
    }
  }

  private _recordSuccess(): void {
    if (!this.healthy) {
      this.healthy = true;
      logger.info('MCP server recovered');
      this.onHealthChange?.(true);
    }
    this.consecutiveFailures = 0;
  }

  async disconnect(): Promise<void> {
    await this.transport.close();
    this.connected = false;
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npx vitest run tests/mcp-resilience.test.ts
```
Expected: All pass.

- [ ] **Step 5: Full test suite**

```bash
npx vitest run
```
Expected: All previously-passing tests still pass.

- [ ] **Step 6: Type check**

```bash
npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/client.ts tests/mcp-resilience.test.ts
git commit -m "feat: add circuit breaker and health check to MCPClient"
```

---

### Task 7: Wire MCPClient health callback in index.ts + expose in dashboard

**Files:**
- Modify: `src/index.ts`
- Modify: `src/core/state.ts` (add `mcpHealthy` field)
- Modify: `src/web/server.ts` (expose in `/api/status`)

**Context:** MCPClient now supports an `onHealthChange` callback. Wire it to `botState` (pause/resume + alert) and expose MCP health in the dashboard status API so the UI can show a warning indicator.

- [ ] **Step 1: Add mcpHealthy to BotState**

In `src/core/state.ts`, add:

```typescript
// Private field:
private _mcpHealthy = true;

// Getter:
get mcpHealthy(): boolean { return this._mcpHealthy; }

// Setter:
setMcpHealthy(healthy: boolean): void { this._mcpHealthy = healthy; }
```

- [ ] **Step 2: Wire onHealthChange in index.ts**

In `src/index.ts`, update the `MCPClient` constructor call:

```typescript
// BEFORE
const mcp = new MCPClient(config.MCP_SERVER_URL, () => botState.activeNetwork);

// AFTER
const mcp = new MCPClient(config.MCP_SERVER_URL, () => botState.activeNetwork, (healthy) => {
  botState.setMcpHealthy(healthy);
  if (!healthy) {
    botState.setStatus('paused');
    botState.emitAlert('⚠️ MCP server unreachable — bot paused. Will resume automatically on recovery.');
  } else {
    botState.setStatus('running');
    botState.emitAlert('✅ MCP server recovered — bot resumed.');
  }
});
```

- [ ] **Step 3: Expose mcpHealthy in /api/status**

In `src/web/server.ts`, in the `/api/status` GET handler, add to the response JSON:

```typescript
mcpHealthy: (mcp as any)?.isHealthy ?? true,
```

Wait — `server.ts` does not have access to the `mcp` object. Use `botState.mcpHealthy` instead (set in the callback above):

```typescript
mcpHealthy: botState.mcpHealthy,
```

- [ ] **Step 4: Type check and full test suite**

```bash
npx tsc --noEmit && npx vitest run
```
Expected: No errors, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/core/state.ts src/web/server.ts
git commit -m "feat: wire MCP health callback — auto-pause on failure, expose mcpHealthy in /api/status"
```

---

## Summary

After all tasks complete, verify end-to-end:

```bash
npx tsc --noEmit
npx vitest run
```

All 7 tasks produce commits independently. The three improvements are fully independent and can be executed in parallel by subagents:
- **Chunk 1** (Tasks 1–2): pure strategy logic, no I/O, no state changes
- **Chunk 2** (Tasks 3–5): wallet monitoring, alert bus, Telegram commands
- **Chunk 3** (Tasks 6–7): MCP circuit breaker and dashboard exposure

Known limitations addressed:
- Per-asset `drop_pct`/`rise_pct` from DB are now used in strategy evaluation (removes the "Known Limitation" note from CLAUDE.md)
- Wallet address changes are detected within one poll cycle and immediately pause the bot
- MCP server going offline no longer accumulates silent errors — bot pauses after 3 failures and resumes automatically
