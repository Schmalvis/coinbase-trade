import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/data/db.js', () => ({
  queries: { recentSnapshots: { all: () => [] }, recentAssetSnapshots: { all: () => [] } },
  discoveredAssetQueries: { getActiveAssets: { all: () => [] } },
  gridStateQueries: {
    upsertGridLevel: { run: vi.fn() },
    getGridLevels: { all: () => [] },
    clearGridLevels: { run: vi.fn() },
  },
}));
vi.mock('../src/core/state.js', () => ({
  botState: { isPaused: false, activeNetwork: 'base-sepolia', status: 'running' },
}));
vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockExecutor = { execute: vi.fn(), executeForAsset: vi.fn() };
const mockConfig = {
  get: vi.fn((k: string) => {
    const d: Record<string, unknown> = {
      STRATEGY: 'threshold', TRADE_INTERVAL_SECONDS: 60,
      SMA_SHORT_WINDOW: 5, SMA_LONG_WINDOW: 20,
      OPTIMIZER_INTERVAL_SECONDS: 300, DEFAULT_FEE_ESTIMATE_PCT: 1.0,
    };
    return d[k];
  }),
  subscribe: vi.fn(), subscribeMany: vi.fn(),
};

import { TradingEngine } from '../src/trading/engine.js';

describe('TradingEngine grid support', () => {
  it('accepts grid as a strategy type without throwing', () => {
    const engine = new TradingEngine(mockExecutor as any, mockConfig as any);
    expect(() => {
      engine.startAssetLoop('0xabc', 'TEST', {
        strategyType: 'grid', dropPct: 2, risePct: 3,
        smaShort: 5, smaLong: 20,
        gridLevels: 10, gridUpperBound: 2000, gridLowerBound: 1800,
      });
    }).not.toThrow();
    engine.stopAssetLoop('TEST');
  });
});
