# Bulk Asset Enable/Dismiss Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bulk enable/dismiss for pending assets — per-row checkboxes, Select All, and a floating action bar.

**Architecture:** Two new Express endpoints (`POST /api/assets/bulk-enable` and `POST /api/assets/bulk-dismiss`) process address arrays in a single DB transaction. The frontend adds a checkbox column to AssetsTable (pending rows only), a Select All header checkbox, and a new BulkActionBar component fixed to the viewport bottom.

**Tech Stack:** TypeScript/Express (backend), Svelte 4 + Tailwind (frontend), better-sqlite3 (DB), Vitest + http module (tests)

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/web/routes/assets.ts` | Add 2 bulk endpoints before existing `:address/*` routes |
| Create | `tests/bulk-asset-actions.test.ts` | Backend tests for bulk endpoints |
| Modify | `src/frontend/src/lib/api.ts` | Add `bulkEnableAssets` and `bulkDismissAssets` |
| Create | `src/frontend/src/lib/components/BulkActionBar.svelte` | Floating action bar component |
| Modify | `src/frontend/src/lib/components/AssetsTable.svelte` | Checkboxes + wire BulkActionBar |

---

### Task 1: Add bulk endpoints to assets route

**Files:**
- Modify: `src/web/routes/assets.ts`
- Create: `tests/bulk-asset-actions.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Create `tests/bulk-asset-actions.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DiscoveredAssetRow } from '../src/data/db.js';
import http from 'http';
import type { AddressInfo } from 'net';

// ── Capture express app ──────────────────────────────────────────────────────
let capturedApp: import('express').Application | null = null;

vi.mock('express', async (importOriginal) => {
  const actual = await importOriginal<typeof import('express')>();
  const factory = (...args: Parameters<typeof actual.default>) => {
    const app = actual.default(...args);
    (app as any).listen = vi.fn().mockReturnValue({ address: () => ({ port: 0 }) });
    capturedApp = app;
    return app;
  };
  Object.assign(factory, actual.default);
  return { default: factory };
});

// ── Pending row fixture ──────────────────────────────────────────────────────
const mkPending = (): DiscoveredAssetRow => ({
  address: '0xaaa',
  network: 'base-sepolia',
  symbol: 'SPAM',
  name: 'Spam Token',
  decimals: 18,
  status: 'pending',
  drop_pct: 2.0,
  rise_pct: 3.0,
  sma_short: 5,
  sma_long: 20,
  strategy: 'threshold',
  discovered_at: '2025-01-01T00:00:00',
  sma_use_ema: 1,
  sma_volume_filter: 1,
  sma_rsi_filter: 1,
  grid_manual_override: 0,
  grid_upper_bound: null,
  grid_lower_bound: null,
  grid_levels: 10,
  grid_amount_pct: 5.0,
});

// ── Mock DB ──────────────────────────────────────────────────────────────────
const mockUpdateAssetStatus = vi.fn();
const mockDismissAsset = vi.fn();
const mockGetDiscoveredAssets = vi.fn(() => [mkPending()]);

vi.mock('../src/data/db.js', () => ({
  db: {},
  runTransaction: vi.fn((fn: () => void) => fn()),
  queries: {
    recentAssetSnapshots: { all: vi.fn(() => []) },
    recentSnapshots: { all: vi.fn(() => []) },
    recentTrades: { all: vi.fn(() => []) },
    recentPortfolioSnapshots: { all: vi.fn(() => []) },
  },
  settingQueries: {
    getSetting: { get: vi.fn() },
    upsertSetting: { run: vi.fn() },
    getAllSettings: { all: vi.fn(() => []) },
  },
  candleQueries: {
    getCandles: { all: vi.fn(() => []) },
  },
  discoveredAssetQueries: {
    getAssetByAddress: { get: vi.fn() },
    getDiscoveredAssets: { all: mockGetDiscoveredAssets },
    getActiveAssets: { all: vi.fn(() => []) },
    updateAssetStatus: { run: mockUpdateAssetStatus },
    updateAssetStrategyConfig: { run: vi.fn() },
    updateGridConfig: { run: vi.fn() },
    dismissAsset: { run: mockDismissAsset },
    upsertDiscoveredAsset: { run: vi.fn() },
  },
}));

vi.mock('../src/core/state.js', () => ({
  botState: {
    activeNetwork: 'base-sepolia',
    setPendingTokenCount: vi.fn(),
    assetBalances: new Map(),
    lastPrice: null,
    lastBalance: null,
  },
}));

vi.mock('../src/config.js', () => ({
  config: { WEB_PORT: 3099, DATA_DIR: '/tmp/test', NETWORK_ID: 'base-sepolia', SESSION_SECRET: 'test' },
  availableNetworks: ['base-sepolia', 'base-mainnet'],
}));

vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/mcp/client.js', () => ({ MCPClient: vi.fn() }));
vi.mock('../src/portfolio/tracker.js', () => ({ PortfolioTracker: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })) }));
vi.mock('../src/telegram/bot.js', () => ({ TelegramBot: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })) }));
vi.mock('../src/trading/engine.js', () => ({
  TradingEngine: vi.fn(() => ({
    start: vi.fn(), stop: vi.fn(),
    startAssetLoop: vi.fn(), stopAssetLoop: vi.fn(),
    reloadAssetConfig: vi.fn(),
  })),
}));

// ── HTTP helper ──────────────────────────────────────────────────────────────
function request(server: http.Server, method: string, path: string, body?: unknown) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const payload = body != null ? JSON.stringify(body) : undefined;
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method,
        headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe('POST /api/assets/bulk-dismiss', () => {
  let server: http.Server;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetDiscoveredAssets.mockReturnValue([mkPending()]);
    capturedApp = null;
    await import('../src/web/server.js');
    server = http.createServer(capturedApp!);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  });

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()));
    vi.resetModules();
  });

  it('dismisses pending assets and returns succeeded count', async () => {
    const res = await request(server, 'POST', '/api/assets/bulk-dismiss', { addresses: ['0xaaa'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, succeeded: 1, skipped: 0 });
    expect(mockDismissAsset.run).toHaveBeenCalledWith('0xaaa', 'base-sepolia');
  });

  it('skips non-pending assets', async () => {
    const res = await request(server, 'POST', '/api/assets/bulk-dismiss', { addresses: ['0xunknown'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, succeeded: 0, skipped: 1 });
    expect(mockDismissAsset.run).not.toHaveBeenCalled();
  });

  it('returns 400 for empty addresses array', async () => {
    const res = await request(server, 'POST', '/api/assets/bulk-dismiss', { addresses: [] });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/assets/bulk-enable', () => {
  let server: http.Server;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetDiscoveredAssets.mockReturnValue([mkPending()]);
    capturedApp = null;
    await import('../src/web/server.js');
    server = http.createServer(capturedApp!);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  });

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()));
    vi.resetModules();
  });

  it('enables pending assets and returns succeeded count', async () => {
    const res = await request(server, 'POST', '/api/assets/bulk-enable', { addresses: ['0xaaa'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, succeeded: 1, skipped: 0 });
    expect(mockUpdateAssetStatus.run).toHaveBeenCalledWith({ status: 'active', address: '0xaaa', network: 'base-sepolia' });
  });

  it('skips non-pending assets', async () => {
    const res = await request(server, 'POST', '/api/assets/bulk-enable', { addresses: ['0xunknown'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, succeeded: 0, skipped: 1 });
    expect(mockUpdateAssetStatus.run).not.toHaveBeenCalled();
  });

  it('returns 400 for empty addresses array', async () => {
    const res = await request(server, 'POST', '/api/assets/bulk-enable', { addresses: [] });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 1.2: Run tests to confirm they fail**

```bash
cd /home/pi/share/coinbase-trade
npx vitest run tests/bulk-asset-actions.test.ts 2>&1 | tail -20
```

Expected: FAIL — routes not yet defined.

- [ ] **Step 1.3: Add `runTransaction` to the import in `assets.ts`**

In `src/web/routes/assets.ts`, find:

```typescript
import { queries, discoveredAssetQueries, candleQueries } from '../../data/db.js';
```

Change to:

```typescript
import { queries, discoveredAssetQueries, candleQueries, runTransaction } from '../../data/db.js';
```

- [ ] **Step 1.4: Add bulk endpoints to `registerAssetsRoutes` in `assets.ts`**

These MUST be registered before the existing `router.post('/api/assets/:address/enable', ...)` and `router.post('/api/assets/:address/dismiss', ...)` lines, otherwise Express matches `bulk-enable` as an `:address` param.

Find the line `router.get('/api/assets', ...)` and add the two new routes immediately after the GET handler closes (before the existing POST `:address/enable`):

```typescript
  // POST /api/assets/bulk-enable — must be before /:address/enable
  router.post('/api/assets/bulk-enable', (req, res) => {
    const { addresses } = req.body as { addresses: string[] };
    if (!Array.isArray(addresses) || addresses.length === 0) {
      return res.status(400).json({ error: 'addresses must be a non-empty array' });
    }
    const network = botState.activeNetwork;
    const allAssets = discoveredAssetQueries.getDiscoveredAssets.all(network) as DiscoveredAssetRow[];

    const toEnable: DiscoveredAssetRow[] = [];
    let skipped = 0;
    for (const address of addresses) {
      const row = allAssets.find(r => r.address === address);
      if (!row || row.status !== 'pending') { skipped++; continue; }
      toEnable.push(row);
    }

    runTransaction(() => {
      for (const row of toEnable) {
        discoveredAssetQueries.updateAssetStatus.run({ status: 'active', address: row.address, network });
      }
    });

    for (const row of toEnable) {
      engine.startAssetLoop(row.address, row.symbol, {
        strategyType: row.strategy as 'threshold' | 'sma' | 'grid' | 'momentum-burst' | 'volatility-breakout' | 'trend-continuation',
        dropPct: row.drop_pct,
        risePct: row.rise_pct,
        smaShort: row.sma_short,
        smaLong: row.sma_long,
      });
    }

    const allDiscovered = discoveredAssetQueries.getDiscoveredAssets.all(network) as DiscoveredAssetRow[];
    botState.setPendingTokenCount(allDiscovered.filter(r => r.status === 'pending').length);
    return res.json({ ok: true, succeeded: toEnable.length, skipped });
  });

  // POST /api/assets/bulk-dismiss — must be before /:address/dismiss
  router.post('/api/assets/bulk-dismiss', (req, res) => {
    const { addresses } = req.body as { addresses: string[] };
    if (!Array.isArray(addresses) || addresses.length === 0) {
      return res.status(400).json({ error: 'addresses must be a non-empty array' });
    }
    const network = botState.activeNetwork;
    const allAssets = discoveredAssetQueries.getDiscoveredAssets.all(network) as DiscoveredAssetRow[];

    const toProcess: DiscoveredAssetRow[] = [];
    let skipped = 0;
    for (const address of addresses) {
      const row = allAssets.find(r => r.address === address);
      if (!row || row.status !== 'pending') { skipped++; continue; }
      toProcess.push(row);
    }

    runTransaction(() => {
      for (const row of toProcess) {
        discoveredAssetQueries.dismissAsset.run(row.address, network);
      }
    });

    for (const row of toProcess) {
      engine.stopAssetLoop(row.symbol);
    }

    const allDiscovered = discoveredAssetQueries.getDiscoveredAssets.all(network) as DiscoveredAssetRow[];
    botState.setPendingTokenCount(allDiscovered.filter(r => r.status === 'pending').length);
    return res.json({ ok: true, succeeded: toProcess.length, skipped });
  });
```

- [ ] **Step 1.5: Run tests to confirm they pass**

```bash
npx vitest run tests/bulk-asset-actions.test.ts 2>&1 | tail -20
```

Expected: all 6 tests PASS.

- [ ] **Step 1.6: Run full test suite to check for regressions**

```bash
npx vitest run 2>&1 | tail -10
```

Expected: no new failures.

- [ ] **Step 1.7: Commit**

```bash
git add src/web/routes/assets.ts tests/bulk-asset-actions.test.ts
git commit -m "feat: add bulk-enable and bulk-dismiss endpoints for pending assets"
```

---

### Task 2: Add bulk API functions to frontend

**Files:**
- Modify: `src/frontend/src/lib/api.ts`

- [ ] **Step 2.1: Add the two bulk API functions**

In `src/frontend/src/lib/api.ts`, find:

```typescript
export const dismissAsset = (address: string) =>
  post<{ ok: boolean }>(`/api/assets/${encodeURIComponent(address)}/dismiss`);
```

Add immediately after:

```typescript
export const bulkEnableAssets = (addresses: string[]) =>
  post<{ ok: boolean; succeeded: number; skipped: number }>('/api/assets/bulk-enable', { addresses });

export const bulkDismissAssets = (addresses: string[]) =>
  post<{ ok: boolean; succeeded: number; skipped: number }>('/api/assets/bulk-dismiss', { addresses });
```

- [ ] **Step 2.2: Commit**

```bash
git add src/frontend/src/lib/api.ts
git commit -m "feat: add bulkEnableAssets and bulkDismissAssets API functions"
```

---

### Task 3: Create BulkActionBar component

**Files:**
- Create: `src/frontend/src/lib/components/BulkActionBar.svelte`

- [ ] **Step 3.1: Create the component**

Create `src/frontend/src/lib/components/BulkActionBar.svelte`:

```svelte
<script lang="ts">
  import { bulkEnableAssets, bulkDismissAssets } from '../api';
  import { loadAssets } from '../stores/assets';

  export let selected: Set<string>;
  export let onComplete: () => void;

  let loading = false;
  let statusMessage = '';

  async function handleAction(action: 'enable' | 'dismiss') {
    loading = true;
    statusMessage = '';
    const addresses = [...selected];
    try {
      const fn = action === 'enable' ? bulkEnableAssets : bulkDismissAssets;
      const result = await fn(addresses);
      const verb = action === 'enable' ? 'enabled' : 'dismissed';
      statusMessage = `${result.succeeded} ${verb}${result.skipped ? `, ${result.skipped} skipped` : ''}`;
      await loadAssets();
      onComplete();
    } catch {
      statusMessage = 'Action failed — please try again';
    } finally {
      loading = false;
    }
  }
</script>

{#if selected.size > 0}
  <div class="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-between gap-4 px-6 py-4
              bg-[var(--bg-card)] border-t border-[var(--border)] shadow-lg">
    <span class="text-sm text-[var(--text-secondary)]">
      {selected.size} asset{selected.size === 1 ? '' : 's'} selected
      {#if statusMessage}
        <span class="ml-2 text-[var(--text-primary)]">— {statusMessage}</span>
      {/if}
    </span>
    <div class="flex gap-3">
      <button
        disabled={loading}
        on:click={() => handleAction('enable')}
        class="px-4 py-2 rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50
               disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
      >
        {loading ? '…' : 'Enable Selected'}
      </button>
      <button
        disabled={loading}
        on:click={() => handleAction('dismiss')}
        class="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50
               disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
      >
        {loading ? '…' : 'Dismiss Selected'}
      </button>
    </div>
  </div>
{/if}
```

- [ ] **Step 3.2: Build frontend to verify no Svelte errors**

```bash
cd /home/pi/share/coinbase-trade
npm run build:frontend 2>&1 | grep -E 'error|Error|warning' | head -20
```

Expected: no errors.

- [ ] **Step 3.3: Commit**

```bash
git add src/frontend/src/lib/components/BulkActionBar.svelte
git commit -m "feat: add BulkActionBar component with bulk enable/dismiss"
```

---

### Task 4: Update AssetsTable with checkboxes

**Files:**
- Modify: `src/frontend/src/lib/components/AssetsTable.svelte`

- [ ] **Step 4.1: Add selection state and handlers to the `<script>` block**

In `src/frontend/src/lib/components/AssetsTable.svelte`, find the existing imports at the top of the `<script>` block:

```typescript
  import { assets } from '../stores/assets';
  import { scores } from '../stores/scores';
  import AssetConfigPanel from './AssetConfigPanel.svelte';
```

Change to:

```typescript
  import { assets } from '../stores/assets';
  import { scores } from '../stores/scores';
  import AssetConfigPanel from './AssetConfigPanel.svelte';
  import BulkActionBar from './BulkActionBar.svelte';
```

Then find:

```typescript
  let expandedAddress: string | null = null;
```

Add after it:

```typescript
  let selected = new Set<string>();

  $: pendingAssets = ($assets ?? []).filter(a => a.status === 'pending');
  $: allPendingSelected = pendingAssets.length > 0 && pendingAssets.every(a => selected.has(a.address));
  $: somePendingSelected = !allPendingSelected && pendingAssets.some(a => selected.has(a.address));

  function toggleAsset(address: string) {
    const next = new Set(selected);
    if (next.has(address)) next.delete(address); else next.add(address);
    selected = next;
  }

  function toggleSelectAll() {
    selected = allPendingSelected
      ? new Set()
      : new Set(pendingAssets.map(a => a.address));
  }

  function onBulkComplete() {
    selected = new Set();
  }
```

- [ ] **Step 4.2: Add checkbox column to the table header**

Find:

```html
      <tr class="text-xs font-medium text-[var(--text-secondary)] border-b border-[var(--border)]">
        <th class="px-4 py-2 text-left">Asset</th>
```

Change to:

```html
      <tr class="text-xs font-medium text-[var(--text-secondary)] border-b border-[var(--border)]">
        <th class="px-3 py-2 w-8">
          <input
            type="checkbox"
            checked={allPendingSelected}
            indeterminate={somePendingSelected}
            on:change={toggleSelectAll}
            class="cursor-pointer accent-accent-blue"
            title="Select all pending"
          />
        </th>
        <th class="px-4 py-2 text-left">Asset</th>
```

- [ ] **Step 4.3: Add checkbox cell to each asset row**

Find the opening of the `<tr>` inside `{#each $assets ?? [] as asset (asset.address)}`:

```html
        <tr
          class="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] cursor-pointer transition-colors"
          on:click={() => toggleRow(asset.address)}
        >
          <td class="px-4 py-3 text-sm">
            <span class="font-semibold text-[var(--text-primary)]">{asset.symbol}</span>
```

Change to:

```html
        <tr
          class="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] cursor-pointer transition-colors"
          on:click={() => toggleRow(asset.address)}
        >
          <td class="px-3 py-3 w-8">
            {#if asset.status === 'pending'}
              <input
                type="checkbox"
                checked={selected.has(asset.address)}
                on:click|stopPropagation
                on:change={() => toggleAsset(asset.address)}
                class="cursor-pointer accent-accent-blue"
              />
            {/if}
          </td>
          <td class="px-4 py-3 text-sm">
            <span class="font-semibold text-[var(--text-primary)]">{asset.symbol}</span>
```

- [ ] **Step 4.4: Wire BulkActionBar at the bottom of the template**

Find the closing `</div>` of the outermost card div (after the `</table>` and the `{#if expandedAddress}` block). Add `BulkActionBar` after it:

```html
<BulkActionBar {selected} onComplete={onBulkComplete} />
```

- [ ] **Step 4.5: Build frontend to verify no errors**

```bash
cd /home/pi/share/coinbase-trade
npm run build:frontend 2>&1 | grep -E 'error|Error' | head -20
```

Expected: no errors.

- [ ] **Step 4.6: Full build to verify TypeScript + frontend**

```bash
npm run build 2>&1 | grep -E 'error TS|Error' | head -20
```

Expected: no errors.

- [ ] **Step 4.7: Commit**

```bash
git add src/frontend/src/lib/components/AssetsTable.svelte
git commit -m "feat: add bulk selection checkboxes and BulkActionBar to AssetsTable"
```

---

## Self-Review

**Spec coverage:**
- ✅ Per-row checkboxes on pending rows only
- ✅ Select All header checkbox (pending-scoped, indeterminate state)
- ✅ Floating action bar, hidden when selection empty
- ✅ Enable Selected / Dismiss Selected with loading state
- ✅ Clears selection and refreshes after action
- ✅ Backend processes in single DB transaction, skips non-pending

**Placeholder scan:** None found.

**Type consistency:**
- `bulkEnableAssets` / `bulkDismissAssets` return `{ ok, succeeded, skipped }` — matched in BulkActionBar usage
- `selected: Set<string>` prop type passed correctly from AssetsTable to BulkActionBar
- `updateAssetStatus.run({ status, address, network })` — matches existing usage in assets.ts
- `dismissAsset.run(address, network)` — positional args, matches existing usage
