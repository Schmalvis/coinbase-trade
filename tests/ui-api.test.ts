/**
 * Comprehensive UI/API endpoint test suite.
 *
 * Tests every API endpoint's response shape and key behaviors to ensure
 * the dashboard receives correct data for a real-money trading bot.
 *
 * Strategy: mock express to capture the app, then use supertest for requests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DiscoveredAssetRow } from '../src/data/db.js';
import http from 'http';
import type { AddressInfo } from 'net';

// ── Captured express app ──────────────────────────────────────────────────────
let capturedApp: import('express').Application | null = null;

// ── Mock express to capture the app and suppress listen ───────────────────────
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

// ── Mock data fixtures ────────────────────────────────────────────────────────
const mkRow = (overrides?: Partial<DiscoveredAssetRow>): DiscoveredAssetRow => ({
  address: '0xeth',
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
  grid_levels: 10,
  grid_upper_bound: null,
  grid_lower_bound: null,
  grid_manual_override: 0,
  grid_amount_pct: 5.0,
  ...overrides,
});

const ethRow = mkRow();
const usdcRow = mkRow({ address: '0xusdc', symbol: 'USDC', name: 'USD Coin', strategy: 'threshold' });
const cbbtcRow = mkRow({ address: '0xcbbtc', symbol: 'CBBTC', name: 'Coinbase BTC', strategy: 'sma' });
const dismissedRow = mkRow({ address: '0xdismissed', symbol: 'DEAD', name: 'Dead Token', status: 'dismissed' });
const dupRow = mkRow({ address: '0xeth-dup', symbol: 'ETH', name: 'Ethereum Dup' });

// ── Mock DB ───────────────────────────────────────────────────────────────────
const mockDiscoveredAssetQueries = {
  getAssetByAddress: { get: vi.fn() },
  getDiscoveredAssets: { all: vi.fn(() => [ethRow, usdcRow, cbbtcRow, dismissedRow, dupRow]) },
  getActiveAssets: { all: vi.fn(() => [ethRow, cbbtcRow]) },
  updateAssetStatus: { run: vi.fn() },
  updateAssetStrategyConfig: { run: vi.fn() },
  updateGridConfig: { run: vi.fn() },
  dismissAsset: { run: vi.fn() },
  upsertDiscoveredAsset: { run: vi.fn() },
};

const mockQueries = {
  recentAssetSnapshots: { all: vi.fn((_sym: string, _limit: number) => []) },
  recentSnapshots: { all: vi.fn(() => []) },
  recentTrades: { all: vi.fn(() => []) },
  recentPortfolioSnapshots: { all: vi.fn(() => [{ portfolio_usd: 1500.0 }]) },
  insertEvent: { run: vi.fn() },
};

const mockSettingQueries = {
  getSetting: { get: vi.fn() },
  upsertSetting: { run: vi.fn() },
  getAllSettings: { all: vi.fn(() => []) },
};

const mockCandleQueries = {
  getCandles: { all: vi.fn(() => []) },
};

const mockRotationQueries = {
  getRecentRotations: { all: vi.fn(() => []) },
  getTodayRotationCount: { get: vi.fn(() => ({ cnt: 2 })) },
};

const mockDailyPnlQueries = {
  getTodayPnl: { get: vi.fn(() => ({ high_water: 1600, current_usd: 1500, rotations: 3, realized_pnl: -50 })) },
  getRecentDailyPnl: { all: vi.fn(() => [
    { date: '2026-03-20', high_water: 1600, current_usd: 1500, rotations: 3, realized_pnl: -50 },
    { date: '2026-03-19', high_water: 1550, current_usd: 1520, rotations: 1, realized_pnl: 10 },
  ]) },
};

const mockPortfolioSnapshotQueries = {
  getRecentSnapshots: { all: vi.fn(() => [
    { timestamp: '2026-03-20T10:00:00', portfolio_usd: 1500 },
    { timestamp: '2026-03-20T09:00:00', portfolio_usd: 1480 },
  ]) },
};

vi.mock('../src/data/db.js', () => ({
  db: {},
  queries: mockQueries,
  discoveredAssetQueries: mockDiscoveredAssetQueries,
  settingQueries: mockSettingQueries,
  candleQueries: mockCandleQueries,
  rotationQueries: mockRotationQueries,
  dailyPnlQueries: mockDailyPnlQueries,
  portfolioSnapshotQueries: mockPortfolioSnapshotQueries,
}));

vi.mock('../src/config.js', () => ({
  config: { WEB_PORT: 0, DATA_DIR: '/tmp/test', DASHBOARD_SECRET: '' },
  availableNetworks: ['base-sepolia', 'base-mainnet'],
}));

vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/assets/registry.js', () => ({
  assetsForNetwork: vi.fn(() => [
    {
      symbol: 'ETH', name: 'Ethereum', isNative: true, tradeMethod: 'agentkit', priceSource: 'coinbase',
      addresses: { 'base-sepolia': '0xeth-registry', 'base-mainnet': '0xeth-mainnet' },
    },
    {
      symbol: 'USDC', name: 'USD Coin', isNative: false, tradeMethod: 'agentkit', priceSource: 'coinbase',
      addresses: { 'base-sepolia': '0xusdc-registry', 'base-mainnet': '0xusdc-mainnet' },
    },
    {
      symbol: 'CBBTC', name: 'Coinbase BTC', isNative: false, tradeMethod: 'agentkit', priceSource: 'coinbase',
      addresses: { 'base-sepolia': '0xcbbtc-registry', 'base-mainnet': '0xcbbtc-mainnet' },
    },
  ]),
}));

vi.mock('../src/web/auth.js', () => ({
  createAuthMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));

// ── Mock botState ─────────────────────────────────────────────────────────────
const mockBotState = {
  status: 'running' as const,
  lastPrice: 3200.5,
  lastBalance: 1.5,
  lastUsdcBalance: 500,
  lastTradeAt: new Date('2026-03-20T08:00:00Z'),
  activeNetwork: 'base-sepolia',
  availableNetworks: ['base-sepolia', 'base-mainnet'],
  assetBalances: new Map<string, number>([['ETH', 1.5], ['USDC', 500], ['CBBTC', 0.01]]),
  pendingTokenCount: 2,
  walletAddress: '0x9123528571C6aD8fe80eb0cC82f6a388311A3104',
  mcpHealthy: true,
  isPaused: false,
  setStatus: vi.fn(),
  setPendingTokenCount: vi.fn(),
  setWalletAddress: vi.fn(),
  setNetwork: vi.fn(),
};

vi.mock('../src/core/state.js', () => ({
  botState: mockBotState,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

type MockEngine = {
  startAssetLoop: ReturnType<typeof vi.fn>;
  stopAssetLoop: ReturnType<typeof vi.fn>;
  reloadAssetConfig: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  tick: ReturnType<typeof vi.fn>;
  optimizerEnabled: boolean;
  enableOptimizer: ReturnType<typeof vi.fn>;
  disableOptimizer: ReturnType<typeof vi.fn>;
};

function makeMockEngine(optimizerEnabled = false): MockEngine {
  return {
    startAssetLoop: vi.fn(),
    stopAssetLoop: vi.fn(),
    reloadAssetConfig: vi.fn(),
    start: vi.fn(),
    tick: vi.fn(),
    optimizerEnabled,
    enableOptimizer: vi.fn(),
    disableOptimizer: vi.fn(),
  };
}

function makeMockRuntimeConfig() {
  const vals: Record<string, unknown> = {
    STRATEGY: 'threshold', DRY_RUN: false,
    PRICE_DROP_THRESHOLD_PCT: 2, PRICE_RISE_TARGET_PCT: 3,
    SMA_SHORT_WINDOW: 5, SMA_LONG_WINDOW: 20,
    MAX_DAILY_LOSS_PCT: 5, MAX_DAILY_ROTATIONS: 10,
    MAX_POSITION_PCT: 40, PORTFOLIO_FLOOR_USD: 100,
    DASHBOARD_THEME: 'dark',
  };
  return {
    get: vi.fn((k: string) => vals[k] ?? null),
    getAll: vi.fn(() => ({ ...vals })),
    set: vi.fn(),
    setBatch: vi.fn(),
    subscribeMany: vi.fn(),
  };
}

function makeMockOptimizer(isRiskOff = false) {
  return {
    isRiskOff,
    getLatestScores: vi.fn(() => [
      { symbol: 'ETH', score: 45, signals: {} },
      { symbol: 'CBBTC', score: -15, signals: {} },
    ]),
  };
}

function makeMockExecutor() {
  return {
    executeManual: vi.fn(async () => ({ txHash: '0xabc', status: 'executed' })),
    executeEnso: vi.fn(async () => ({ txHash: '0xdef', status: 'executed' })),
  };
}

function makeMockWatchlistManager() {
  return {
    getAll: vi.fn(() => [{ symbol: 'DOGE', network: 'base-sepolia', status: 'watching' }]),
    add: vi.fn(),
    remove: vi.fn(),
  };
}

/** Issue an HTTP request against a captured express app on a temp port */
async function req(
  app: import('express').Application,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
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

// ── Test suite ────────────────────────────────────────────────────────────────

describe('UI/API endpoint tests', () => {
  let engine: MockEngine;
  let runtimeConfig: ReturnType<typeof makeMockRuntimeConfig>;
  let optimizer: ReturnType<typeof makeMockOptimizer>;
  let executor: ReturnType<typeof makeMockExecutor>;
  let watchlistManager: ReturnType<typeof makeMockWatchlistManager>;

  beforeEach(async () => {
    capturedApp = null;
    engine = makeMockEngine(true);
    runtimeConfig = makeMockRuntimeConfig();
    optimizer = makeMockOptimizer();
    executor = makeMockExecutor();
    watchlistManager = makeMockWatchlistManager();

    // Reset mock returns to defaults
    mockQueries.recentPortfolioSnapshots.all.mockReturnValue([{ portfolio_usd: 1500.0 }]);
    mockQueries.recentAssetSnapshots.all.mockReturnValue([]);
    mockDiscoveredAssetQueries.getDiscoveredAssets.all.mockReturnValue([ethRow, usdcRow, cbbtcRow, dismissedRow, dupRow]);
    mockDiscoveredAssetQueries.getAssetByAddress.get.mockReturnValue(undefined);
    mockDiscoveredAssetQueries.getActiveAssets.all.mockReturnValue([ethRow, cbbtcRow]);

    const { startWebServer } = await import('../src/web/server.js');
    startWebServer(
      {} as any,
      runtimeConfig as any,
      executor as any,
      engine as any,
      optimizer as any,
      watchlistManager as any,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 1. GET /api/status — response shape & data sources
  // ══════════════════════════════════════════════════════════════════════════════

  describe('GET /api/status', () => {
    it('returns all required fields for the dashboard', async () => {
      const res = await req(capturedApp!, 'GET', '/api/status');
      expect(res.status).toBe(200);
      const b = res.body;

      // Every field the dashboard JS reads must be present
      expect(b).toHaveProperty('status');
      expect(b).toHaveProperty('lastPrice');
      expect(b).toHaveProperty('ethBalance');
      expect(b).toHaveProperty('usdcBalance');
      expect(b).toHaveProperty('portfolioUsd');
      expect(b).toHaveProperty('lastTradeAt');
      expect(b).toHaveProperty('dryRun');
      expect(b).toHaveProperty('strategy');
      expect(b).toHaveProperty('activeNetwork');
      expect(b).toHaveProperty('availableNetworks');
      expect(b).toHaveProperty('assetBalances');
      expect(b).toHaveProperty('pendingTokenCount');
      expect(b).toHaveProperty('walletAddress');
      expect(b).toHaveProperty('mcpHealthy');
      expect(b).toHaveProperty('optimizerEnabled');
      expect(b).toHaveProperty('optimizerMode');
    });

    it('portfolioUsd comes from DB portfolio_snapshots (not botState)', async () => {
      mockQueries.recentPortfolioSnapshots.all.mockReturnValue([{ portfolio_usd: 9999 }]);
      const res = await req(capturedApp!, 'GET', '/api/status');
      expect(res.body.portfolioUsd).toBe(9999);
    });

    it('ethBalance and usdcBalance come from DB asset_snapshots when available', async () => {
      mockQueries.recentAssetSnapshots.all.mockImplementation((sym: string) => {
        if (sym === 'ETH') return [{ balance: 2.5, price_usd: 3100 }];
        if (sym === 'USDC') return [{ balance: 750, price_usd: 1.0 }];
        return [];
      });
      const res = await req(capturedApp!, 'GET', '/api/status');
      expect(res.body.ethBalance).toBe(2.5);
      expect(res.body.usdcBalance).toBe(750);
    });

    it('falls back to botState when DB snapshots are empty', async () => {
      mockQueries.recentAssetSnapshots.all.mockReturnValue([]);
      const res = await req(capturedApp!, 'GET', '/api/status');
      // Falls back to botState.lastBalance / lastUsdcBalance
      expect(res.body.ethBalance).toBe(1.5);
      expect(res.body.usdcBalance).toBe(500);
    });

    it('optimizerMode reflects optimizer.isRiskOff', async () => {
      const res = await req(capturedApp!, 'GET', '/api/status');
      expect(res.body.optimizerMode).toBe('normal');
    });

    it('field types are correct', async () => {
      const res = await req(capturedApp!, 'GET', '/api/status');
      const b = res.body;
      expect(typeof b.status).toBe('string');
      expect(typeof b.lastPrice).toBe('number');
      expect(typeof b.ethBalance).toBe('number');
      expect(typeof b.usdcBalance).toBe('number');
      expect(typeof b.portfolioUsd).toBe('number');
      expect(typeof b.dryRun).toBe('boolean');
      expect(typeof b.strategy).toBe('string');
      expect(typeof b.activeNetwork).toBe('string');
      expect(Array.isArray(b.availableNetworks)).toBe(true);
      expect(typeof b.assetBalances).toBe('object');
      expect(typeof b.pendingTokenCount).toBe('number');
      expect(typeof b.mcpHealthy).toBe('boolean');
      expect(typeof b.optimizerEnabled).toBe('boolean');
      expect(typeof b.optimizerMode).toBe('string');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 2. GET /api/assets — deduplication, filtering, shape
  // ══════════════════════════════════════════════════════════════════════════════

  describe('GET /api/assets', () => {
    it('returns array with correct asset shape', async () => {
      const res = await req(capturedApp!, 'GET', '/api/assets');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const asset = res.body[0];
      expect(asset).toHaveProperty('symbol');
      expect(asset).toHaveProperty('name');
      expect(asset).toHaveProperty('address');
      expect(asset).toHaveProperty('decimals');
      expect(asset).toHaveProperty('balance');
      expect(asset).toHaveProperty('price');
      expect(asset).toHaveProperty('change24h');
      expect(asset).toHaveProperty('status');
      expect(asset).toHaveProperty('source');
      expect(asset).toHaveProperty('strategyConfig');
    });

    it('strategyConfig includes all required fields including grid', async () => {
      const res = await req(capturedApp!, 'GET', '/api/assets');
      const asset = res.body[0];
      const sc = asset.strategyConfig;
      expect(sc).toHaveProperty('type');
      expect(sc).toHaveProperty('dropPct');
      expect(sc).toHaveProperty('risePct');
      expect(sc).toHaveProperty('smaShort');
      expect(sc).toHaveProperty('smaLong');
      expect(sc).toHaveProperty('gridLevels');
      expect(sc).toHaveProperty('gridUpperBound');
      expect(sc).toHaveProperty('gridLowerBound');
    });

    it('filters out dismissed assets', async () => {
      const res = await req(capturedApp!, 'GET', '/api/assets');
      const symbols = res.body.map((a: any) => a.symbol);
      expect(symbols).not.toContain('DEAD');
    });

    it('deduplicates by symbol — first occurrence wins', async () => {
      const res = await req(capturedApp!, 'GET', '/api/assets');
      const ethAssets = res.body.filter((a: any) => a.symbol === 'ETH');
      expect(ethAssets).toHaveLength(1);
      expect(ethAssets[0].address).toBe('0xeth'); // first occurrence
    });

    it('USDC price is always 1.0', async () => {
      const res = await req(capturedApp!, 'GET', '/api/assets');
      const usdc = res.body.find((a: any) => a.symbol === 'USDC');
      expect(usdc.price).toBe(1.0);
    });

    it('ETH price uses botState.lastPrice', async () => {
      const res = await req(capturedApp!, 'GET', '/api/assets');
      const eth = res.body.find((a: any) => a.symbol === 'ETH');
      expect(eth.price).toBe(3200.5);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 3. PUT /api/assets/:address/config — strategy persistence
  // ══════════════════════════════════════════════════════════════════════════════

  describe('PUT /api/assets/:address/config', () => {
    it('returns 404 for unknown asset', async () => {
      mockDiscoveredAssetQueries.getAssetByAddress.get.mockReturnValue(undefined);
      mockDiscoveredAssetQueries.getActiveAssets.all.mockReturnValue([]);
      const res = await req(capturedApp!, 'PUT', '/api/assets/0xunknown/config', {
        strategyType: 'threshold', dropPct: 2, risePct: 3, smaShort: 5, smaLong: 20,
      });
      expect(res.status).toBe(404);
    });

    it('validates strategyType must be threshold/sma/grid', async () => {
      mockDiscoveredAssetQueries.getAssetByAddress.get.mockReturnValue(ethRow);
      const res = await req(capturedApp!, 'PUT', '/api/assets/0xeth/config', {
        strategyType: 'invalid', dropPct: 2, risePct: 3, smaShort: 5, smaLong: 20,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/strategyType/);
    });

    it('persists strategy config and reloads asset loop on success', async () => {
      mockDiscoveredAssetQueries.getAssetByAddress.get.mockReturnValue(ethRow);
      const res = await req(capturedApp!, 'PUT', '/api/assets/0xeth/config', {
        strategyType: 'sma', dropPct: 1.5, risePct: 2.5, smaShort: 7, smaLong: 25,
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(mockDiscoveredAssetQueries.updateAssetStrategyConfig.run).toHaveBeenCalled();
      expect(engine.reloadAssetConfig).toHaveBeenCalledWith(
        '0xeth', 'ETH',
        expect.objectContaining({ strategyType: 'sma' }),
      );
    });

    it('saves grid config when strategy is grid', async () => {
      mockDiscoveredAssetQueries.getAssetByAddress.get.mockReturnValue(ethRow);
      const res = await req(capturedApp!, 'PUT', '/api/assets/0xeth/config', {
        strategyType: 'grid', dropPct: 2, risePct: 3, smaShort: 5, smaLong: 20,
        grid_levels: 15, grid_upper_bound: 4000, grid_lower_bound: 2800,
      });
      expect(res.status).toBe(200);
      expect(mockDiscoveredAssetQueries.updateGridConfig.run).toHaveBeenCalledWith(
        expect.objectContaining({
          grid_levels: 15,
          grid_upper_bound: 4000,
          grid_lower_bound: 2800,
          grid_manual_override: 1,
        }),
      );
    });

    it('uses case-insensitive address lookup with symbol fallback', async () => {
      mockDiscoveredAssetQueries.getAssetByAddress.get.mockReturnValue(undefined);
      mockDiscoveredAssetQueries.getActiveAssets.all.mockReturnValue([ethRow]);
      const res = await req(capturedApp!, 'PUT', '/api/assets/eth/config', {
        strategyType: 'threshold', dropPct: 2, risePct: 3, smaShort: 5, smaLong: 20,
      });
      expect(res.status).toBe(200);
      expect(engine.reloadAssetConfig).toHaveBeenCalledWith('0xeth', 'ETH', expect.anything());
    });

    it('rejects dropPct below 0.1', async () => {
      mockDiscoveredAssetQueries.getAssetByAddress.get.mockReturnValue(ethRow);
      const res = await req(capturedApp!, 'PUT', '/api/assets/0xeth/config', {
        strategyType: 'threshold', dropPct: 0.05, risePct: 3, smaShort: 5, smaLong: 20,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/dropPct/);
    });

    it('rejects smaShort below 2', async () => {
      mockDiscoveredAssetQueries.getAssetByAddress.get.mockReturnValue(ethRow);
      const res = await req(capturedApp!, 'PUT', '/api/assets/0xeth/config', {
        strategyType: 'sma', dropPct: 2, risePct: 3, smaShort: 1, smaLong: 20,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/smaShort/);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 4. GET /api/risk — snake_case fields
  // ══════════════════════════════════════════════════════════════════════════════

  describe('GET /api/risk', () => {
    it('returns snake_case fields (not camelCase)', async () => {
      const res = await req(capturedApp!, 'GET', '/api/risk');
      expect(res.status).toBe(200);
      const b = res.body;

      // Must be snake_case
      expect(b).toHaveProperty('daily_pnl');
      expect(b).toHaveProperty('daily_pnl_limit');
      expect(b).toHaveProperty('rotations_today');
      expect(b).toHaveProperty('max_daily_rotations');
      expect(b).toHaveProperty('max_position_pct');
      expect(b).toHaveProperty('portfolio_floor');
      expect(b).toHaveProperty('portfolio_usd');
      expect(b).toHaveProperty('optimizer_status');
      expect(b).toHaveProperty('has_data');

      // Must NOT be camelCase
      expect(b).not.toHaveProperty('dailyPnl');
      expect(b).not.toHaveProperty('dailyPnlLimit');
      expect(b).not.toHaveProperty('rotationsToday');
      expect(b).not.toHaveProperty('maxDailyRotations');
    });

    it('optimizer_status reflects engine/optimizer state', async () => {
      const res = await req(capturedApp!, 'GET', '/api/risk');
      // engine.optimizerEnabled=true, optimizer.isRiskOff=false -> 'active'
      expect(res.body.optimizer_status).toBe('active');
    });

    it('optimizer_status is "disabled" when engine optimizer is off', async () => {
      // Rebuild with optimizer disabled
      capturedApp = null;
      const disabledEngine = makeMockEngine(false);
      const { startWebServer } = await import('../src/web/server.js');
      startWebServer(
        {} as any, runtimeConfig as any, executor as any,
        disabledEngine as any, optimizer as any, watchlistManager as any,
      );
      const res = await req(capturedApp!, 'GET', '/api/risk');
      expect(res.body.optimizer_status).toBe('disabled');
    });

    it('optimizer_status is "risk-off" when optimizer reports risk-off', async () => {
      capturedApp = null;
      const riskOffOptimizer = makeMockOptimizer(true);
      const { startWebServer } = await import('../src/web/server.js');
      startWebServer(
        {} as any, runtimeConfig as any, executor as any,
        engine as any, riskOffOptimizer as any, watchlistManager as any,
      );
      const res = await req(capturedApp!, 'GET', '/api/risk');
      expect(res.body.optimizer_status).toBe('risk-off');
    });

    it('has_data is true when todayPnl exists', async () => {
      const res = await req(capturedApp!, 'GET', '/api/risk');
      expect(res.body.has_data).toBe(true);
    });

    it('has_data is false when no PnL data', async () => {
      mockDailyPnlQueries.getTodayPnl.get.mockReturnValue(undefined);
      const res = await req(capturedApp!, 'GET', '/api/risk');
      expect(res.body.has_data).toBe(false);
    });

    it('field types are correct', async () => {
      mockDailyPnlQueries.getTodayPnl.get.mockReturnValue({ high_water: 1600, current_usd: 1500, rotations: 3 });
      const res = await req(capturedApp!, 'GET', '/api/risk');
      const b = res.body;
      expect(typeof b.daily_pnl).toBe('number');
      expect(typeof b.daily_pnl_limit).toBe('number');
      expect(typeof b.rotations_today).toBe('number');
      expect(typeof b.max_daily_rotations).toBe('number');
      expect(typeof b.max_position_pct).toBe('number');
      expect(typeof b.portfolio_floor).toBe('number');
      expect(typeof b.portfolio_usd).toBe('number');
      expect(typeof b.optimizer_status).toBe('string');
      expect(typeof b.has_data).toBe('boolean');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 5. GET /api/scores — returns [] when optimizer not provided
  // ══════════════════════════════════════════════════════════════════════════════

  describe('GET /api/scores', () => {
    it('returns scores array when optimizer is present', async () => {
      const res = await req(capturedApp!, 'GET', '/api/scores');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);
      expect(res.body[0]).toHaveProperty('symbol');
      expect(res.body[0]).toHaveProperty('score');
    });

    it('returns empty array when optimizer is not provided', async () => {
      capturedApp = null;
      const { startWebServer } = await import('../src/web/server.js');
      startWebServer(
        {} as any, runtimeConfig as any, executor as any,
        engine as any, undefined, // no optimizer
      );
      const res = await req(capturedApp!, 'GET', '/api/scores');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 6. GET /api/performance — P&L metrics with portfolio_history
  // ══════════════════════════════════════════════════════════════════════════════

  describe('GET /api/performance', () => {
    it('returns P&L metrics with correct shape', async () => {
      const res = await req(capturedApp!, 'GET', '/api/performance');
      expect(res.status).toBe(200);
      const b = res.body;

      expect(b).toHaveProperty('current_usd');
      expect(b).toHaveProperty('today');
      expect(b.today).toHaveProperty('change');
      expect(b.today).toHaveProperty('change_pct');
      expect(b.today).toHaveProperty('rotations');
      expect(b).toHaveProperty('week');
      expect(b.week).toHaveProperty('change');
      expect(b.week).toHaveProperty('change_pct');
      expect(b).toHaveProperty('month');
      expect(b.month).toHaveProperty('change');
      expect(b.month).toHaveProperty('change_pct');
      expect(b).toHaveProperty('total');
      expect(b.total).toHaveProperty('change');
      expect(b.total).toHaveProperty('change_pct');
      expect(b.total).toHaveProperty('since');
      expect(b).toHaveProperty('rotations');
      expect(b.rotations).toHaveProperty('total');
      expect(b.rotations).toHaveProperty('recent_profitable');
      expect(b.rotations).toHaveProperty('recent_total');
      expect(b).toHaveProperty('portfolio_history');
      expect(Array.isArray(b.portfolio_history)).toBe(true);
      expect(b).toHaveProperty('daily_pnl');
      expect(Array.isArray(b.daily_pnl)).toBe(true);
    });

    it('portfolio_history entries have timestamp and portfolio_usd', async () => {
      const res = await req(capturedApp!, 'GET', '/api/performance');
      if (res.body.portfolio_history.length > 0) {
        const entry = res.body.portfolio_history[0];
        expect(entry).toHaveProperty('timestamp');
        expect(entry).toHaveProperty('portfolio_usd');
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 7. POST /api/settings — READ_ONLY_KEYS rejection
  // ══════════════════════════════════════════════════════════════════════════════

  describe('POST /api/settings', () => {
    it('accepts valid settings changes', async () => {
      const res = await req(capturedApp!, 'POST', '/api/settings', {
        changes: { STRATEGY: 'sma' },
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(runtimeConfig.setBatch).toHaveBeenCalledWith({ STRATEGY: 'sma' });
    });

    it('rejects DRY_RUN (read-only key)', async () => {
      runtimeConfig.setBatch.mockImplementation(() => {
        throw new Error('DRY_RUN is read-only');
      });
      const res = await req(capturedApp!, 'POST', '/api/settings', {
        changes: { DRY_RUN: true },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/DRY_RUN/);
    });

    it('rejects DASHBOARD_SECRET (read-only key)', async () => {
      runtimeConfig.setBatch.mockImplementation(() => {
        throw new Error('DASHBOARD_SECRET is read-only');
      });
      const res = await req(capturedApp!, 'POST', '/api/settings', {
        changes: { DASHBOARD_SECRET: 'new-secret' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/DASHBOARD_SECRET/);
    });

    it('returns 400 for missing changes object', async () => {
      const res = await req(capturedApp!, 'POST', '/api/settings', {});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/changes/i);
    });

    it('returns error field name on validation failure', async () => {
      runtimeConfig.setBatch.mockImplementation(() => {
        throw new Error('STRATEGY: must be "threshold", "sma", or "grid"');
      });
      const res = await req(capturedApp!, 'POST', '/api/settings', {
        changes: { STRATEGY: 'invalid' },
      });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('field');
      expect(res.body.field).toBe('STRATEGY');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 8. POST /api/trade/enso — C2 allowlist enforcement
  // ══════════════════════════════════════════════════════════════════════════════

  describe('POST /api/trade/enso', () => {
    it('rejects when not on base-mainnet', async () => {
      // mockBotState.activeNetwork is 'base-sepolia'
      const res = await req(capturedApp!, 'POST', '/api/trade/enso', {
        tokenIn: '0xaaa', tokenOut: '0xbbb', amountIn: '100',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/mainnet/i);
    });

    it('rejects non-allowlisted tokens on mainnet', async () => {
      // Temporarily switch to mainnet
      const originalNetwork = mockBotState.activeNetwork;
      mockBotState.activeNetwork = 'base-mainnet';
      mockDiscoveredAssetQueries.getActiveAssets.all.mockReturnValue([]);

      const res = await req(capturedApp!, 'POST', '/api/trade/enso', {
        tokenIn: '0xrandom-not-in-list', tokenOut: '0xanother-random', amountIn: '100',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/allowlist/i);

      mockBotState.activeNetwork = originalNetwork;
    });

    it('allows trade when tokenIn is in registry', async () => {
      const originalNetwork = mockBotState.activeNetwork;
      mockBotState.activeNetwork = 'base-mainnet';
      mockDiscoveredAssetQueries.getActiveAssets.all.mockReturnValue([]);

      const res = await req(capturedApp!, 'POST', '/api/trade/enso', {
        tokenIn: '0xeth-mainnet', tokenOut: '0xrandom', amountIn: '100',
      });
      // Should not be rejected by allowlist (may succeed or fail for other reasons)
      expect(res.status).not.toBe(400);

      mockBotState.activeNetwork = originalNetwork;
    });

    it('allows trade when tokenOut is a discovered active asset', async () => {
      const originalNetwork = mockBotState.activeNetwork;
      mockBotState.activeNetwork = 'base-mainnet';
      const activeRow = mkRow({ address: '0xactive-token', symbol: 'ACTIVE', status: 'active', network: 'base-mainnet' });
      mockDiscoveredAssetQueries.getActiveAssets.all.mockReturnValue([activeRow]);

      const res = await req(capturedApp!, 'POST', '/api/trade/enso', {
        tokenIn: '0xrandom', tokenOut: '0xactive-token', amountIn: '100',
      });
      expect(res.status).not.toBe(400);

      mockBotState.activeNetwork = originalNetwork;
    });

    it('rejects missing required fields', async () => {
      const res = await req(capturedApp!, 'POST', '/api/trade/enso', {
        tokenIn: '0xaaa',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/required/i);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 9. Dashboard data contract tests
  // ══════════════════════════════════════════════════════════════════════════════

  describe('Dashboard data contract', () => {
    it('status response has ALL fields the dashboard reads', async () => {
      const res = await req(capturedApp!, 'GET', '/api/status');
      const requiredFields = [
        'status', 'lastPrice', 'ethBalance', 'usdcBalance', 'portfolioUsd',
        'lastTradeAt', 'dryRun', 'strategy', 'activeNetwork', 'availableNetworks',
        'assetBalances', 'pendingTokenCount', 'walletAddress', 'mcpHealthy',
        'optimizerEnabled', 'optimizerMode',
      ];
      for (const field of requiredFields) {
        expect(res.body).toHaveProperty(field);
      }
    });

    it('risk response uses snake_case consistently', async () => {
      const res = await req(capturedApp!, 'GET', '/api/risk');
      const keys = Object.keys(res.body);
      // All keys should be snake_case (no uppercase letters unless part of a constant)
      for (const key of keys) {
        expect(key).not.toMatch(/[A-Z]/);
      }
    });

    it('assets response includes strategyConfig with grid fields for every asset', async () => {
      const res = await req(capturedApp!, 'GET', '/api/assets');
      for (const asset of res.body) {
        expect(asset.strategyConfig).toBeDefined();
        expect(asset.strategyConfig).toHaveProperty('type');
        expect(asset.strategyConfig).toHaveProperty('gridLevels');
        expect(asset.strategyConfig).toHaveProperty('gridUpperBound');
        expect(asset.strategyConfig).toHaveProperty('gridLowerBound');
      }
    });

    it('performance response matches dashboard expectations', async () => {
      const res = await req(capturedApp!, 'GET', '/api/performance');
      // Verify nested structure
      expect(res.body.today).toEqual(expect.objectContaining({
        change: expect.any(Number),
        change_pct: expect.any(Number),
      }));
      expect(res.body.week).toEqual(expect.objectContaining({
        change: expect.any(Number),
        change_pct: expect.any(Number),
      }));
      expect(res.body.month).toEqual(expect.objectContaining({
        change: expect.any(Number),
        change_pct: expect.any(Number),
      }));
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Additional endpoint coverage
  // ══════════════════════════════════════════════════════════════════════════════

  describe('GET /api/settings', () => {
    it('returns settings object', async () => {
      const res = await req(capturedApp!, 'GET', '/api/settings');
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
    });
  });

  describe('GET /api/networks', () => {
    it('returns active and available networks', async () => {
      const res = await req(capturedApp!, 'GET', '/api/networks');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('active');
      expect(res.body).toHaveProperty('available');
      expect(Array.isArray(res.body.available)).toBe(true);
    });
  });

  describe('POST /api/control/:action', () => {
    it('pause sets status to paused', async () => {
      const res = await req(capturedApp!, 'POST', '/api/control/pause', {});
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe('paused');
    });

    it('resume sets status to running', async () => {
      const res = await req(capturedApp!, 'POST', '/api/control/resume', {});
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe('running');
    });

    it('unknown action returns 400', async () => {
      const res = await req(capturedApp!, 'POST', '/api/control/invalid', {});
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/watchlist', () => {
    it('returns watchlist array', async () => {
      const res = await req(capturedApp!, 'GET', '/api/watchlist');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toHaveProperty('symbol');
    });

    it('returns empty array when no watchlistManager', async () => {
      capturedApp = null;
      const { startWebServer } = await import('../src/web/server.js');
      startWebServer(
        {} as any, runtimeConfig as any, executor as any,
        engine as any, optimizer as any, undefined,
      );
      const res = await req(capturedApp!, 'GET', '/api/watchlist');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('POST /api/optimizer/toggle', () => {
    it('enables optimizer', async () => {
      const res = await req(capturedApp!, 'POST', '/api/optimizer/toggle', { enabled: true });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(engine.enableOptimizer).toHaveBeenCalled();
    });

    it('disables optimizer', async () => {
      const res = await req(capturedApp!, 'POST', '/api/optimizer/toggle', { enabled: false });
      expect(res.status).toBe(200);
      expect(engine.disableOptimizer).toHaveBeenCalled();
    });
  });

  describe('GET /api/rotations', () => {
    it('returns array', async () => {
      const res = await req(capturedApp!, 'GET', '/api/rotations');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('GET /api/trades', () => {
    it('returns array', async () => {
      const res = await req(capturedApp!, 'GET', '/api/trades');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('POST /api/trade', () => {
    it('rejects missing required fields', async () => {
      const res = await req(capturedApp!, 'POST', '/api/trade', { from: 'ETH' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/required/i);
    });
  });

  describe('GET /api/theme', () => {
    it('returns theme', async () => {
      const res = await req(capturedApp!, 'GET', '/api/theme');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('theme');
    });
  });
});
