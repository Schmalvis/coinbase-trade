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

describe('executeForAsset — position lifecycle on swap failure', () => {
  let executor: TradeExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    (botState as any).isPaused = false;
    (botState as any).assetBalances = new Map([['CBBTC', 0.001]]);
    mockRecentPortfolioAll.mockReturnValue([{ portfolio_usd: 1000 }]);
    mockRecentAssetAll.mockReturnValue([{ price_usd: 66000, balance: 0.001 }]);
  });

  it('preserves open position entry price when swap fails', async () => {
    mockSwap.mockRejectedValue(new Error('RPC timeout'));
    executor = new TradeExecutor(makeTools(), makeConfig());
    // Establish open position
    (executor as any)._openPositions.set('CBBTC', { entryPrice: 66000, qty: 0.00003 });

    await executor.executeForAsset('CBBTC', 'sell', 'test-fail');

    // Position must still exist — swap never confirmed
    expect((executor as any)._openPositions.has('CBBTC')).toBe(true);
  });

  it('does not record realized_pnl when swap fails', async () => {
    mockSwap.mockRejectedValue(new Error('RPC timeout'));
    executor = new TradeExecutor(makeTools(), makeConfig());
    (executor as any)._openPositions.set('CBBTC', { entryPrice: 66000, qty: 0.00003 });

    await executor.executeForAsset('CBBTC', 'sell', 'test-fail');

    expect(mockInsertTradeRun).toHaveBeenCalledTimes(1);
    const recorded = mockInsertTradeRun.mock.calls[0][0];
    expect(recorded?.realized_pnl).toBeNull();
  });
});

describe('executeForAsset sanity check — multi-asset portfolio', () => {
  let executor: TradeExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    (botState as any).isPaused = false;
    // Portfolio is 100% CBBTC — ETH/USDC balances are near zero
    (botState as any).lastBalance = 0;
    (botState as any).lastUsdcBalance = 0;
    (botState as any).lastPrice = 0;
    // But we have CBBTC balance to sell
    (botState as any).assetBalances = new Map([['CBBTC', 0.001]]);
    // portfolio_snapshot shows $200 (authoritative)
    mockRecentPortfolioAll.mockReturnValue([{ portfolio_usd: 200 }]);
    // asset snapshot: CBBTC at $100k, so 10% of 0.001 = 0.0001 CBBTC = $10 trade
    mockRecentAssetAll.mockReturnValue([{ price_usd: 100000, balance: 0.001 }]);
    mockSwap.mockResolvedValue({ txHash: '0xabc' });
    executor = new TradeExecutor(makeTools(), makeConfig());
  });

  it('allows trade when portfolio_snapshot shows sufficient value even if ETH+USDC is near zero', async () => {
    // Trade value = 0.001 * 0.1 * 100000 = $10, portfolio_usd = $200
    // $10 < $400 (2x $200), so should NOT be blocked
    await executor.executeForAsset('CBBTC', 'sell', 'test-sanity');
    // If blocked by sanity cap, insertTrade would not be called
    expect(mockInsertTradeRun).toHaveBeenCalled();
  });
});
