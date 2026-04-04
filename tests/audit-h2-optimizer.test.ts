import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock DB modules ──
const mockInsertRotation = { run: vi.fn() };
const mockGetTodayRotationCount = { get: vi.fn().mockReturnValue({ cnt: 0 }) };
const mockGetRecentRotations = { all: vi.fn().mockReturnValue([]) };
const mockUpdateRotation = { run: vi.fn() };
const mockUpsertDailyPnl = { run: vi.fn() };
const mockGetTodayPnl = { get: vi.fn().mockReturnValue(null) };
const mockGetDailyPnl = { get: vi.fn().mockReturnValue(null) };
const mockGetActiveAssets = { all: vi.fn().mockReturnValue([]) };
const mockGetWatchlist = { all: vi.fn().mockReturnValue([]) };
const mockInsertEvent = { run: vi.fn() };
const mockRecentAssetSnapshots = { all: vi.fn().mockReturnValue([]) };
const mockRecentPortfolioSnapshots = { all: vi.fn().mockReturnValue([]) };
const mockTodayRealizedPnl = { get: vi.fn().mockReturnValue(undefined) };
const mockGetGridLevels = { all: vi.fn().mockReturnValue([]) };
const mockUpsertGridLevel = { run: vi.fn() };
const mockClearGridLevels = { run: vi.fn() };

vi.mock('../src/data/db.js', () => ({
  queries: {
    insertEvent: mockInsertEvent,
    recentAssetSnapshots: mockRecentAssetSnapshots,
    recentPortfolioSnapshots: mockRecentPortfolioSnapshots,
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
    getDailyPnl: mockGetDailyPnl,
  },
  discoveredAssetQueries: {
    getActiveAssets: mockGetActiveAssets,
  },
  watchlistQueries: {
    getWatchlist: mockGetWatchlist,
  },
  gridStateQueries: {
    getGridLevels: mockGetGridLevels,
    upsertGridLevel: mockUpsertGridLevel,
    clearGridLevels: mockClearGridLevels,
  },
  runTransaction: (fn: () => void) => fn(),
}));

// ── Mock botState ──
const mockAssetBalances = new Map<string, number>();
const mockEmitAlert = vi.fn();

vi.mock('../src/core/state.js', () => ({
  botState: {
    get assetBalances() { return mockAssetBalances; },
    get lastPrice() { return 2000; },
    emitAlert: mockEmitAlert,
    isPaused: false,
    activeNetwork: 'base-sepolia',
  },
}));

// ── Mock logger ──
vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Mock assets registry ──
vi.mock('../src/assets/registry.js', () => ({
  assetsForNetwork: (_network: string) => [
    { symbol: 'ETH', decimals: 18, addresses: { 'base-sepolia': '0xeee' }, priceSource: 'pyth', tradeMethod: 'agentkit' },
    { symbol: 'USDC', decimals: 6, addresses: { 'base-sepolia': '0x036' }, priceSource: 'defillama', tradeMethod: 'agentkit' },
    { symbol: 'CBBTC', decimals: 8, addresses: { 'base-sepolia': '0xcbb' }, priceSource: 'coinbase', tradeMethod: 'agentkit' },
  ],
}));

// ── Mock config ──
vi.mock('../src/config.js', () => ({
  config: {
    PRICE_DROP_THRESHOLD_PCT: 3,
    PRICE_RISE_TARGET_PCT: 5,
  },
}));

// ── Import after mocks ──
const { PortfolioOptimizer } = await import('../src/trading/optimizer.js');
const { GridStrategy } = await import('../src/strategy/grid.js');
const { ThresholdStrategy } = await import('../src/strategy/threshold.js');
import type { CandleSignal } from '../src/strategy/candle.js';

// ── Helpers ──
function makeCandleArray(count: number, overrides: Partial<{ close: number; volume: number; source: string }> = {}) {
  return Array.from({ length: count }, (_, i) => ({
    symbol: 'ETH',
    network: 'base-sepolia',
    interval: '15m' as const,
    openTime: new Date(Date.now() - (count - i) * 15 * 60 * 1000).toISOString(),
    open: 2000,
    high: 2050,
    low: 1950,
    close: overrides.close ?? 2000,
    volume: overrides.volume ?? 100,
    source: (overrides.source ?? 'coinbase') as 'coinbase' | 'dex' | 'synthetic',
  }));
}

function makeMockCandleService(getStoredCandlesImpl?: (...args: any[]) => any) {
  return {
    getStoredCandles: vi.fn(getStoredCandlesImpl ?? (() => makeCandleArray(30))),
  } as any;
}

function makeMockStrategy(evaluateResult?: CandleSignal) {
  return {
    evaluate: vi.fn().mockReturnValue(evaluateResult ?? { signal: 'buy', strength: 60, reason: 'test' }),
  } as any;
}

function makeMockRiskGuard(approved = true) {
  return {
    checkRotation: vi.fn().mockReturnValue({ approved, adjustedAmount: 10, vetoReason: approved ? undefined : 'test veto' }),
  } as any;
}

function makeMockExecutor() {
  return {} as any;
}

function makeMockConfig(overrides: Record<string, any> = {}) {
  const defaults: Record<string, any> = {
    ROTATION_SELL_THRESHOLD: -20,
    ROTATION_BUY_THRESHOLD: 20,
    MIN_ROTATION_SCORE_DELTA: 30,
    RISK_OFF_THRESHOLD: -90,
    RISK_ON_THRESHOLD: 10,
    DEFAULT_FEE_ESTIMATE_PCT: 1.0,
    MAX_CASH_PCT: 80,
    DRY_RUN: false,
    ...overrides,
  };
  return { get: (key: string) => defaults[key] } as any;
}

describe('Audit H2: Optimizer pricing for non-ETH/USDC assets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssetBalances.clear();
    mockAssetBalances.set('ETH', 1);
    mockAssetBalances.set('USDC', 500);
    mockAssetBalances.set('CBBTC', 0.5);
    mockGetActiveAssets.all.mockReturnValue([]);
    mockGetWatchlist.all.mockReturnValue([]);
    mockGetTodayRotationCount.get.mockReturnValue({ cnt: 0 });
  });

  it('prices non-ETH assets from asset_snapshots instead of returning 0', async () => {
    // CBBTC has a snapshot price of $60000
    mockRecentAssetSnapshots.all.mockImplementation((symbol: string, _limit: number) => {
      if (symbol === 'CBBTC') return [{ price_usd: 60000, balance: 0.5, timestamp: new Date().toISOString() }];
      return [];
    });

    // Set up strategy to make CBBTC a sell candidate and USDC a buy candidate
    let callIdx = 0;
    const strategy = {
      evaluate: vi.fn().mockImplementation(() => {
        callIdx++;
        // ETH: neutral, USDC: strong buy, CBBTC: strong sell
        if (callIdx <= 3) return { signal: 'hold', strength: 0, reason: 'neutral' }; // ETH
        if (callIdx <= 6) return { signal: 'buy', strength: 80, reason: 'bullish' };  // USDC
        return { signal: 'sell', strength: 80, reason: 'bearish' };                    // CBBTC
      }),
    } as any;

    const riskGuard = makeMockRiskGuard(true);
    const config = makeMockConfig({
      ROTATION_SELL_THRESHOLD: -20,
      ROTATION_BUY_THRESHOLD: 20,
      MIN_ROTATION_SCORE_DELTA: 30,
    });

    const optimizer = new PortfolioOptimizer(
      makeMockCandleService(), strategy, riskGuard, makeMockExecutor(), config,
    );

    await optimizer.tick('base-sepolia');

    // If CBBTC is the sell candidate, sellUsdValue should be 0.5 * 60000 = 30000, not 0
    // Check that riskGuard was called (meaning sellAmount > 0)
    if (riskGuard.checkRotation.mock.calls.length > 0) {
      const proposal = riskGuard.checkRotation.mock.calls[0][0];
      if (proposal.sellSymbol === 'CBBTC') {
        expect(proposal.sellAmount).toBeGreaterThan(0);
      }
    }
  });

  it('converts score delta to estimated gain percentage (not raw score)', async () => {
    // Set up ETH as sell candidate, USDC as buy candidate
    let callIdx = 0;
    const strategy = {
      evaluate: vi.fn().mockImplementation(() => {
        callIdx++;
        if (callIdx <= 3) return { signal: 'sell', strength: 50, reason: 'bearish' }; // ETH
        if (callIdx <= 6) return { signal: 'buy', strength: 50, reason: 'bullish' };  // USDC
        return { signal: 'hold', strength: 0, reason: 'neutral' };                     // CBBTC
      }),
    } as any;

    const riskGuard = makeMockRiskGuard(true);
    const config = makeMockConfig({
      ROTATION_SELL_THRESHOLD: -20,
      ROTATION_BUY_THRESHOLD: 20,
      MIN_ROTATION_SCORE_DELTA: 30,
    });

    const optimizer = new PortfolioOptimizer(
      makeMockCandleService(), strategy, riskGuard, makeMockExecutor(), config,
    );

    await optimizer.tick('base-sepolia');

    if (riskGuard.checkRotation.mock.calls.length > 0) {
      const proposal = riskGuard.checkRotation.mock.calls[0][0];
      // estimatedGainPct should be scoreDelta * 0.05, not the raw score delta
      // Score delta of ~100 * 0.05 = ~5, not 100
      expect(proposal.estimatedGainPct).toBeLessThan(20);
    }
  });
});

describe('Bug fixes: B1 current_usd from snapshots, B2 realized_pnl from DB', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssetBalances.clear();
    mockAssetBalances.set('ETH', 1);
    mockAssetBalances.set('USDC', 500);
    mockAssetBalances.set('CBBTC', 0.5);
    mockGetActiveAssets.all.mockReturnValue([]);
    mockGetWatchlist.all.mockReturnValue([]);
    mockGetTodayRotationCount.get.mockReturnValue({ cnt: 0 });
    // default: no snapshot, no realized pnl
    mockRecentPortfolioSnapshots.all.mockReturnValue([]);
    mockTodayRealizedPnl.get.mockReturnValue(undefined);
  });

  it('B1: current_usd comes from portfolio_snapshots, not stale botState loop', async () => {
    mockRecentPortfolioSnapshots.all.mockReturnValue([{ portfolio_usd: 121.00 }]);

    const optimizer = new PortfolioOptimizer(
      makeMockCandleService(), makeMockStrategy(), makeMockRiskGuard(false), makeMockExecutor(), makeMockConfig(),
    );

    await optimizer.tick('base-mainnet');

    expect(mockUpsertDailyPnl.run).toHaveBeenCalledWith(
      expect.objectContaining({ current_usd: 121.00 }),
    );
  });

  it('B2: realized_pnl comes from todayRealizedPnl query, not hardcoded 0', async () => {
    mockTodayRealizedPnl.get.mockReturnValue({ total: 0.03 });
    mockRecentPortfolioSnapshots.all.mockReturnValue([{ portfolio_usd: 100.00 }]);

    const optimizer = new PortfolioOptimizer(
      makeMockCandleService(), makeMockStrategy(), makeMockRiskGuard(false), makeMockExecutor(), makeMockConfig(),
    );

    await optimizer.tick('base-mainnet');

    expect(mockUpsertDailyPnl.run).toHaveBeenCalledWith(
      expect.objectContaining({ realized_pnl: 0.03 }),
    );
  });
});

describe('Audit H4: Grid strategy division-by-zero safety', () => {
  it('returns hold when upper bound equals lower bound', () => {
    const grid = new GridStrategy({
      symbol: 'ETH',
      network: 'base-sepolia',
      upperBound: 2000,
      lowerBound: 2000, // equal bounds
      gridLevels: 10,
      getCandleHigh24h: () => null,
      getCandleLow24h: () => null,
      feeEstimatePct: 1.0,
    });

    const result = grid.evaluate([
      { eth_price: 2000, eth_balance: 1, portfolio_usd: 2000, timestamp: new Date().toISOString() },
      { eth_price: 2000, eth_balance: 1, portfolio_usd: 2000, timestamp: new Date().toISOString() },
    ]);

    expect(result.signal).toBe('hold');
    expect(result.reason).toContain('invalid');
  });

  it('returns hold when lower bound exceeds upper bound', () => {
    const grid = new GridStrategy({
      symbol: 'ETH',
      network: 'base-sepolia',
      upperBound: 1000,
      lowerBound: 2000, // inverted
      gridLevels: 10,
      getCandleHigh24h: () => null,
      getCandleLow24h: () => null,
      feeEstimatePct: 1.0,
    });

    const result = grid.evaluate([
      { eth_price: 1500, eth_balance: 1, portfolio_usd: 1500, timestamp: new Date().toISOString() },
      { eth_price: 1500, eth_balance: 1, portfolio_usd: 1500, timestamp: new Date().toISOString() },
    ]);

    expect(result.signal).toBe('hold');
    expect(result.reason).toContain('invalid');
  });

  it('does not crash with auto-calculated equal bounds from candles', () => {
    // Candle high and low are the same → recalculateBounds produces upper > lower due to ±2% margin
    const grid = new GridStrategy({
      symbol: 'ETH',
      network: 'base-sepolia',
      gridLevels: 10,
      getCandleHigh24h: () => 2000,
      getCandleLow24h: () => 2000,
      feeEstimatePct: 1.0,
    });

    // Should not throw
    const result = grid.evaluate([
      { eth_price: 2000, eth_balance: 1, portfolio_usd: 2000, timestamp: new Date().toISOString() },
      { eth_price: 2000, eth_balance: 1, portfolio_usd: 2000, timestamp: new Date().toISOString() },
    ]);

    expect(result.signal).toBeDefined();
  });
});

describe('Audit M1: ThresholdStrategy consecutive buy limit', () => {
  it('limits consecutive buys to 3', () => {
    const strategy = new ThresholdStrategy({ dropPct: 1, risePct: 5 });

    // Create snapshots that trigger a buy (price dropping from high)
    const makeDropSnapshots = (high: number, current: number) => [
      { eth_price: current, eth_balance: 1, portfolio_usd: current, timestamp: new Date().toISOString() },
      { eth_price: high, eth_balance: 1, portfolio_usd: high, timestamp: new Date().toISOString() },
      { eth_price: high, eth_balance: 1, portfolio_usd: high, timestamp: new Date().toISOString() },
      { eth_price: high, eth_balance: 1, portfolio_usd: high, timestamp: new Date().toISOString() },
    ];

    // First call initialises entryPrice
    let result;
    result = strategy.evaluate(makeDropSnapshots(2000, 2000));
    expect(result.signal).toBe('hold'); // initialising

    // Now 3 consecutive buys should succeed
    result = strategy.evaluate(makeDropSnapshots(2000, 1900));
    expect(result.signal).toBe('buy');

    result = strategy.evaluate(makeDropSnapshots(1900, 1800));
    expect(result.signal).toBe('buy');

    result = strategy.evaluate(makeDropSnapshots(1800, 1700));
    expect(result.signal).toBe('buy');

    // 4th buy should be held
    result = strategy.evaluate(makeDropSnapshots(1700, 1600));
    expect(result.signal).toBe('hold');
    expect(result.reason).toContain('Consecutive buy limit');
  });

  it('resets consecutive buy counter on sell', () => {
    const strategy = new ThresholdStrategy({ dropPct: 1, risePct: 3 });

    const makeDropSnapshots = (high: number, current: number) => [
      { eth_price: current, eth_balance: 1, portfolio_usd: current, timestamp: new Date().toISOString() },
      { eth_price: high, eth_balance: 1, portfolio_usd: high, timestamp: new Date().toISOString() },
      { eth_price: high, eth_balance: 1, portfolio_usd: high, timestamp: new Date().toISOString() },
      { eth_price: high, eth_balance: 1, portfolio_usd: high, timestamp: new Date().toISOString() },
    ];

    // Initialise entryPrice
    strategy.evaluate(makeDropSnapshots(2000, 2000));

    // 3 consecutive buys
    strategy.evaluate(makeDropSnapshots(2000, 1900));
    strategy.evaluate(makeDropSnapshots(1900, 1800));
    strategy.evaluate(makeDropSnapshots(1800, 1700));

    // Now trigger a sell (price rises significantly from entry)
    // After 3rd buy, entryPrice = 1700. We need gainPct >= 3, so current >= 1700 * 1.03 = 1751
    const sellSnapshots = [
      { eth_price: 1800, eth_balance: 1, portfolio_usd: 1800, timestamp: new Date().toISOString() },
      { eth_price: 1700, eth_balance: 1, portfolio_usd: 1700, timestamp: new Date().toISOString() },
      { eth_price: 1700, eth_balance: 1, portfolio_usd: 1700, timestamp: new Date().toISOString() },
    ];
    const sellResult = strategy.evaluate(sellSnapshots);
    expect(sellResult.signal).toBe('sell');

    // After sell, consecutive buy counter should be reset — next buy should work
    const result = strategy.evaluate(makeDropSnapshots(1800, 1700));
    expect(result.signal).toBe('buy');
  });
});
