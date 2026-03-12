import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal mock for RuntimeConfig
function makeRc(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    TRADE_COOLDOWN_SECONDS: 0,
    DRY_RUN: true,
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

// We import the class and inject mocks via constructor
// (since executor imports botState/queries as singletons we need to either
//  refactor to inject or use vi.mock. We use vi.mock here for simplicity.)
vi.mock('../src/core/state.js', () => ({
  botState: {
    get isPaused() { return mockState.isPaused; },
    get lastTradeAt() { return mockState.lastTradeAt; },
    get lastPrice() { return mockState.lastPrice; },
    get lastBalance() { return mockState.lastBalance; },
    get lastUsdcBalance() { return mockState.lastUsdcBalance; },
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

describe('TradeExecutor.executeManual()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.lastTradeAt = null;
    mockState.lastPrice = 3000;
  });

  it('executes a dry-run trade without calling swap', async () => {
    const rc = makeRc({ DRY_RUN: true });
    const executor = new TradeExecutor(mockTools as any, rc as any);
    const result = await executor.executeManual('ETH', 'USDC', '0.01');
    expect(mockTools.swap).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(mockQueries.insertTrade.run).toHaveBeenCalledOnce();
  });

  it('calls swap when not dry-run', async () => {
    const rc = makeRc({ DRY_RUN: false });
    const executor = new TradeExecutor(mockTools as any, rc as any);
    const result = await executor.executeManual('ETH', 'USDC', '0.01');
    expect(mockTools.swap).toHaveBeenCalledWith('ETH', 'USDC', '0.01');
    expect(result.txHash).toBe('0xabc');
  });

  it('throws when cooldown is active', async () => {
    const rc = makeRc({ DRY_RUN: true, TRADE_COOLDOWN_SECONDS: 300 });
    mockState.lastTradeAt = new Date(); // just traded
    const executor = new TradeExecutor(mockTools as any, rc as any);
    await expect(executor.executeManual('ETH', 'USDC', '0.01')).rejects.toThrow('Cooldown active');
  });

  it('stores amount_eth correctly for ETH→USDC trade', async () => {
    const rc = makeRc({ DRY_RUN: true });
    const executor = new TradeExecutor(mockTools as any, rc as any);
    await executor.executeManual('ETH', 'USDC', '0.05');
    const callArg = mockQueries.insertTrade.run.mock.calls[0][0] as any;
    expect(callArg.amount_eth).toBeCloseTo(0.05);
  });

  it('stores amount_eth correctly for USDC→ETH trade (divides by price)', async () => {
    const rc = makeRc({ DRY_RUN: true });
    mockState.lastPrice = 3000;
    const executor = new TradeExecutor(mockTools as any, rc as any);
    await executor.executeManual('USDC', 'ETH', '30');
    const callArg = mockQueries.insertTrade.run.mock.calls[0][0] as any;
    expect(callArg.amount_eth).toBeCloseTo(30 / 3000);
  });
});
