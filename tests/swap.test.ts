import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock viem (used by SwapService.getDecimals for unknown tokens, and by the new
// C8-followup settlement wait via src/wallet/erc20.js's shared getPublicClient) ──
const mockWaitForTransactionReceipt = vi.fn().mockResolvedValue({ status: 'success' });
vi.mock('viem', () => ({
  createPublicClient: vi.fn().mockReturnValue({
    readContract: vi.fn().mockResolvedValue(18),
    waitForTransactionReceipt: (...args: unknown[]) => mockWaitForTransactionReceipt(...args),
  }),
  http: vi.fn().mockReturnValue({}),
}));

vi.mock('viem/chains', () => ({
  base: { id: 8453 },
  baseSepolia: { id: 84532 },
}));

vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// swap.ts's waitForSettlement degrade path emits a bot_event + Telegram alert (batch fix) —
// mock these out so tests never touch the real on-disk DB (default DATA_DIR points at the
// live bot's data directory) or a real alert bus.
const mockInsertEventRun = vi.hoisted(() => vi.fn());
const mockEmitAlert = vi.hoisted(() => vi.fn());
vi.mock('../src/data/db.js', () => ({
  queries: { insertEvent: { run: mockInsertEventRun } },
}));
vi.mock('../src/core/state.js', () => ({
  botState: { emitAlert: mockEmitAlert },
}));

import { SwapService } from '../src/wallet/swap.js';
import { logger } from '../src/core/logger.js';

// Known addresses — decimals come from TOKEN_DECIMALS cache in swap.ts
const ETH_ADDR  = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; // 18 dec
const USDC_ADDR = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'; // 6 dec

function makeWalletClient(address = '0xWallet00000000000000000000000000000001') {
  const mockSwap = vi.fn().mockResolvedValue({ transactionHash: '0xtxHash' });
  const mockGetSwapPrice = vi.fn().mockResolvedValue({
    toAmount: 3000000000n, // 3000 USDC (6 decimals) in bigint
    liquidityAvailable: true,
  });
  const account = { swap: mockSwap };
  const sdk = { evm: { getSwapPrice: mockGetSwapPrice } };
  return { address, account, sdk, network: 'base-mainnet', mockSwap, mockGetSwapPrice };
}

describe('SwapService.swap', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls account.swap with correct BigInt amount and returns txHash', async () => {
    const wc = makeWalletClient();
    const service = new SwapService(wc as any);

    const result = await service.swap(ETH_ADDR, USDC_ADDR, '0.5', 'base-mainnet');

    expect(wc.mockSwap).toHaveBeenCalledWith(
      expect.objectContaining({
        network: 'base',
        fromToken: ETH_ADDR,
        toToken: USDC_ADDR,
        fromAmount: 500000000000000000n, // 0.5 ETH in wei
      }),
    );
    expect(result.txHash).toBe('0xtxHash');
    expect(result.status).toBe('executed');
    // C8-followup: swap() must wait for the on-chain receipt before returning.
    expect(mockWaitForTransactionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ hash: '0xtxHash' }),
    );
  });

  // C8-followup: a tx that mines but reverts must be reported as 'failed', not 'executed' —
  // otherwise callers record a phantom fill/P&L for a swap that moved no funds.
  it('returns status:failed when the swap tx reverts on-chain', async () => {
    mockWaitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted' });
    const wc = makeWalletClient();
    const service = new SwapService(wc as any);

    const result = await service.swap(ETH_ADDR, USDC_ADDR, '0.5', 'base-mainnet');

    expect(result.txHash).toBe('0xtxHash');
    expect(result.status).toBe('failed');
  });

  // C8-followup: a timeout/error fetching the receipt must not hang or crash — best-effort
  // degrade to 'executed' (matches pre-existing behavior for the rare un-mined case).
  it('degrades to status:executed when the receipt wait times out/errors', async () => {
    mockWaitForTransactionReceipt.mockRejectedValueOnce(new Error('timeout'));
    const wc = makeWalletClient();
    const service = new SwapService(wc as any);

    const result = await service.swap(ETH_ADDR, USDC_ADDR, '0.5', 'base-mainnet');

    expect(result.txHash).toBe('0xtxHash');
    expect(result.status).toBe('executed');
  });

  // batch fix: the settlement-timeout degrade must not fail silently — it must surface a
  // bot_event + Telegram alert so an operator can manually verify the unconfirmed tx.
  it('emits a bot_event and Telegram alert on settlement-timeout degrade', async () => {
    mockWaitForTransactionReceipt.mockRejectedValueOnce(new Error('timeout'));
    const wc = makeWalletClient();
    const service = new SwapService(wc as any);

    await service.swap(ETH_ADDR, USDC_ADDR, '0.5', 'base-mainnet');

    expect(mockInsertEventRun).toHaveBeenCalledWith(
      'swap_settlement_timeout',
      expect.stringContaining('0xtxHash'),
    );
    expect(mockEmitAlert).toHaveBeenCalledWith(expect.stringContaining('0xtxHash'));
  });

  it('does not emit a bot_event/alert when settlement succeeds normally', async () => {
    const wc = makeWalletClient();
    const service = new SwapService(wc as any);

    await service.swap(ETH_ADDR, USDC_ADDR, '0.5', 'base-mainnet');

    expect(mockInsertEventRun).not.toHaveBeenCalled();
    expect(mockEmitAlert).not.toHaveBeenCalled();
  });

  it('throws when wallet is not initialised', async () => {
    const wc = makeWalletClient();
    (wc as any).account = null;
    const service = new SwapService(wc as any);
    await expect(service.swap(ETH_ADDR, USDC_ADDR, '1', 'base-mainnet')).rejects.toThrow('Wallet not initialised');
  });

  it('uses 150bps slippage for registry swaps', async () => {
    const mockAccount = {
      swap: vi.fn().mockResolvedValue({ transactionHash: '0xabc' }),
    };
    const mockClient = { account: mockAccount, address: '0xwallet', network: 'base-mainnet', sdk: {} };
    const service = new SwapService(mockClient as any);

    // ETH→USDC is a registry swap (both in ASSET_REGISTRY)
    await service.swap(
      '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // ETH
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC mainnet
      '0.01',
      'base-mainnet',
    );

    expect(mockAccount.swap).toHaveBeenCalledWith(
      expect.objectContaining({ slippageBps: 150 }),
    );
  });

  it('uses 200bps slippage for non-registry swaps', async () => {
    const mockAccount = {
      swap: vi.fn().mockResolvedValue({ transactionHash: '0xdef' }),
    };
    const mockClient = { account: mockAccount, address: '0xwallet', network: 'base-mainnet', sdk: {} };
    const service = new SwapService(mockClient as any);

    // Some random ERC20 token (not in registry)
    await service.swap(
      '0x1234000000000000000000000000000000000000',
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      '10',
      'base-mainnet',
    );

    expect(mockAccount.swap).toHaveBeenCalledWith(
      expect.objectContaining({ slippageBps: 200 }),
    );
  });

  it('logs cdp error message (not [object Object]) on swap failure', async () => {
    const mockAccount = {
      swap: vi.fn().mockRejectedValueOnce(new Error('insufficient funds')),
    };
    const mockClient = { account: mockAccount, address: '0xwallet', network: 'base-mainnet', sdk: {} };
    const service = new SwapService(mockClient as any);

    // No 0x fallback key set — ensure the CDP error propagates
    const originalKey = process.env.ZEROX_API_KEY;
    delete process.env.ZEROX_API_KEY;

    await expect(
      service.swap(
        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        '0.01',
        'base-mainnet',
      )
    ).rejects.toThrow('insufficient funds');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('insufficient funds')
    );

    if (originalKey !== undefined) process.env.ZEROX_API_KEY = originalKey;
  });
});

describe('SwapService.getSwapPrice', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls sdk.evm.getSwapPrice and returns a SwapPrice', async () => {
    const wc = makeWalletClient();
    const service = new SwapService(wc as any);

    const price = await service.getSwapPrice(ETH_ADDR, USDC_ADDR, '1', 'base-mainnet');

    expect(wc.mockGetSwapPrice).toHaveBeenCalledWith(
      expect.objectContaining({
        network: 'base',
        fromToken: ETH_ADDR,
        toToken: USDC_ADDR,
        fromAmount: 1000000000000000000n,
        taker: wc.address,
      }),
    );
    expect(price).toMatchObject({
      fromToken: ETH_ADDR,
      toToken: USDC_ADDR,
      fromAmount: '1',
    });
    expect(typeof price.toAmount).toBe('string');
  });

  it('throws when wallet address is null', async () => {
    const wc = makeWalletClient();
    (wc as any).address = null;
    const service = new SwapService(wc as any);
    await expect(service.getSwapPrice(ETH_ADDR, USDC_ADDR, '1', 'base-mainnet')).rejects.toThrow('Wallet not initialised');
  });
});

// S1: getQuoteImpactPct now computes impact via a CDP SDK quote (getSwapPrice, no 0x key)
// compared against a caller-supplied spot price ("quote-vs-spot") — replacing the permanently
// broken 0x v2 estimatedPriceImpact parse.
describe('SwapService.getQuoteImpactPct', () => {
  const TOKEN_ADDR = '0x1234000000000000000000000000000000000000';

  beforeEach(() => { vi.clearAllMocks(); });

  it('computes positive impact % from quote-vs-spot execution price', async () => {
    const wc = makeWalletClient();
    // $2 USDC in → 1.9 tokens out (18 decimals) → execution price 2/1.9 ≈ 1.0526 USDC/token
    wc.mockGetSwapPrice.mockResolvedValue({
      toAmount: 1900000000000000000n,
      liquidityAvailable: true,
    });
    const service = new SwapService(wc as any);

    const impact = await service.getQuoteImpactPct(TOKEN_ADDR, 2, 1 /* spotPriceUsd */);

    expect(impact).not.toBeNull();
    expect(impact as number).toBeCloseTo(5.263, 2);
  });

  it('clamps to 0 when execution price is better than (or equal to) spot', async () => {
    const wc = makeWalletClient();
    // $2 USDC in → 2.5 tokens out → execution price 0.8 USDC/token, spot is 1 → "negative" impact
    wc.mockGetSwapPrice.mockResolvedValue({
      toAmount: 2500000000000000000n,
      liquidityAvailable: true,
    });
    const service = new SwapService(wc as any);

    const impact = await service.getQuoteImpactPct(TOKEN_ADDR, 2, 1);

    expect(impact).toBe(0);
  });

  it('returns null when the quote reports no liquidity', async () => {
    const wc = makeWalletClient();
    wc.mockGetSwapPrice.mockResolvedValue({ toAmount: 0n, liquidityAvailable: false });
    const service = new SwapService(wc as any);

    const impact = await service.getQuoteImpactPct(TOKEN_ADDR, 2, 1);

    expect(impact).toBeNull();
  });

  it('returns null when the quote resolves a zero/invalid toAmount', async () => {
    const wc = makeWalletClient();
    wc.mockGetSwapPrice.mockResolvedValue({ toAmount: 0n, liquidityAvailable: true });
    const service = new SwapService(wc as any);

    const impact = await service.getQuoteImpactPct(TOKEN_ADDR, 2, 1);

    expect(impact).toBeNull();
  });

  it('returns null when the quote call throws', async () => {
    const wc = makeWalletClient();
    wc.mockGetSwapPrice.mockRejectedValue(new Error('rpc error'));
    const service = new SwapService(wc as any);

    const impact = await service.getQuoteImpactPct(TOKEN_ADDR, 2, 1);

    expect(impact).toBeNull();
  });

  it('returns null without calling the SDK when spotPriceUsd is missing/zero', async () => {
    const wc = makeWalletClient();
    const service = new SwapService(wc as any);

    const impact = await service.getQuoteImpactPct(TOKEN_ADDR, 2, 0);

    expect(impact).toBeNull();
    expect(wc.mockGetSwapPrice).not.toHaveBeenCalled();
  });

  it('never calls the 0x HTTP API (no ZEROX_API_KEY needed)', async () => {
    const originalKey = process.env.ZEROX_API_KEY;
    delete process.env.ZEROX_API_KEY;
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    const wc = makeWalletClient();
    wc.mockGetSwapPrice.mockResolvedValue({ toAmount: 1900000000000000000n, liquidityAvailable: true });
    const service = new SwapService(wc as any);

    const impact = await service.getQuoteImpactPct(TOKEN_ADDR, 2, 1);

    expect(impact).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
    if (originalKey !== undefined) process.env.ZEROX_API_KEY = originalKey;
  });
});
