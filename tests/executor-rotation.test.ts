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
// C9 needs getTokenAddress() (to resolve a fresh-balance lookup address for registry sell
// symbols like ETH, which have no discovered_assets row) and getErc20Balance() (the fresh
// on-chain balance used to clamp the leg-1 sell amount). Both default to values that never
// clamp/abort so existing test expectations are unaffected unless a test overrides them.
const mockTools = {
  swap: vi.fn().mockResolvedValue({ txHash: '0xabc', status: 'success' }),
  getTokenAddress: vi.fn().mockReturnValue('0xnative'),
  getErc20Balance: vi.fn().mockResolvedValue(1_000_000),
  // Nit1: mirrors the real SwapService.getQuoteImpactPct contract (see src/wallet/swap.ts) —
  // a non-positive spotPriceUsd means "no reliable reference price" and must resolve null
  // (fail-closed), otherwise resolve a fixed low-impact value so the check passes.
  getQuoteImpactPct: vi.fn().mockImplementation(
    async (_addr: string, _amountUsd: number, spotPriceUsd: number) => (spotPriceUsd > 0 ? 0.5 : null)
  ),
};

// Minimal mock for queries
const mockQueries = {
  insertTrade: { run: vi.fn() },
  recentAssetSnapshots: { all: vi.fn().mockReturnValue([{ price_usd: 1.5 }]) },
};

// Minimal mock for discoveredAssetQueries
const mockDiscoveredAssetQueries = {
  getAddressBySymbol: { get: vi.fn().mockReturnValue(undefined) },
  getMemecoinflagBySymbol: { get: vi.fn().mockReturnValue(undefined) },
  getActiveMemecoins: { all: vi.fn().mockReturnValue([]) },
  getAssetBySymbol: { get: vi.fn().mockReturnValue({ shadow_until: null }) },
  getRecentRealizedTrades: { all: vi.fn().mockReturnValue([]) },
  setShadowUntil: { run: vi.fn() },
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
    recentAssetSnapshots: { all: (...args: unknown[]) => mockQueries.recentAssetSnapshots.all(...args) },
    getLatestAssetSnapshot: { get: vi.fn().mockReturnValue(undefined) },
    insertEvent: { run: vi.fn() },
  },
  discoveredAssetQueries: {
    getAddressBySymbol: { get: (...args: unknown[]) => mockDiscoveredAssetQueries.getAddressBySymbol.get(...args) },
    getMemecoinflagBySymbol: { get: (...args: unknown[]) => mockDiscoveredAssetQueries.getMemecoinflagBySymbol.get(...args) },
    getActiveMemecoins: { all: (...args: unknown[]) => mockDiscoveredAssetQueries.getActiveMemecoins.all(...args) },
    getAssetBySymbol: { get: (...args: unknown[]) => mockDiscoveredAssetQueries.getAssetBySymbol.get(...args) },
    getRecentRealizedTrades: { all: (...args: unknown[]) => mockDiscoveredAssetQueries.getRecentRealizedTrades.all(...args) },
    setShadowUntil: { run: (...args: unknown[]) => mockDiscoveredAssetQueries.setShadowUntil.run(...args) },
  },
}));

import { TradeExecutor } from '../src/trading/executor.js';

describe('TradeExecutor.executeRotation()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.lastTradeAt = null;
    mockState.lastPrice = 3000;
    mockState.lastUsdcBalance = 50;
    // mockReset() (not just clearAllMocks) so any unconsumed .mockResolvedValueOnce() entries
    // from a prior test's over-provisioned queue (e.g. a leg 2 value queued but never reached
    // because the rotation returned early) can never leak into the next test's call sequence.
    mockTools.swap.mockReset().mockResolvedValue({ txHash: '0xabc', status: 'success' });
    mockTools.getTokenAddress.mockReturnValue('0xnative');
    mockTools.getErc20Balance.mockResolvedValue(1_000_000);
    mockTools.getQuoteImpactPct.mockReset().mockImplementation(
      async (_addr: string, _amountUsd: number, spotPriceUsd: number) => (spotPriceUsd > 0 ? 0.5 : null)
    );
    mockDiscoveredAssetQueries.getAddressBySymbol.get.mockReturnValue(undefined);
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
    // Leg 1: swap(sellSymbol, 'USDC', sellTokenAmount, sellAddr)
    expect(mockTools.swap).toHaveBeenNthCalledWith(1, 'ETH', 'USDC', expect.any(String), undefined);
    // Leg 2: swap('USDC', buySymbol, leg2Amount, undefined, buyAddr)
    expect(mockTools.swap).toHaveBeenNthCalledWith(2, 'USDC', 'CBBTC', expect.any(String), undefined, undefined);
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

  it('passes discovered-token address to swap for non-registry symbols', async () => {
    mockDiscoveredAssetQueries.getAddressBySymbol.get.mockReturnValue({ address: '0xtoken456' });
    mockTools.swap
      .mockResolvedValueOnce({ txHash: '0xsell', status: 'success' })
      .mockResolvedValueOnce({ txHash: '0xbuy', status: 'success' });

    const rc = makeRc({ DRY_RUN: false });
    const executor = new TradeExecutor(mockTools as any, rc as any);
    const result = await executor.executeRotation('MYTOKEN', 'USDC', 3);

    expect(result.status).toBe('executed');
    expect(mockTools.swap).toHaveBeenNthCalledWith(1, 'MYTOKEN', 'USDC', expect.any(String), '0xtoken456');
  });

  // C9 — clamp leg-1 sell amount to the real on-chain balance
  it('C9: aborts leg 1 cleanly when the fresh on-chain sell balance is ~0', async () => {
    mockTools.getErc20Balance.mockResolvedValueOnce(0);

    const rc = makeRc({ DRY_RUN: false });
    const executor = new TradeExecutor(mockTools as any, rc as any);
    const result = await executor.executeRotation('ETH', 'CBBTC', 0.05);

    expect(result.status).toBe('failed');
    expect(result.failureReason).toMatch(/on-chain balance/);
    expect(mockTools.swap).not.toHaveBeenCalled();
  });

  it('C9: clamps leg-1 sell amount down to the fresh on-chain balance when lower than intended', async () => {
    // Sell side is CBETH (an ERC20, not native ETH) so this test isolates C9's balance clamp
    // from Nit2's ETH-only gas reserve, which is covered by its own tests below.
    // Intended sellTokenAmount = 0.05 / 1.5 (mocked asset price) ≈ 0.0333 — fresh balance is smaller.
    mockTools.getErc20Balance.mockResolvedValueOnce(0.00001);
    mockTools.swap
      .mockResolvedValueOnce({ txHash: '0xsell', status: 'success' })
      .mockResolvedValueOnce({ txHash: '0xbuy', status: 'success' });

    const rc = makeRc({ DRY_RUN: false });
    const executor = new TradeExecutor(mockTools as any, rc as any);
    const result = await executor.executeRotation('CBETH', 'CBBTC', 0.05);

    expect(result.status).toBe('executed');
    const sellAmountArg = mockTools.swap.mock.calls[0][2] as string;
    expect(parseFloat(sellAmountArg)).toBeCloseTo(0.00001, 8);
  });

  // Nit2 — reserve a small ETH buffer for gas when C9 clamps a native-ETH sell leg
  describe('Nit2: gas reserve on native-ETH sell clamp', () => {
    it('subtracts the gas reserve from the fresh ETH balance when clamping', async () => {
      // sellAmountUsd=3000 at price=3000 => intended sellTokenAmount = 1 ETH.
      // Fresh on-chain balance is 0.5 ETH — below intended, so it clamps, but the clamped
      // amount must be (0.5 - GAS_RESERVE_ETH), not the full 0.5. Give leg 2 plenty of mocked
      // USDC so the (unrelated) leg-2 insufficient-balance guard doesn't short-circuit first.
      mockState.lastUsdcBalance = 10_000;
      mockTools.getErc20Balance.mockResolvedValueOnce(0.5);
      mockTools.swap
        .mockResolvedValueOnce({ txHash: '0xsell', status: 'success' })
        .mockResolvedValueOnce({ txHash: '0xbuy', status: 'success' });

      const rc = makeRc({ DRY_RUN: false });
      const executor = new TradeExecutor(mockTools as any, rc as any);
      const result = await executor.executeRotation('ETH', 'CBBTC', 3000);

      expect(result.status).toBe('executed');
      const sellAmountArg = mockTools.swap.mock.calls[0][2] as string;
      expect(parseFloat(sellAmountArg)).toBeCloseTo(0.5 - 0.0002, 8);
    });

    it('aborts leg 1 cleanly when the ETH balance leaves ~0 after the gas reserve', async () => {
      // Fresh balance (0.0001 ETH) is comfortably > 1e-9 (passes the ~0 check) but smaller
      // than GAS_RESERVE_ETH (0.0002) — nothing usable remains after reserving gas.
      mockTools.getErc20Balance.mockResolvedValueOnce(0.0001);

      const rc = makeRc({ DRY_RUN: false });
      const executor = new TradeExecutor(mockTools as any, rc as any);
      const result = await executor.executeRotation('ETH', 'CBBTC', 0.05);

      expect(result.status).toBe('failed');
      expect(result.failureReason).toMatch(/gas reserve/);
      expect(mockTools.swap).not.toHaveBeenCalled();
    });

    it('does not reserve gas for an ERC20 (non-ETH) sell leg', async () => {
      // Same shape as the gas-reserve-subtraction test above but selling CBETH instead of ETH —
      // the clamp must land exactly on the fresh balance, with nothing subtracted for gas.
      mockState.lastUsdcBalance = 10_000;
      mockTools.getErc20Balance.mockResolvedValueOnce(0.5);
      mockTools.swap
        .mockResolvedValueOnce({ txHash: '0xsell', status: 'success' })
        .mockResolvedValueOnce({ txHash: '0xbuy', status: 'success' });

      const rc = makeRc({ DRY_RUN: false });
      const executor = new TradeExecutor(mockTools as any, rc as any);
      const result = await executor.executeRotation('CBETH', 'CBBTC', 3000);

      expect(result.status).toBe('executed');
      const sellAmountArg = mockTools.swap.mock.calls[0][2] as string;
      expect(parseFloat(sellAmountArg)).toBeCloseTo(0.5, 8);
    });
  });

  // Nit1 — rotation leg-2 slippage spot read must respect the same 30-min freshness window
  // as C1's single-asset BUY guard. checkSlippage() only runs for a non-registry buy target
  // with a resolvable address, so buySymbol is a discovered token throughout this block.
  describe('Nit1: rotation leg-2 slippage freshness gate', () => {
    beforeEach(() => {
      mockDiscoveredAssetQueries.getAddressBySymbol.get.mockReturnValue({ address: '0xbuytoken' });
    });

    it('vetoes leg 2 when there is no spot snapshot at all (missing = fail-closed)', async () => {
      const { queries } = await import('../src/data/db.js');
      (queries.getLatestAssetSnapshot.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const rc = makeRc({ DRY_RUN: false });
      const executor = new TradeExecutor(mockTools as any, rc as any);
      const result = await executor.executeRotation('ETH', 'NEWTOKEN', 5);

      expect(result.status).toBe('leg1_done');
      expect(mockTools.getQuoteImpactPct).toHaveBeenCalledWith('0xbuytoken', expect.any(Number), 0);
    });

    it('vetoes leg 2 when the latest spot snapshot is stale (>30 min old)', async () => {
      const { queries } = await import('../src/data/db.js');
      const staleTs = new Date(Date.now() - 31 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      (queries.getLatestAssetSnapshot.get as ReturnType<typeof vi.fn>).mockReturnValue({ price_usd: 2.5, timestamp: staleTs });

      const rc = makeRc({ DRY_RUN: false });
      const executor = new TradeExecutor(mockTools as any, rc as any);
      const result = await executor.executeRotation('ETH', 'NEWTOKEN', 5);

      // A stale snapshot must be treated as spotPriceUsd=0 (unavailable), same as no snapshot —
      // getQuoteImpactPct then returns null and the buy leg is vetoed (fail-closed).
      expect(result.status).toBe('leg1_done');
      expect(mockTools.getQuoteImpactPct).toHaveBeenCalledWith('0xbuytoken', expect.any(Number), 0);
    });

    it('allows leg 2 when the latest spot snapshot is fresh (<30 min old)', async () => {
      const { queries } = await import('../src/data/db.js');
      const freshTs = new Date(Date.now() - 5 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      (queries.getLatestAssetSnapshot.get as ReturnType<typeof vi.fn>).mockReturnValue({ price_usd: 2.5, timestamp: freshTs });
      mockTools.swap
        .mockResolvedValueOnce({ txHash: '0xsell', status: 'success' })
        .mockResolvedValueOnce({ txHash: '0xbuy', status: 'success' });

      const rc = makeRc({ DRY_RUN: false });
      const executor = new TradeExecutor(mockTools as any, rc as any);
      const result = await executor.executeRotation('ETH', 'NEWTOKEN', 5);

      expect(result.status).toBe('executed');
      expect(mockTools.getQuoteImpactPct).toHaveBeenCalledWith('0xbuytoken', expect.any(Number), 2.5);
    });
  });

  // C8 — size leg 2 from measured leg-1 proceeds, not the intended amount
  it('C8: sizes leg 2 from measured leg-1 USDC proceeds rather than the intended sellAmountUsd', async () => {
    const localTools = {
      ...mockTools,
      swap: vi.fn()
        .mockResolvedValueOnce({ txHash: '0xsell', status: 'success' })
        .mockResolvedValueOnce({ txHash: '0xbuy', status: 'success' }),
      // before leg 1 = 50, after leg 1 = 53.5 → measured proceeds = 3.5 (not 20 * 0.98 = 19.6)
      getErc20BalanceBySymbol: vi.fn()
        .mockResolvedValueOnce(50)
        .mockResolvedValueOnce(53.5)
        .mockResolvedValue(53.5),
    };

    const rc = makeRc({ DRY_RUN: false });
    const executor = new TradeExecutor(localTools as any, rc as any);
    const result = await executor.executeRotation('ETH', 'CBBTC', 20);

    expect(result.status).toBe('executed');
    const buyAmountArg = localTools.swap.mock.calls[1][2] as string;
    expect(parseFloat(buyAmountArg)).toBeCloseTo(3.43, 6); // 3.5 * 0.98
    expect(result.actualBuyUsd).toBeCloseTo(3.43, 6);
  });

  // C8-followup: swap() now settles on-chain before returning. A reverted tx comes back as
  // status:'failed' WITHOUT throwing — the rotation must abort, not proceed to leg 2.
  it('C8-followup: aborts rotation when leg 1 reverts on-chain (status:failed, no throw)', async () => {
    mockTools.swap.mockResolvedValueOnce({ txHash: '0xreverted', status: 'failed' });

    const rc = makeRc({ DRY_RUN: false });
    const executor = new TradeExecutor(mockTools as any, rc as any);
    const result = await executor.executeRotation('ETH', 'CBBTC', 0.05);

    expect(result.status).toBe('failed');
    expect(result.sellTxHash).toBe('0xreverted');
    expect(result.failureReason).toMatch(/reverted/);
    // Leg 1 reverted — leg 2 must never be attempted.
    expect(mockTools.swap).toHaveBeenCalledTimes(1);
  });

  // C8-followup: a leg-2 revert must leave the rotation leg1_done (leg 1's proceeds are
  // already safely in USDC), not record a phantom buy fill.
  it('C8-followup: leaves rotation leg1_done when leg 2 reverts on-chain (status:failed, no throw)', async () => {
    mockTools.swap
      .mockResolvedValueOnce({ txHash: '0xsell', status: 'success' })
      .mockResolvedValueOnce({ txHash: '0xreverted', status: 'failed' });

    const rc = makeRc({ DRY_RUN: false });
    const executor = new TradeExecutor(mockTools as any, rc as any);
    const result = await executor.executeRotation('ETH', 'CBBTC', 0.05);

    expect(result.status).toBe('leg1_done');
    expect(result.sellTxHash).toBe('0xsell');
    expect(result.buyTxHash).toBe('0xreverted');
    expect(mockState.recordTrade).toHaveBeenCalled();
  });

  it('C8: falls back to sellAmountUsd-based sizing on skipLeg1 recovery (no leg-1 delta to measure)', async () => {
    mockTools.swap.mockResolvedValueOnce({ txHash: '0xbuy', status: 'success' });

    const rc = makeRc({ DRY_RUN: false });
    const executor = new TradeExecutor(mockTools as any, rc as any);
    const result = await executor.executeRotation('ETH', 'CBBTC', 10, 42, true);

    expect(result.status).toBe('executed');
    // No leg-1 swap in recovery mode — the only swap call is leg 2, sized off sellAmountUsd.
    expect(mockTools.swap).toHaveBeenCalledTimes(1);
    const buyAmountArg = mockTools.swap.mock.calls[0][2] as string;
    expect(parseFloat(buyAmountArg)).toBeCloseTo(9.8, 6); // 10 * 0.98
  });
});
