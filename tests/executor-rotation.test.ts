import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal mock for RuntimeConfig
function makeRc(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    TRADE_COOLDOWN_SECONDS: 0,
    DRY_RUN: false,
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

// Minimal mock for botState
const mockState = {
  isPaused: false,
  lastTradeAt: null as Date | null,
  lastPrice: 3000,
  lastBalance: 0.1,
  lastUsdcBalance: 50,
  activeNetwork: 'base-sepolia',
  recordTrade: vi.fn(),
  emitTrade: vi.fn(),
};

// Minimal mock for tools
const mockTools = {
  swap: vi.fn().mockResolvedValue({ txHash: '0xabc', status: 'success' }),
};

// Minimal mock for queries
const mockQueries = {
  insertTrade: { run: vi.fn() },
};

vi.mock('../src/core/state.js', () => ({
  botState: {
    get isPaused() { return mockState.isPaused; },
    get lastTradeAt() { return mockState.lastTradeAt; },
    get lastPrice() { return mockState.lastPrice; },
    get lastBalance() { return mockState.lastBalance; },
    get lastUsdcBalance() { return mockState.lastUsdcBalance; },
    get activeNetwork() { return mockState.activeNetwork; },
    recordTrade: (...args: unknown[]) => mockState.recordTrade(...args),
    emitTrade: (...args: unknown[]) => mockState.emitTrade(...args),
  },
}));
vi.mock('../src/data/db.js', () => ({
  queries: {
    insertTrade: { run: (...args: unknown[]) => mockQueries.insertTrade.run(...args) },
  },
}));

import { TradeExecutor } from '../src/trading/executor.js';

describe('TradeExecutor.executeRotation()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.lastTradeAt = null;
    mockState.lastPrice = 3000;
    mockState.lastUsdcBalance = 50;
    mockTools.swap.mockResolvedValue({ txHash: '0xabc', status: 'success' });
  });

  it('executes both legs and returns executed with tx hashes', async () => {
    mockTools.swap
      .mockResolvedValueOnce({ txHash: '0xsell', status: 'success' })
      .mockResolvedValueOnce({ txHash: '0xbuy', status: 'success' });

    const rc = makeRc({ DRY_RUN: false });
    const executor = new TradeExecutor(mockTools as any, rc as any);
    const result = await executor.executeRotation('ETH', 'CBBTC', 0.05);

    expect(result.status).toBe('executed');
    expect(result.sellTxHash).toBe('0xsell');
    expect(result.buyTxHash).toBe('0xbuy');
    expect(mockTools.swap).toHaveBeenCalledTimes(2);
    expect(mockTools.swap).toHaveBeenNthCalledWith(1, 'ETH', 'USDC', '0.05');
    expect(mockTools.swap).toHaveBeenNthCalledWith(2, 'USDC', 'CBBTC', expect.any(String));
  });

  it('returns leg1_done when sell succeeds but buy fails', async () => {
    mockTools.swap
      .mockResolvedValueOnce({ txHash: '0xsell', status: 'success' })
      .mockRejectedValueOnce(new Error('buy failed'));

    const rc = makeRc({ DRY_RUN: false });
    const executor = new TradeExecutor(mockTools as any, rc as any);
    const result = await executor.executeRotation('ETH', 'CBBTC', 0.05);

    expect(result.status).toBe('leg1_done');
    expect(result.sellTxHash).toBe('0xsell');
    expect(result.buyTxHash).toBeUndefined();
  });

  it('returns failed when sell fails', async () => {
    mockTools.swap.mockRejectedValueOnce(new Error('sell failed'));

    const rc = makeRc({ DRY_RUN: false });
    const executor = new TradeExecutor(mockTools as any, rc as any);
    const result = await executor.executeRotation('ETH', 'CBBTC', 0.05);

    expect(result.status).toBe('failed');
    expect(result.sellTxHash).toBeUndefined();
    expect(result.buyTxHash).toBeUndefined();
    expect(mockTools.swap).toHaveBeenCalledTimes(1);
  });

  it('DRY_RUN mode simulates without calling swap', async () => {
    const rc = makeRc({ DRY_RUN: true });
    const executor = new TradeExecutor(mockTools as any, rc as any);
    const result = await executor.executeRotation('ETH', 'CBBTC', 0.05);

    expect(result.status).toBe('executed');
    expect(result.sellTxHash).toBeUndefined();
    expect(result.buyTxHash).toBeUndefined();
    expect(mockTools.swap).not.toHaveBeenCalled();
  });

  it('calls recordTrade (sets cooldown) after completion', async () => {
    mockTools.swap.mockResolvedValue({ txHash: '0xabc', status: 'success' });

    const rc = makeRc({ DRY_RUN: false });
    const executor = new TradeExecutor(mockTools as any, rc as any);
    await executor.executeRotation('ETH', 'CBBTC', 0.05);

    expect(mockState.recordTrade).toHaveBeenCalledWith(expect.any(Date));
  });

  it('returns leg1_done when USDC balance is zero after sell', async () => {
    mockState.lastUsdcBalance = 0;
    mockTools.swap.mockResolvedValueOnce({ txHash: '0xsell', status: 'success' });

    const rc = makeRc({ DRY_RUN: false });
    const executor = new TradeExecutor(mockTools as any, rc as any);
    const result = await executor.executeRotation('ETH', 'CBBTC', 0.05);

    expect(result.status).toBe('leg1_done');
    expect(result.sellTxHash).toBe('0xsell');
    expect(mockState.recordTrade).toHaveBeenCalled();
  });
});
