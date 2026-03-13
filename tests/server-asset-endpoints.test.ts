/**
 * Tests for the new asset management endpoints in server.ts.
 *
 * Strategy: we mock express so that when startWebServer creates an app,
 * we capture it and test routes directly via Node's http module.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DiscoveredAssetRow } from '../src/data/db.js';
import http from 'http';
import type { AddressInfo } from 'net';

// ── Captured express app (populated by the express mock below) ────────────────
let capturedApp: import('express').Application | null = null;

// ── Mock express to capture the app and suppress listen ──────────────────────
vi.mock('express', async (importOriginal) => {
  const actual = await importOriginal<typeof import('express')>();
  const factory = (...args: Parameters<typeof actual.default>) => {
    const app = actual.default(...args);
    // Suppress actual listen calls
    (app as any).listen = vi.fn().mockReturnValue({ address: () => ({ port: 0 }) });
    capturedApp = app;
    return app;
  };
  // Copy static methods (json, urlencoded, etc.)
  Object.assign(factory, actual.default);
  return { default: factory };
});

// ── Mock db ───────────────────────────────────────────────────────────────────
vi.mock('../src/data/db.js', () => {
  const mkRow = (): DiscoveredAssetRow => ({
    address: '0xtoken',
    network: 'base-sepolia',
    symbol: 'PEPE',
    name: 'Pepe Token',
    decimals: 18,
    status: 'pending',
    drop_pct: 2.0,
    rise_pct: 3.0,
    sma_short: 5,
    sma_long: 20,
    strategy: 'threshold',
    discovered_at: '2025-01-01T00:00:00',
  });
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
      getAssetByAddress: { get: vi.fn((addr: string) => (addr === '0xtoken' ? mkRow() : undefined)) },
      getDiscoveredAssets: { all: vi.fn(() => [mkRow()]) },
      getActiveAssets: { all: vi.fn(() => []) },
      updateAssetStatus: { run: vi.fn() },
      updateAssetStrategyConfig: { run: vi.fn() },
      dismissAsset: { run: vi.fn() },
      upsertDiscoveredAsset: { run: vi.fn() },
    },
  };
});

vi.mock('../src/config.js', () => ({
  config: { WEB_PORT: 3099, DATA_DIR: '/tmp/test' },
  availableNetworks: ['base-sepolia', 'base-mainnet'],
}));

vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

type MockEngine = {
  startAssetLoop: ReturnType<typeof vi.fn>;
  stopAssetLoop: ReturnType<typeof vi.fn>;
  reloadAssetConfig: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  tick: ReturnType<typeof vi.fn>;
};

function makeMockEngine(): MockEngine {
  return {
    startAssetLoop: vi.fn(),
    stopAssetLoop: vi.fn(),
    reloadAssetConfig: vi.fn(),
    start: vi.fn(),
    tick: vi.fn(),
  };
}

function makeMockRuntimeConfig() {
  return {
    get: vi.fn((k: string) => {
      const d: Record<string, unknown> = {
        STRATEGY: 'threshold', DRY_RUN: false,
        PRICE_DROP_THRESHOLD_PCT: 2, PRICE_RISE_TARGET_PCT: 3,
        SMA_SHORT_WINDOW: 5, SMA_LONG_WINDOW: 20,
      };
      return d[k] ?? null;
    }),
    getAll: vi.fn(() => ({})),
    setBatch: vi.fn(),
    subscribeMany: vi.fn(),
  };
}

/** Issue an HTTP request against a captured express app on a temp port */
async function req(
  app: import('express').Application,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app as any);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const hreq = http.request(
        {
          hostname: '127.0.0.1', port, path,
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('server asset management endpoints', () => {
  let engine: MockEngine;

  beforeEach(async () => {
    capturedApp = null;
    engine = makeMockEngine();

    // Import startWebServer fresh; it will call express() which sets capturedApp
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

  it('POST /api/assets/:address/enable - unknown address returns 404', async () => {
    const { discoveredAssetQueries } = await import('../src/data/db.js') as any;
    discoveredAssetQueries.getAssetByAddress.get.mockReturnValue(undefined);

    const res = await req(capturedApp!, 'POST', '/api/assets/0xunknown/enable', {
      strategyType: 'threshold', dropPct: 2.0, risePct: 3.0, smaShort: 5, smaLong: 20,
    });

    expect(res.status).toBe(404);
    expect((res.body as any).error).toMatch(/not found/i);
  });

  it('POST /api/assets/:address/enable - dropPct=0 returns 400', async () => {
    const res = await req(capturedApp!, 'POST', '/api/assets/0xtoken/enable', {
      strategyType: 'threshold', dropPct: 0, risePct: 3.0, smaShort: 5, smaLong: 20,
    });

    expect(res.status).toBe(400);
    expect((res.body as any).error).toMatch(/dropPct/i);
  });

  it('POST /api/assets/:address/enable - valid params returns 200 { ok: true } and calls startAssetLoop', async () => {
    const { discoveredAssetQueries } = await import('../src/data/db.js') as any;
    const mockRow: DiscoveredAssetRow = {
      address: '0xtoken', network: 'base-sepolia', symbol: 'PEPE',
      name: 'Pepe Token', decimals: 18, status: 'pending',
      drop_pct: 2.0, rise_pct: 3.0, sma_short: 5, sma_long: 20,
      strategy: 'threshold', discovered_at: '2025-01-01T00:00:00',
    };
    discoveredAssetQueries.getAssetByAddress.get.mockReturnValue(mockRow);
    discoveredAssetQueries.getDiscoveredAssets.all.mockReturnValue([mockRow]);

    const res = await req(capturedApp!, 'POST', '/api/assets/0xtoken/enable', {
      strategyType: 'threshold', dropPct: 2.0, risePct: 3.0, smaShort: 5, smaLong: 20,
    });

    expect(res.status).toBe(200);
    expect((res.body as any).ok).toBe(true);
    expect(engine.startAssetLoop).toHaveBeenCalledWith(
      '0xtoken', 'PEPE',
      expect.objectContaining({ strategyType: 'threshold', dropPct: 2.0 }),
    );
  });

  it('POST /api/assets/:address/dismiss - calls engine.stopAssetLoop, returns 200', async () => {
    const { discoveredAssetQueries } = await import('../src/data/db.js') as any;
    const mockRow: DiscoveredAssetRow = {
      address: '0xtoken', network: 'base-sepolia', symbol: 'PEPE',
      name: 'Pepe Token', decimals: 18, status: 'active',
      drop_pct: 2.0, rise_pct: 3.0, sma_short: 5, sma_long: 20,
      strategy: 'threshold', discovered_at: '2025-01-01T00:00:00',
    };
    discoveredAssetQueries.getAssetByAddress.get.mockReturnValue(mockRow);
    discoveredAssetQueries.getDiscoveredAssets.all.mockReturnValue([]);

    const res = await req(capturedApp!, 'POST', '/api/assets/0xtoken/dismiss', {});

    expect(res.status).toBe(200);
    expect((res.body as any).ok).toBe(true);
    expect(engine.stopAssetLoop).toHaveBeenCalledWith('PEPE');
  });

  it('PUT /api/assets/:address/config - calls engine.reloadAssetConfig, returns 200', async () => {
    const { discoveredAssetQueries } = await import('../src/data/db.js') as any;
    const mockRow: DiscoveredAssetRow = {
      address: '0xtoken', network: 'base-sepolia', symbol: 'PEPE',
      name: 'Pepe Token', decimals: 18, status: 'active',
      drop_pct: 2.0, rise_pct: 3.0, sma_short: 5, sma_long: 20,
      strategy: 'threshold', discovered_at: '2025-01-01T00:00:00',
    };
    discoveredAssetQueries.getAssetByAddress.get.mockReturnValue(mockRow);

    const res = await req(capturedApp!, 'PUT', '/api/assets/0xtoken/config', {
      strategyType: 'sma', dropPct: 1.5, risePct: 2.5, smaShort: 5, smaLong: 20,
    });

    expect(res.status).toBe(200);
    expect((res.body as any).ok).toBe(true);
    expect(engine.reloadAssetConfig).toHaveBeenCalledWith(
      '0xtoken', 'PEPE',
      expect.objectContaining({ strategyType: 'sma' }),
    );
  });
});
