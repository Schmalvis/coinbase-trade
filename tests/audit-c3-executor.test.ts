import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Hoisted mocks ---
const mockSwap = vi.hoisted(() => vi.fn().mockResolvedValue({ txHash: '0xabc' }));
const mockGetErc20Balance = vi.hoisted(() => vi.fn().mockResolvedValue(100));
const mockInsertTradeRun = vi.hoisted(() => vi.fn());
const mockRecentPortfolioAll = vi.hoisted(() => vi.fn().mockReturnValue([{ portfolio_usd: 1000 }]));
const mockRecentAssetAll = vi.hoisted(() => vi.fn().mockReturnValue([{ price_usd: 10, balance: 5 }]));

vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/core/state.js', () => ({
  botState: {
    isPaused: false,
    lastPrice: 2000,
    lastBalance: 1,
    lastUsdcBalance: 500,
    activeNetwork: 'base-sepolia',
    assetBalances: new Map<string, number>([['USDC', 1000], ['CBBTC', 5]]),
    recordTrade: vi.fn(),
    emitTrade: vi.fn(),
  },
}));

vi.mock('../src/data/db.js', () => ({
  queries: {
    insertTrade: { run: mockInsertTradeRun },
    recentPortfolioSnapshots: { all: mockRecentPortfolioAll },
    recentAssetSnapshots: { all: mockRecentAssetAll },
  },
}));

import { TradeExecutor } from '../src/trading/executor.js';
import { botState } from '../src/core/state.js';
import type { RuntimeConfig } from '../src/core/runtime-config.js';

function makeConfig(overrides: Record<string, unknown> = {}): RuntimeConfig {
  const defaults: Record<string, unknown> = {
    DRY_RUN: false,
    TRADE_COOLDOWN_SECONDS: 0,
    MAX_TRADE_SIZE_ETH: 1,
    MAX_TRADE_SIZE_USDC: 1000,
    PORTFOLIO_FLOOR_USD: 100,
    MAX_POSITION_PCT: 40,
  };
  return {
    get: (key: string) => overrides[key] ?? defaults[key],
    subscribe: vi.fn(),
    subscribeMany: vi.fn(),
  } as unknown as RuntimeConfig;
}

function makeTools() {
  return {
    swap: mockSwap,
    getErc20Balance: mockGetErc20Balance,
  } as any;
}

describe('executeForAsset — RiskGuard, trade recording, error handling', () => {
  let executor: TradeExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    (botState as any).isPaused = false;
    (botState as any).assetBalances = new Map([['USDC', 1000], ['CBBTC', 5]]);
    mockRecentPortfolioAll.mockReturnValue([{ portfolio_usd: 1000 }]);
    mockRecentAssetAll.mockReturnValue([{ price_usd: 10, balance: 5 }]);
    mockSwap.mockResolvedValue({ txHash: '0xabc' });
    executor = new TradeExecutor(makeTools(), makeConfig());
  });

  it('skips when bot is paused', async () => {
    (botState as any).isPaused = true;
    await executor.executeForAsset('CBBTC', 'buy', 'test');
    expect(mockSwap).not.toHaveBeenCalled();
    expect(mockInsertTradeRun).not.toHaveBeenCalled();
  });

  it('blocks when portfolio below floor', async () => {
    mockRecentPortfolioAll.mockReturnValue([{ portfolio_usd: 50 }]);
    await executor.executeForAsset('CBBTC', 'buy', 'test');
    expect(mockSwap).not.toHaveBeenCalled();
    expect(mockInsertTradeRun).not.toHaveBeenCalled();
  });

  it('blocks buy when position at limit', async () => {
    // position = 10 * 5 = 50, portfolio = 100 => 50% >= 40% limit
    mockRecentPortfolioAll.mockReturnValue([{ portfolio_usd: 100 }]);
    mockRecentAssetAll.mockReturnValue([{ price_usd: 10, balance: 5 }]);
    await executor.executeForAsset('CBBTC', 'buy', 'test');
    expect(mockSwap).not.toHaveBeenCalled();
    expect(mockInsertTradeRun).not.toHaveBeenCalled();
  });

  it('records trade after successful execution', async () => {
    await executor.executeForAsset('CBBTC', 'sell', 'test-reason');
    expect(mockSwap).toHaveBeenCalledTimes(1);
    expect(mockInsertTradeRun).toHaveBeenCalledTimes(1);
    const tradeArg = mockInsertTradeRun.mock.calls[0][0];
    expect(tradeArg.action).toBe('sell');
    expect(tradeArg.triggered_by).toBe('asset-strategy');
    expect(tradeArg.status).toBe('executed');
    expect(tradeArg.reason).toBe('test-reason');
  });

  it('handles swap failure gracefully', async () => {
    mockSwap.mockRejectedValue(new Error('network error'));
    await executor.executeForAsset('CBBTC', 'sell', 'test');
    // Should NOT throw — error is caught
    expect(mockInsertTradeRun).toHaveBeenCalledTimes(1);
    const tradeArg = mockInsertTradeRun.mock.calls[0][0];
    expect(tradeArg.status).toBe('failed');
  });

  it('allows sell even when position at limit', async () => {
    // Position limit only blocks buys, not sells
    mockRecentPortfolioAll.mockReturnValue([{ portfolio_usd: 100 }]);
    mockRecentAssetAll.mockReturnValue([{ price_usd: 10, balance: 5 }]);
    await executor.executeForAsset('CBBTC', 'sell', 'test');
    expect(mockSwap).toHaveBeenCalledTimes(1);
  });

  it('records dry run trade without calling swap', async () => {
    executor = new TradeExecutor(makeTools(), makeConfig({ DRY_RUN: true }));
    await executor.executeForAsset('CBBTC', 'buy', 'test');
    expect(mockSwap).not.toHaveBeenCalled();
    expect(mockInsertTradeRun).toHaveBeenCalledTimes(1);
    const tradeArg = mockInsertTradeRun.mock.calls[0][0];
    expect(tradeArg.dry_run).toBe(1);
  });
});
