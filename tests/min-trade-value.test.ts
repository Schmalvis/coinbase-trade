import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── vi.hoisted for mock values referenced inside vi.mock factories ──
const {
  mockRecentPortfolioSnaps,
  mockRecentAssetSnaps,
  mockInsertEvent,
  mockInsertTrade,
} = vi.hoisted(() => ({
  mockRecentPortfolioSnaps: { all: vi.fn() },
  mockRecentAssetSnaps:     { all: vi.fn() },
  mockInsertEvent:          { run: vi.fn() },
  mockInsertTrade:          { run: vi.fn() },
}));

vi.mock('../src/data/db.js', () => ({
  queries: {
    insertEvent: mockInsertEvent,
    insertTrade: mockInsertTrade,
    recentPortfolioSnapshots: mockRecentPortfolioSnaps,
    recentAssetSnapshots: mockRecentAssetSnaps,
  },
  runTransaction: vi.fn((fn: () => void) => fn()),
}));

vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockAssetBalances = new Map<string, number>();
vi.mock('../src/core/state.js', () => ({
  botState: {
    get assetBalances() { return mockAssetBalances; },
    get lastPrice() { return 3000; },
    get isPaused() { return false; },
    emitAlert: vi.fn(),
    recordTrade: vi.fn(),
    emitTrade: vi.fn(),
  },
}));

vi.mock('../src/wallet/tools.js', () => ({
  CoinbaseTools: vi.fn(),
}));

import { TradeExecutor } from '../src/trading/executor.js';

function makeRuntimeConfig(overrides: Record<string, unknown> = {}) {
  const cfg: Record<string, unknown> = {
    DRY_RUN: false,
    TRADE_COOLDOWN_SECONDS: 0,
    MAX_POSITION_PCT: 100,
    PORTFOLIO_FLOOR_USD: 0,
    ...overrides,
  };
  return {
    get: (k: string) => cfg[k],
    subscribeMany: vi.fn(),
    subscribe: vi.fn(),
  };
}

const mockSwap = vi.fn();

function makeMockTools() {
  return {
    swap: mockSwap,
    getTokenAddress: vi.fn().mockReturnValue('0xaddr'),
  };
}

describe('TradeExecutor — min trade value guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssetBalances.clear();
    mockRecentPortfolioSnaps.all.mockReturnValue([{ portfolio_usd: 500 }]);
    mockRecentAssetSnaps.all.mockReturnValue([{ price_usd: 3000, balance: 0.5 }]);
  });

  it('skips trade when USDC buy amount is below $2 (dust trade)', async () => {
    // $1 USDC balance → 10% = $0.10 (well below minimum $2)
    mockAssetBalances.set('USDC', 1.0);

    const tools = makeMockTools();
    const executor = new TradeExecutor(tools as any, makeRuntimeConfig() as any);

    await executor.executeForAsset('ETH', 'buy', 'test signal');

    expect(mockSwap).not.toHaveBeenCalled();
  });

  it('proceeds when USDC buy amount is at or above $2', async () => {
    // $100 USDC → 10% = $10 (above minimum)
    mockAssetBalances.set('USDC', 100);
    // No existing ETH position so position limit check passes
    mockRecentAssetSnaps.all.mockReturnValue([]);
    mockSwap.mockResolvedValue({ txHash: '0xtx', status: 'executed' });

    const tools = makeMockTools();
    const executor = new TradeExecutor(tools as any, makeRuntimeConfig() as any);

    await executor.executeForAsset('ETH', 'buy', 'test signal');

    expect(mockSwap).toHaveBeenCalled();
  });

  it('skips sell trade when token balance value is below $2', async () => {
    // 0.00001 ETH * $3000 * 10% = $0.003 — well below $2
    mockAssetBalances.set('ETH', 0.00001);
    mockRecentAssetSnaps.all.mockReturnValue([{ price_usd: 3000, balance: 0.00001 }]);

    const tools = makeMockTools();
    const executor = new TradeExecutor(tools as any, makeRuntimeConfig() as any);

    await executor.executeForAsset('ETH', 'sell', 'test signal');

    expect(mockSwap).not.toHaveBeenCalled();
  });
});
