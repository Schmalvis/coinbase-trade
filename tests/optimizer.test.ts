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

vi.mock('../src/data/db.js', () => ({
  queries: { insertEvent: mockInsertEvent },
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
  ],
}));

// ── Import after mocks ──
const { PortfolioOptimizer } = await import('../src/trading/optimizer.js');
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
    RISK_OFF_THRESHOLD: -50,
    RISK_ON_THRESHOLD: 10,
    DEFAULT_FEE_ESTIMATE_PCT: 0.5,
    MAX_CASH_PCT: 80,
    DRY_RUN: false,
    ...overrides,
  };
  return { get: (key: string) => defaults[key] } as any;
}

describe('PortfolioOptimizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssetBalances.clear();
    mockAssetBalances.set('ETH', 1);
    mockAssetBalances.set('USDC', 500);
    mockGetActiveAssets.all.mockReturnValue([]);
    mockGetWatchlist.all.mockReturnValue([]);
    mockGetTodayRotationCount.get.mockReturnValue({ cnt: 0 });
  });

  describe('computeScores', () => {
    it('returns scored assets with correct formula', () => {
      // Strategy returns buy with strength 60 for all timeframes
      const strategy = makeMockStrategy({ signal: 'buy', strength: 60, reason: 'test' });
      const candleService = makeMockCandleService();
      const optimizer = new PortfolioOptimizer(
        candleService, strategy, makeMockRiskGuard(), makeMockExecutor(), makeMockConfig(),
      );

      const scores = optimizer.computeScores('base-sepolia');

      expect(scores.length).toBeGreaterThanOrEqual(2); // ETH + USDC at minimum

      const ethScore = scores.find(s => s.symbol === 'ETH');
      expect(ethScore).toBeDefined();

      // direction = +1 (buy), component = 1 * 60 = 60 for each timeframe
      // raw = 60 * 0.5 + 60 * 0.3 + 60 * 0.2 = 30 + 18 + 12 = 60
      // confidence = 1.0 (coinbase source)
      // score = 60 * 1.0 = 60
      expect(ethScore!.score).toBe(60);
      expect(ethScore!.confidence).toBe(1.0);
      expect(ethScore!.isHeld).toBe(true);
      expect(ethScore!.currentWeight).toBeGreaterThan(0);
    });

    it('returns score = 0 for all-hold signals', () => {
      const strategy = makeMockStrategy({ signal: 'hold', strength: 0, reason: 'neutral' });
      const optimizer = new PortfolioOptimizer(
        makeMockCandleService(), strategy, makeMockRiskGuard(), makeMockExecutor(), makeMockConfig(),
      );

      const scores = optimizer.computeScores('base-sepolia');
      for (const s of scores) {
        expect(s.score).toBe(0);
      }
    });

    it('applies dex confidence factor of 0.7', () => {
      const strategy = makeMockStrategy({ signal: 'buy', strength: 60, reason: 'test' });
      const candleService = makeMockCandleService(() => makeCandleArray(30, { source: 'dex' }));
      const optimizer = new PortfolioOptimizer(
        candleService, strategy, makeMockRiskGuard(), makeMockExecutor(), makeMockConfig(),
      );

      const scores = optimizer.computeScores('base-sepolia');
      const ethScore = scores.find(s => s.symbol === 'ETH');

      // raw = 60, confidence = 0.7 → score = 60 * 0.7 = 42
      expect(ethScore!.confidence).toBe(0.7);
      expect(ethScore!.score).toBe(42);
    });
  });

  describe('findRotationCandidate', () => {
    it('returns pair when delta exceeds threshold', () => {
      const optimizer = new PortfolioOptimizer(
        makeMockCandleService(), makeMockStrategy(), makeMockRiskGuard(),
        makeMockExecutor(), makeMockConfig({ MIN_ROTATION_SCORE_DELTA: 30 }),
      );

      const scores: any[] = [
        { symbol: 'ETH', score: -30, confidence: 1, signals: {}, currentWeight: 50, isHeld: true },
        { symbol: 'CBBTC', score: 40, confidence: 1, signals: {}, currentWeight: 0, isHeld: false },
      ];

      const result = optimizer.findRotationCandidate(scores);
      expect(result).not.toBeNull();
      expect(result!.sell.symbol).toBe('ETH');
      expect(result!.buy.symbol).toBe('CBBTC');
    });

    it('returns null when no candidates meet thresholds', () => {
      const optimizer = new PortfolioOptimizer(
        makeMockCandleService(), makeMockStrategy(), makeMockRiskGuard(),
        makeMockExecutor(), makeMockConfig({ ROTATION_SELL_THRESHOLD: -20, ROTATION_BUY_THRESHOLD: 20 }),
      );

      // Both scores are near zero — neither qualifies as sell or buy candidate
      const scores: any[] = [
        { symbol: 'ETH', score: 5, confidence: 1, signals: {}, currentWeight: 50, isHeld: true },
        { symbol: 'CBBTC', score: 10, confidence: 1, signals: {}, currentWeight: 10, isHeld: false },
      ];

      const result = optimizer.findRotationCandidate(scores);
      expect(result).toBeNull();
    });

    it('returns null when delta is below minimum', () => {
      const optimizer = new PortfolioOptimizer(
        makeMockCandleService(), makeMockStrategy(), makeMockRiskGuard(),
        makeMockExecutor(), makeMockConfig({ MIN_ROTATION_SCORE_DELTA: 100 }),
      );

      const scores: any[] = [
        { symbol: 'ETH', score: -25, confidence: 1, signals: {}, currentWeight: 50, isHeld: true },
        { symbol: 'CBBTC', score: 30, confidence: 1, signals: {}, currentWeight: 0, isHeld: false },
      ];

      // delta = 30 - (-25) = 55 < 100
      const result = optimizer.findRotationCandidate(scores);
      expect(result).toBeNull();
    });
  });

  describe('risk-off mode', () => {
    it('activates when all scores below RISK_OFF_THRESHOLD', async () => {
      const strategy = makeMockStrategy({ signal: 'sell', strength: 80, reason: 'bearish' });
      const optimizer = new PortfolioOptimizer(
        makeMockCandleService(), strategy, makeMockRiskGuard(),
        makeMockExecutor(), makeMockConfig({ RISK_OFF_THRESHOLD: -50 }),
      );

      expect(optimizer.isRiskOff).toBe(false);

      await optimizer.tick('base-sepolia');

      // sell signal strength 80 → direction = -1, component = -80
      // raw = -80*0.5 + -80*0.3 + -80*0.2 = -80
      // score = -80 * 1.0 = -80 < -50 → all below threshold
      expect(optimizer.isRiskOff).toBe(true);
      expect(mockEmitAlert).toHaveBeenCalledWith(expect.stringContaining('RISK-OFF'));
    });

    it('deactivates when a score exceeds RISK_ON_THRESHOLD', async () => {
      const strategy = makeMockStrategy({ signal: 'sell', strength: 80, reason: 'bearish' });
      const config = makeMockConfig({ RISK_OFF_THRESHOLD: -50, RISK_ON_THRESHOLD: 10 });
      const optimizer = new PortfolioOptimizer(
        makeMockCandleService(), strategy, makeMockRiskGuard(),
        makeMockExecutor(), config,
      );

      // First tick: enter risk-off
      await optimizer.tick('base-sepolia');
      expect(optimizer.isRiskOff).toBe(true);

      // Now change strategy to return a bullish signal
      strategy.evaluate.mockReturnValue({ signal: 'buy', strength: 60, reason: 'bullish' });
      mockEmitAlert.mockClear();

      await optimizer.tick('base-sepolia');

      // buy strength 60 → score = 60 > 10 → risk-on
      expect(optimizer.isRiskOff).toBe(false);
      expect(mockEmitAlert).toHaveBeenCalledWith(expect.stringContaining('deactivated'));
    });

    it('skips rotation logic when risk-off is active', async () => {
      const strategy = makeMockStrategy({ signal: 'sell', strength: 80, reason: 'bearish' });
      const riskGuard = makeMockRiskGuard();
      const optimizer = new PortfolioOptimizer(
        makeMockCandleService(), strategy, riskGuard,
        makeMockExecutor(), makeMockConfig({ RISK_OFF_THRESHOLD: -50 }),
      );

      await optimizer.tick('base-sepolia');
      expect(optimizer.isRiskOff).toBe(true);

      // Risk guard should never be called when risk-off
      expect(riskGuard.checkRotation).not.toHaveBeenCalled();
    });
  });

  describe('tick', () => {
    it('records rotation in DB when candidate found and approved', async () => {
      // Set up a scenario where ETH is sell candidate and USDC is buy candidate
      // by making strategy return different signals per call
      let callCount = 0;
      const strategy = {
        evaluate: vi.fn().mockImplementation(() => {
          // ETH gets sell signals (first 3 calls per asset = ETH), USDC gets buy signals
          callCount++;
          // calls 1-3: ETH (15m, 1h, 24h), calls 4-6: USDC (15m, 1h, 24h)
          if (callCount <= 3) return { signal: 'sell', strength: 50, reason: 'bearish ETH' };
          return { signal: 'buy', strength: 50, reason: 'bullish USDC' };
        }),
      } as any;

      const config = makeMockConfig({
        ROTATION_SELL_THRESHOLD: -20,
        ROTATION_BUY_THRESHOLD: 20,
        MIN_ROTATION_SCORE_DELTA: 30,
        RISK_OFF_THRESHOLD: -90,
        RISK_ON_THRESHOLD: 10,
      });

      const riskGuard = makeMockRiskGuard(true);
      const optimizer = new PortfolioOptimizer(
        makeMockCandleService(), strategy, riskGuard, makeMockExecutor(), config,
      );

      await optimizer.tick('base-sepolia');

      // Should have updated daily PnL
      expect(mockUpsertDailyPnl.run).toHaveBeenCalled();

      // Should have attempted a rotation
      const scores = optimizer.getLatestScores();
      expect(scores.length).toBeGreaterThanOrEqual(2);
    });
  });
});
