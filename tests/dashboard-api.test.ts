/**
 * Tests for asset config save with symbol fallback lookup.
 *
 * Verifies that PUT /api/assets/:address/config resolves assets via:
 *   1. Exact address match
 *   2. Case-insensitive address match
 *   3. Symbol fallback (e.g., "ETH" when address is sentinel 0xeeee...)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DiscoveredAssetRow } from '../src/data/db.js';
import http from 'http';
import type { AddressInfo } from 'net';

// ── Captured express app ────────────────────────────────────────────────────
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

// ── Mock DB ─────────────────────────────────────────────────────────────────
const ethRow: DiscoveredAssetRow = {
  address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  network: 'base-sepolia',
  symbol: 'ETH',
  name: 'Ethereum',
  decimals: 18,
  status: 'active',
  drop_pct: 2.0,
  rise_pct: 3.0,
  sma_short: 5,
  sma_long: 20,
  strategy: 'threshold',
  discovered_at: '2025-01-01T00:00:00',
  grid_manual_override: 0,
  grid_upper_bound: null,
  grid_lower_bound: null,
  grid_levels: 10,
  grid_amount_pct: 5.0,
};

vi.mock('../src/data/db.js', () => {
  return {
    db: {},
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
    discoveredAssetQueries: {
      getAssetByAddress: { get: vi.fn(() => undefined) },
      getAssetBySymbol: { get: vi.fn(() => undefined) },
      getDiscoveredAssets: { all: vi.fn(() => []) },
      getActiveAssets: { all: vi.fn(() => []) },
      updateAssetStatus: { run: vi.fn() },
      updateAssetStrategyConfig: { run: vi.fn() },
      updateGridConfig: { run: vi.fn() },
      dismissAsset: { run: vi.fn() },
      upsertDiscoveredAsset: { run: vi.fn() },
    },
  };
});

vi.mock('../src/config.js', () => ({
  config: { WEB_PORT: 3098, DATA_DIR: '/tmp/test' },
  availableNetworks: ['base-sepolia', 'base-mainnet'],
}));

vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMockEngine() {
  return {
    startAssetLoop: vi.fn(),
    stopAssetLoop: vi.fn(),
    reloadAssetConfig: vi.fn(),
    start: vi.fn(),
    tick: vi.fn(),
    optimizerEnabled: false,
    enableOptimizer: vi.fn(),
    disableOptimizer: vi.fn(),
  };
}

function makeMockRuntimeConfig() {
  return {
    get: vi.fn((k: string) => {
      const d: Record<string, unknown> = {
        STRATEGY: 'threshold', DRY_RUN: false,
        DASHBOARD_THEME: 'dark',
      };
      return d[k] ?? null;
    }),
    getAll: vi.fn(() => ({})),
    set: vi.fn(),
    setBatch: vi.fn(),
    subscribeMany: vi.fn(),
  };
}

async function req(
  app: import('express').Application,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app as any);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const hreq = http.request(
        {
          hostname: '127.0.0.1', port, path: urlPath,
          method: method.toUpperCase(),
          headers: {
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
          },
        },
        (hres) => {
          const chunks: Buffer[] = [];
          hres.on('data', (c: Buffer) => chunks.push(c));
          hres.on('end', () => {
            srv.close();
            try {
              resolve({ status: hres.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) });
            } catch {
              resolve({ status: hres.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
            }
          });
        },
      );
      hreq.on('error', (e) => { srv.close(); reject(e); });
      if (payload) hreq.write(payload);
      hreq.end();
    });
  });
}

const configBody = {
  strategyType: 'sma', dropPct: 1.5, risePct: 2.5, smaShort: 5, smaLong: 20,
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('PUT /api/assets/:address/config — symbol fallback lookup', () => {
  let engine: ReturnType<typeof makeMockEngine>;

  beforeEach(async () => {
    capturedApp = null;
    engine = makeMockEngine();

    const { startWebServer } = await import('../src/web/server.js');
    startWebServer(
      {} as any,
      makeMockRuntimeConfig() as any,
      {} as any,
      engine as any,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('resolves asset by exact address match', async () => {
    const { discoveredAssetQueries } = await import('../src/data/db.js') as any;
    discoveredAssetQueries.getAssetByAddress.get.mockReturnValue(ethRow);

    const res = await req(capturedApp!, 'PUT', `/api/assets/${ethRow.address}/config`, configBody);

    expect(res.status).toBe(200);
    expect((res.body as any).ok).toBe(true);
    expect(engine.reloadAssetConfig).toHaveBeenCalledWith(
      ethRow.address, 'ETH',
      expect.objectContaining({ strategyType: 'sma' }),
    );
  });

  it('resolves asset by case-insensitive address match', async () => {
    const { discoveredAssetQueries } = await import('../src/data/db.js') as any;
    // Exact match returns nothing (different case)
    discoveredAssetQueries.getAssetByAddress.get.mockReturnValue(undefined);
    // getAllAssets returns the row with original casing
    discoveredAssetQueries.getDiscoveredAssets.all.mockReturnValue([ethRow]);

    const lowerAddr = ethRow.address.toLowerCase();
    const res = await req(capturedApp!, 'PUT', `/api/assets/${lowerAddr}/config`, configBody);

    expect(res.status).toBe(200);
    expect((res.body as any).ok).toBe(true);
    // Should use the DB address, not the lowercased request param
    expect(engine.reloadAssetConfig).toHaveBeenCalledWith(
      ethRow.address, 'ETH',
      expect.objectContaining({ strategyType: 'sma' }),
    );
  });

  it('resolves asset by symbol when address lookup fails', async () => {
    const { discoveredAssetQueries } = await import('../src/data/db.js') as any;
    // Both address lookups return nothing
    discoveredAssetQueries.getAssetByAddress.get.mockReturnValue(undefined);
    discoveredAssetQueries.getDiscoveredAssets.all.mockReturnValue([]);
    // Symbol lookup finds the asset
    discoveredAssetQueries.getAssetBySymbol.get.mockReturnValue(ethRow);

    const res = await req(capturedApp!, 'PUT', '/api/assets/ETH/config', configBody);

    expect(res.status).toBe(200);
    expect((res.body as any).ok).toBe(true);
    // Should use the real DB address from symbol lookup, not "ETH"
    expect(discoveredAssetQueries.updateAssetStrategyConfig.run).toHaveBeenCalledWith(
      expect.objectContaining({ address: ethRow.address }),
    );
    expect(engine.reloadAssetConfig).toHaveBeenCalledWith(
      ethRow.address, 'ETH',
      expect.objectContaining({ strategyType: 'sma' }),
    );
  });

  it('returns 404 when all lookups fail', async () => {
    const { discoveredAssetQueries } = await import('../src/data/db.js') as any;
    discoveredAssetQueries.getAssetByAddress.get.mockReturnValue(undefined);
    discoveredAssetQueries.getDiscoveredAssets.all.mockReturnValue([]);
    discoveredAssetQueries.getAssetBySymbol.get.mockReturnValue(undefined);

    const res = await req(capturedApp!, 'PUT', '/api/assets/0xnonexistent/config', configBody);

    expect(res.status).toBe(404);
    expect((res.body as any).error).toMatch(/not found/i);
  });
});
