import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/data/db.js', () => ({
  queries: { recentSnapshots: { all: () => [] }, recentAssetSnapshots: { all: () => [] } },
  discoveredAssetQueries: {
    getActiveAssets: { all: () => [
      {
        address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        symbol: 'ETH', strategy: 'threshold',
        drop_pct: 2, rise_pct: 3, sma_short: 5, sma_long: 20,
        grid_levels: 10, grid_upper_bound: null, grid_lower_bound: null,
      },
      {
        address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
        symbol: 'CBBTC', strategy: 'sma',
        drop_pct: 2, rise_pct: 3, sma_short: 5, sma_long: 20,
        grid_levels: 10, grid_upper_bound: null, grid_lower_bound: null,
      },
    ]},
  },
  gridStateQueries: {
    upsertGridLevel: { run: vi.fn() },
    getGridLevels: { all: () => [] },
    clearGridLevels: { run: vi.fn() },
  },
}));
vi.mock('../src/core/state.js', () => ({
  botState: { isPaused: false, activeNetwork: 'base-mainnet', status: 'running' },
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
      PRICE_DROP_THRESHOLD_PCT: 2, PRICE_RISE_TARGET_PCT: 3,
    };
    return d[k];
  }),
  subscribe: vi.fn(), subscribeMany: vi.fn(),
};

import { TradingEngine } from '../src/trading/engine.js';

describe('TradingEngine unified asset loops', () => {
  it('startAllAssetLoops starts loops for all active assets from DB', () => {
    const engine = new TradingEngine(mockExecutor as any, mockConfig as any);
    engine.startAllAssetLoops();
    expect(engine.activeAssetCount).toBe(2);
    engine.stopAllAssetLoops();
    expect(engine.activeAssetCount).toBe(0);
  });

  it('startAllAssetLoops calls startAssetLoop exactly once per active asset', () => {
    const engine = new TradingEngine(mockExecutor as any, mockConfig as any);
    const spy = vi.spyOn(engine, 'startAssetLoop');
    engine.startAllAssetLoops();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith(
      '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'ETH', expect.any(Object),
    );
    engine.stopAllAssetLoops();
    spy.mockRestore();
  });
});
