import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── vi.hoisted for all values referenced inside vi.mock factories ──
const {
  mockInsertRotation,
  mockUpdateRotation,
  mockGetTodayRotationCount,
  mockGetRecentRotations,
  mockUpsertDailyPnl,
  mockGetTodayPnl,
  mockGetActiveAssets,
  mockGetWatchlist,
  mockInsertEvent,
  mockRecentPortfolioSnaps,
  mockRecentAssetSnaps,
  mockTodayRealizedPnl,
  mockRunTransaction,
  mockEmitAlert,
} = vi.hoisted(() => ({
  mockInsertRotation:        { run: vi.fn().mockReturnValue({ lastInsertRowid: 42 }) },
  mockUpdateRotation:        { run: vi.fn() },
  mockGetTodayRotationCount: { get: vi.fn().mockReturnValue({ cnt: 0 }) },
  mockGetRecentRotations:    { all: vi.fn().mockReturnValue([]) },
  mockUpsertDailyPnl:        { run: vi.fn() },
  mockGetTodayPnl:           { get: vi.fn().mockReturnValue(null) },
  mockGetActiveAssets:       { all: vi.fn().mockReturnValue([]) },
  mockGetWatchlist:          { all: vi.fn().mockReturnValue([]) },
  mockInsertEvent:           { run: vi.fn() },
  mockRecentPortfolioSnaps:  { all: vi.fn().mockReturnValue([{ portfolio_usd: 500 }]) },
  mockRecentAssetSnaps:      { all: vi.fn().mockReturnValue([{ price_usd: 3000, balance: 0.5 }]) },
  mockTodayRealizedPnl:      { get: vi.fn().mockReturnValue(null) },
  mockRunTransaction:        vi.fn((fn: () => void) => fn()),
  mockEmitAlert:             vi.fn(),
}));

vi.mock('../src/data/db.js', () => ({
  queries: {
    insertEvent: mockInsertEvent,
    recentPortfolioSnapshots: mockRecentPortfolioSnaps,
    recentAssetSnapshots: mockRecentAssetSnaps,
    todayRealizedPnl: mockTodayRealizedPnl,
  },
  rotationQueries: {
    insertRotation: mockInsertRotation,
    getTodayRotationCount: mockGetTodayRotationCount,
    getRecentRotations: mockGetRecentRotations,
    updateRotation: mockUpdateRotation,
  },
  dailyPnlQueries: {
    upsertDailyPnl: mockUpsertDailyPnl,
    getTodayPnl: mockGetTodayPnl,
  },
  discoveredAssetQueries: {
    getActiveAssets: mockGetActiveAssets,
  },
  watchlistQueries: {
    getWatchlist: mockGetWatchlist,
  },
  runTransaction: mockRunTransaction,
}));

vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockAssetBalances = new Map<string, number>([
  ['ETH',  0.5],
  ['USDC', 200],
]);

vi.mock('../src/core/state.js', () => ({
  botState: {
    get assetBalances() { return mockAssetBalances; },
    get lastPrice() { return 3000; },
    emitAlert: mockEmitAlert,
  },
}));

vi.mock('../src/assets/registry.js', () => ({
  assetsForNetwork: vi.fn().mockReturnValue([]),
  ASSET_REGISTRY: [],
}));

vi.mock('../src/services/candles.js', () => ({
  CandleService: vi.fn().mockImplementation(() => ({
    getCandles: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../src/strategy/candle.js', () => ({
  CandleStrategy: vi.fn().mockImplementation(() => ({})),
}));


import { PortfolioOptimizer } from '../src/trading/optimizer.js';
import type { OpportunityScore } from '../src/trading/optimizer.js';

const HOLD_SIGNAL = { signal: 'hold' as const, strength: 0, reason: 'no data' };

function makeScore(symbol: string, score: number, isHeld = true): OpportunityScore {
  return {
    symbol,
    score,
    confidence: 0.8,
    signals: { candle15m: HOLD_SIGNAL, candle1h: HOLD_SIGNAL, candle24h: HOLD_SIGNAL },
    currentWeight: 30,
    isHeld,
  };
}

function makeOptimizer(executor: any) {
  const runtimeConfig = {
    get: (k: string) => ({
      DRY_RUN: false,
      MAX_POSITION_PCT: 40,
      MAX_DAILY_ROTATIONS: 10,
      PORTFOLIO_FLOOR_USD: 50,
      MIN_ROTATION_GAIN_PCT: 0,
      MAX_CASH_PCT: 80,
      // ETH score=-5 < 0  → sell candidate ✓
      // USDC score=10 > -10 → buy candidate ✓
      // delta = 10-(-5) = 15 > 10 = MIN_ROTATION_SCORE_DELTA ✓
      ROTATION_SELL_THRESHOLD: 0,
      ROTATION_BUY_THRESHOLD: -10,
      MIN_ROTATION_SCORE_DELTA: 10,
      RISK_OFF_THRESHOLD: -100,
      RISK_ON_THRESHOLD: 100,
      DEFAULT_FEE_ESTIMATE_PCT: 1.0,
      MAX_ROTATION_PCT: 25,
    } as Record<string, unknown>)[k],
  };

  const mockRiskGuard = {
    checkRotation: vi.fn().mockReturnValue({ approved: true, adjustedAmount: null }),
  };

  const mockCandleService = {
    getStoredCandles: vi.fn().mockReturnValue([]),
    getCandles: vi.fn().mockReturnValue([]),
  };

  return new PortfolioOptimizer(
    mockCandleService as any,
    null as any, // strategy
    mockRiskGuard as any,
    executor as any,
    runtimeConfig as any,
  );
}

describe('PortfolioOptimizer — rotation record wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertRotation.run.mockReturnValue({ lastInsertRowid: 42 });
    mockGetTodayRotationCount.get.mockReturnValue({ cnt: 0 });
    mockGetRecentRotations.all.mockReturnValue([]);
    mockGetTodayPnl.get.mockReturnValue(null);
    mockRecentPortfolioSnaps.all.mockReturnValue([{ portfolio_usd: 500 }]);
    mockRecentAssetSnaps.all.mockReturnValue([{ price_usd: 3000, balance: 0.5 }]);
    mockTodayRealizedPnl.get.mockReturnValue(null);
  });

  it('insertRotation is called BEFORE executeRotation', async () => {
    const callOrder: string[] = [];

    mockInsertRotation.run.mockImplementation(() => {
      callOrder.push('insert');
      return { lastInsertRowid: 42 };
    });

    const mockExecuteRotation = vi.fn().mockImplementation(async () => {
      callOrder.push('execute');
      return { status: 'executed', sellTxHash: '0xsell', buyTxHash: '0xbuy' };
    });

    const executor = { executeRotation: mockExecuteRotation };
    const optimizer = makeOptimizer(executor);

    // Inject known scores: ETH (held, low score) → sell candidate, USDC (not held, high score) → buy
    vi.spyOn(optimizer, 'computeScores').mockReturnValue([
      makeScore('ETH', -5, true),
      makeScore('USDC', 10, false),
    ]);

    await optimizer.tick('base-mainnet');

    const insertIdx  = callOrder.lastIndexOf('insert');  // last insert is the pre-execute one
    const executeIdx = callOrder.indexOf('execute');
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(executeIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeLessThan(executeIdx);
  });

  it('updateRotation is called after executeRotation with correct status and tx hashes', async () => {
    const mockExecuteRotation = vi.fn().mockResolvedValue({
      status: 'executed',
      sellTxHash: '0xsellhash',
      buyTxHash: '0xbuyhash',
    });

    const executor = { executeRotation: mockExecuteRotation };
    const optimizer = makeOptimizer(executor);

    vi.spyOn(optimizer, 'computeScores').mockReturnValue([
      makeScore('ETH', -5, true),
      makeScore('USDC', 10, false),
    ]);

    await optimizer.tick('base-mainnet');

    expect(mockUpdateRotation.run).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 42,
        status: 'executed',
        sell_tx_hash: '0xsellhash',
        buy_tx_hash: '0xbuyhash',
      }),
    );
  });
});
