import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// Shared mock function references — declared at module scope so tests can reference them
const mockRecentAssetSnapshots = vi.fn(() => []);
const mockExecuteForAsset = vi.fn().mockResolvedValue(undefined);

// Mock db to avoid SQLite native module issues
vi.mock('../src/data/db.js', () => ({
  db: {},
  queries: {
    recentAssetSnapshots: { all: (...args: unknown[]) => mockRecentAssetSnapshots(...args) },
  },
  settingQueries: { getSetting: { get: vi.fn() }, upsertSetting: { run: vi.fn() }, getAllSettings: { all: vi.fn(() => []) } },
  discoveredAssetQueries: { getActiveAssets: { all: vi.fn(() => []) } },
}));

describe('TradingEngine asset loops', () => {
  beforeEach(() => {
    mockRecentAssetSnapshots.mockReset();
    mockExecuteForAsset.mockReset();
    mockExecuteForAsset.mockResolvedValue(undefined);
  });
  afterEach(async () => {
    const { botState } = await import('../src/core/state.js');
    botState.setStatus('paused');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('stopAssetLoop is a no-op when symbol not in map', async () => {
    const mockExecutor = {} as any;
    const mockConfig = { get: vi.fn((k: string) => {
      if (k === 'STRATEGY') return 'threshold';
      if (k === 'TRADE_INTERVAL_SECONDS') return 60;
      return undefined;
    }), subscribe: vi.fn(), subscribeMany: vi.fn() } as any;
    const { TradingEngine } = await import('../src/trading/engine.js');
    const engine = new TradingEngine(mockExecutor, mockConfig);
    // Should not throw
    expect(() => engine.stopAssetLoop('UNKNOWN')).not.toThrow();
  });

  it('startAssetLoop replaces existing loop for same symbol', async () => {
    vi.stubGlobal('setInterval', vi.fn().mockReturnValue(42));
    vi.stubGlobal('clearInterval', vi.fn());

    const mockExecutor = {} as any;
    const mockConfig = { get: vi.fn((k: string) => {
      if (k === 'STRATEGY') return 'threshold';
      if (k === 'TRADE_INTERVAL_SECONDS') return 60;
      return undefined;
    }), subscribe: vi.fn(), subscribeMany: vi.fn() } as any;
    const { TradingEngine } = await import('../src/trading/engine.js');
    const engine = new TradingEngine(mockExecutor, mockConfig);

    const params = { strategyType: 'threshold' as const, dropPct: 2, risePct: 3, smaShort: 5, smaLong: 20 };
    engine.startAssetLoop('0xabc', 'PEPE', params);
    engine.startAssetLoop('0xabc', 'PEPE', params); // second call for same symbol

    expect(clearInterval).toHaveBeenCalledWith(42);
  });

  describe('tickAsset — RISK_OFF gate', () => {
    it('blocks BUY signals but allows holds/sells through when optimizer isRiskOff is true', async () => {
      const mockExecutor = { executeForAsset: mockExecuteForAsset } as any;
      const mockConfig = { get: vi.fn((k: string) => {
        if (k === 'STRATEGY') return 'threshold';
        if (k === 'TRADE_INTERVAL_SECONDS') return 60;
        if (k === 'PRICE_DROP_THRESHOLD_PCT') return 2.0;
        if (k === 'PRICE_RISE_TARGET_PCT') return 3.0;
        return undefined;
      }), subscribe: vi.fn(), subscribeMany: vi.fn() } as any;

      const { TradingEngine } = await import('../src/trading/engine.js');
      const engine = new TradingEngine(mockExecutor, mockConfig);

      const { botState } = await import('../src/core/state.js');
      botState.setStatus('running');

      // Price dropped 3% from 100 → 97: triggers buy signal on second tick
      mockRecentAssetSnapshots.mockReturnValue([
        { price_usd: 97,  balance: 1, timestamp: new Date().toISOString() },
        { price_usd: 100, balance: 1, timestamp: new Date().toISOString() },
      ]);

      const mockOptimizer = { isRiskOff: true } as any;
      engine.setOptimizer(mockOptimizer);

      const assetParams = {
        strategyType: 'threshold' as const,
        dropPct: 2.0,
        risePct: 3.0,
        smaShort: 3,
        smaLong: 5,
      };

      // First tick primes entry price (returns hold), second tick generates buy signal
      await (engine as any).tickAsset('CBBTC', assetParams);
      await (engine as any).tickAsset('CBBTC', assetParams);

      // Buy must be blocked in RISK_OFF
      expect(mockExecuteForAsset).not.toHaveBeenCalledWith('CBBTC', 'buy', expect.any(String), expect.anything());
    });

    it('fully halts grid strategy (both buy and sell) when optimizer isRiskOff is true', async () => {
      const mockExecutor = { executeForAsset: mockExecuteForAsset } as any;
      const mockConfig = { get: vi.fn((k: string) => {
        if (k === 'TRADE_INTERVAL_SECONDS') return 60;
        return undefined;
      }), subscribe: vi.fn(), subscribeMany: vi.fn() } as any;

      const { TradingEngine } = await import('../src/trading/engine.js');
      const engine = new TradingEngine(mockExecutor, mockConfig);

      const { botState } = await import('../src/core/state.js');
      botState.setStatus('running');

      mockRecentAssetSnapshots.mockReturnValue([
        { price_usd: 97,  balance: 1, timestamp: new Date().toISOString() },
        { price_usd: 100, balance: 1, timestamp: new Date().toISOString() },
      ]);

      const mockOptimizer = { isRiskOff: true } as any;
      engine.setOptimizer(mockOptimizer);

      const assetParams = {
        strategyType: 'grid' as const,
        dropPct: 2.0,
        risePct: 3.0,
        smaShort: 3,
        smaLong: 5,
      };

      await (engine as any).tickAsset('ETH', assetParams);

      // Grid is fully halted in RISK_OFF — no executeForAsset call at all
      expect(mockExecuteForAsset).not.toHaveBeenCalled();
    });

    it('proceeds with executeForAsset when optimizer isRiskOff is false', async () => {
      const mockExecutor = { executeForAsset: mockExecuteForAsset } as any;
      const mockConfig = { get: vi.fn((k: string) => {
        if (k === 'STRATEGY') return 'threshold';
        if (k === 'TRADE_INTERVAL_SECONDS') return 60;
        if (k === 'PRICE_DROP_THRESHOLD_PCT') return 2.0;
        if (k === 'PRICE_RISE_TARGET_PCT') return 3.0;
        return undefined;
      }), subscribe: vi.fn(), subscribeMany: vi.fn() } as any;

      const { TradingEngine } = await import('../src/trading/engine.js');
      const engine = new TradingEngine(mockExecutor, mockConfig);

      const { botState } = await import('../src/core/state.js');
      botState.setStatus('running');

      mockRecentAssetSnapshots.mockReturnValue([
        { price_usd: 97,  balance: 1, timestamp: new Date().toISOString() },
        { price_usd: 100, balance: 1, timestamp: new Date().toISOString() },
      ]);

      const mockOptimizer = { isRiskOff: false } as any;
      engine.setOptimizer(mockOptimizer);

      const assetParams = {
        strategyType: 'threshold' as const,
        dropPct: 2.0,
        risePct: 3.0,
        smaShort: 3,
        smaLong: 5,
      };

      // Prime entry price first tick, then fire second tick which evaluates signal
      await (engine as any).tickAsset('CBBTC', assetParams);
      await (engine as any).tickAsset('CBBTC', assetParams);

      expect(mockExecuteForAsset).toHaveBeenCalled();
    });
  });

  it('asset loop uses per-asset dropPct (not global config)', async () => {
    vi.stubGlobal('setInterval', vi.fn().mockReturnValue(99));
    vi.stubGlobal('clearInterval', vi.fn());

    const mockExecutor = { executeForAsset: mockExecuteForAsset } as any;
    const mockConfig = { get: vi.fn((k: string) => {
      if (k === 'STRATEGY') return 'threshold';
      if (k === 'TRADE_INTERVAL_SECONDS') return 60;
      if (k === 'PRICE_DROP_THRESHOLD_PCT') return 2.0; // global: 2%
      if (k === 'PRICE_RISE_TARGET_PCT') return 3.0;
      return undefined;
    }), subscribe: vi.fn(), subscribeMany: vi.fn() } as any;

    // Import fresh engine instance (module already loaded — reuse same import)
    const { TradingEngine } = await import('../src/trading/engine.js');
    const engine = new TradingEngine(mockExecutor, mockConfig);

    // Set bot status to running so isPaused returns false
    const { botState } = await import('../src/core/state.js');
    botState.setStatus('running');

    // Provide 2 snapshots: high=100, current=97 (3% drop — below 50% per-asset threshold)
    mockRecentAssetSnapshots.mockReturnValue([
      { price_usd: 97,  balance: 1, timestamp: new Date().toISOString() },
      { price_usd: 100, balance: 1, timestamp: new Date().toISOString() },
    ]);

    const assetParams = {
      strategyType: 'threshold' as const,
      dropPct: 50.0,  // very high threshold — a 3% drop should NOT trigger buy
      risePct: 99.0,
      smaShort: 3,
      smaLong: 5,
    };

    // First tick primes entry price (returns 'hold: initialising')
    await (engine as any).tickAsset('TESTTOKEN', assetParams);
    // Second tick — 3% drop should hold with 50% threshold
    await (engine as any).tickAsset('TESTTOKEN', assetParams);

    // With per-asset dropPct=50, a 3% drop must NOT trigger buy
    expect(mockExecuteForAsset).not.toHaveBeenCalledWith('TESTTOKEN', 'buy', expect.any(String));
  });
});
