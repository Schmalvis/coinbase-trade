import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared mutable asset balances map
const mockAssetBalances = new Map<string, number>();

vi.mock('../src/core/state.js', () => {
  const assetBalances = new Map<string, number>();
  return {
    botState: {
      isPaused: false,
      lastTradeAt: null,
      lastPrice: 0,
      lastBalance: 0,
      lastUsdcBalance: 0,
      activeNetwork: 'base-sepolia',
      recordTrade: vi.fn(),
      emitTrade: vi.fn(),
      get assetBalances() { return assetBalances; },
    },
    _assetBalances: assetBalances,
  };
});

vi.mock('../src/data/db.js', () => ({
  queries: {
    insertTrade: { run: vi.fn() },
  },
}));

import { TradeExecutor } from '../src/trading/executor.js';
import { botState } from '../src/core/state.js';

function makeRc(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    DRY_RUN: false,
    TRADE_COOLDOWN_SECONDS: 3600,
    MAX_TRADE_SIZE_ETH: 0.01,
    MAX_TRADE_SIZE_USDC: 10,
    ...overrides,
  };
  return {
    get: (k: string) => values[k],
    subscribe: vi.fn(),
    subscribeMany: vi.fn(),
  };
}

describe('TradeExecutor.executeForAsset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (botState.assetBalances as Map<string, number>).clear();
  });

  it('returns early on hold signal without calling tools.swap', async () => {
    const mockTools = { swap: vi.fn() } as any;
    const rc = makeRc();
    const executor = new TradeExecutor(mockTools, rc as any);
    await executor.executeForAsset('PEPE', 'hold', 'test');
    expect(mockTools.swap).not.toHaveBeenCalled();
  });

  it('skips trade when cooldown active for same symbol', async () => {
    const mockTools = { swap: vi.fn().mockResolvedValue(undefined) } as any;
    const rc = makeRc({ TRADE_COOLDOWN_SECONDS: 3600 });
    (botState.assetBalances as Map<string, number>).set('PEPE', 100);
    const executor = new TradeExecutor(mockTools, rc as any);

    // First call — should execute (no cooldown yet)
    await executor.executeForAsset('PEPE', 'sell', 'test');
    // Second call immediately — cooldown should block
    await executor.executeForAsset('PEPE', 'sell', 'test');

    // swap should have been called only once
    expect(mockTools.swap).toHaveBeenCalledTimes(1);
  });
});
