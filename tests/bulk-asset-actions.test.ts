/**
 * Tests for bulk-enable and bulk-dismiss asset endpoints.
 *
 * Strategy: mock express to capture the app when startWebServer creates it,
 * then test routes directly via Node's http module.
 */
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
  // Forward all named exports (Router, json, static, etc.) so auth.ts can use them
  return { ...actual, default: factory };
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
    getAssetBySymbol: { get: vi.fn() },
    getDiscoveredAssets: { all: mockGetDiscoveredAssets },
    getActiveAssets: { all: vi.fn(() => []) },
    updateAssetStatus: { run: mockUpdateAssetStatus },
    updateAssetStrategyConfig: { run: vi.fn() },
    updateGridConfig: { run: vi.fn() },
    dismissAsset: { run: mockDismissAsset },
    upsertDiscoveredAsset: { run: vi.fn() },
  },
  passkeyQueries: {
    getPasskey: { get: vi.fn() },
    upsertPasskey: { run: vi.fn() },
  },
  portfolioSnapshotQueries: {
    recentPortfolioSnapshots: { all: vi.fn(() => []) },
  },
  rotationQueries: {
    recentRotations: { all: vi.fn(() => []) },
  },
  dailyPnlQueries: {
    getDailyPnl: { all: vi.fn(() => []) },
  },
  watchlistQueries: {
    getWatchlist: { all: vi.fn(() => []) },
  },
  gridStateQueries: {
    getGridState: { get: vi.fn() },
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
  config: {
    WEB_PORT: 3099,
    DATA_DIR: '/tmp/test',
    NETWORK_ID: 'base-sepolia',
    SESSION_SECRET: 'test-secret-32-chars-long-enough!!',
    DASHBOARD_SECRET: undefined,
    ALLOWED_IPS: '',
    WEBAUTHN_RP_ID: undefined,
    WEBAUTHN_RP_NAME: undefined,
    WEBAUTHN_ORIGIN: undefined,
  },
  availableNetworks: ['base-sepolia', 'base-mainnet'],
}));

vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/web/auth.js', () => ({
  createAuthMiddleware: () => (_req: any, _res: any, next: any) => next(),
  createSessionMiddleware: () => (_req: any, _res: any, next: any) => next(),
  isIpAllowed: () => true,
  requireAuth: () => (_req: any, _res: any, next: any) => next(),
  registerAuthRoutes: () => {},
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

function makeMockEngine() {
  return {
    start: vi.fn(), stop: vi.fn(),
    startAssetLoop: vi.fn(), stopAssetLoop: vi.fn(),
    reloadAssetConfig: vi.fn(),
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

// ── HTTP helper ──────────────────────────────────────────────────────────────
function request(server: http.Server, method: string, path: string, body?: unknown) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const payload = body != null ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path, method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
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
  let engine: ReturnType<typeof makeMockEngine>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetDiscoveredAssets.mockReturnValue([mkPending()]);
    capturedApp = null;
    engine = makeMockEngine();

    const { startWebServer } = await import('../src/web/server.js');
    startWebServer({} as any, makeMockRuntimeConfig() as any, {} as any, engine as any);

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
    expect(mockDismissAsset).toHaveBeenCalledWith('0xaaa', 'base-sepolia');
  });

  it('skips non-pending assets', async () => {
    const res = await request(server, 'POST', '/api/assets/bulk-dismiss', { addresses: ['0xunknown'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, succeeded: 0, skipped: 1 });
    expect(mockDismissAsset).not.toHaveBeenCalled();
  });

  it('returns 400 for empty addresses array', async () => {
    const res = await request(server, 'POST', '/api/assets/bulk-dismiss', { addresses: [] });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/assets/bulk-enable', () => {
  let server: http.Server;
  let engine: ReturnType<typeof makeMockEngine>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetDiscoveredAssets.mockReturnValue([mkPending()]);
    capturedApp = null;
    engine = makeMockEngine();

    const { startWebServer } = await import('../src/web/server.js');
    startWebServer({} as any, makeMockRuntimeConfig() as any, {} as any, engine as any);

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
    expect(mockUpdateAssetStatus).toHaveBeenCalledWith({ status: 'active', address: '0xaaa', network: 'base-sepolia' });
  });

  it('skips non-pending assets', async () => {
    const res = await request(server, 'POST', '/api/assets/bulk-enable', { addresses: ['0xunknown'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, succeeded: 0, skipped: 1 });
    expect(mockUpdateAssetStatus).not.toHaveBeenCalled();
  });

  it('returns 400 for empty addresses array', async () => {
    const res = await request(server, 'POST', '/api/assets/bulk-enable', { addresses: [] });
    expect(res.status).toBe(400);
  });
});
