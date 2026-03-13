import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock db to avoid SQLite native module issues
vi.mock('../src/data/db.js', () => ({
  db: {},
  queries: {},
  settingQueries: { getSetting: { get: vi.fn() }, upsertSetting: { run: vi.fn() }, getAllSettings: { all: vi.fn(() => []) } },
  discoveredAssetQueries: { getActiveAssets: { all: vi.fn(() => []) } },
}));

describe('TradingEngine asset loops', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('stopAssetLoop is a no-op when symbol not in map', async () => {
    const mockExecutor = {} as any;
    const mockConfig = { get: vi.fn((k: string) => {
      if (k === 'STRATEGY') return 'threshold';
      if (k === 'TRADE_INTERVAL_SECONDS') return 60;
      return undefined;
    }), subscribeMany: vi.fn() } as any;
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
    }), subscribeMany: vi.fn() } as any;
    const { TradingEngine } = await import('../src/trading/engine.js');
    const engine = new TradingEngine(mockExecutor, mockConfig);

    const params = { strategyType: 'threshold' as const, dropPct: 2, risePct: 3, smaShort: 5, smaLong: 20 };
    engine.startAssetLoop('0xabc', 'PEPE', params);
    engine.startAssetLoop('0xabc', 'PEPE', params); // second call for same symbol

    expect(clearInterval).toHaveBeenCalledWith(42);
  });
});
