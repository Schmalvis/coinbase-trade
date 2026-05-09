import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock viem (used by SwapService.getDecimals for unknown tokens) ──
vi.mock('viem', () => ({
  createPublicClient: vi.fn().mockReturnValue({
    readContract: vi.fn().mockResolvedValue(18),
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

import { SwapService } from '../src/wallet/swap.js';

// Known addresses — decimals come from TOKEN_DECIMALS cache in swap.ts
const ETH_ADDR  = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; // 18 dec
const USDC_ADDR = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'; // 6 dec

function makeWalletClient(address = '0xWallet00000000000000000000000000000001') {
  const mockSwap = vi.fn().mockResolvedValue({ transactionHash: '0xtxHash' });
  const mockGetSwapPrice = vi.fn().mockResolvedValue({
    toAmount: 3000000000n, // 3000 USDC (6 decimals) in bigint
    liquidityAvailable: true,
  });
  const mockSendTransaction = vi.fn().mockResolvedValue({ transactionHash: '0x0xFallbackHash' });
  const account = { swap: mockSwap };
  const sdk = { evm: { getSwapPrice: mockGetSwapPrice, sendTransaction: mockSendTransaction } };
  return { address, account, sdk, network: 'base-mainnet', mockSwap, mockGetSwapPrice, mockSendTransaction };
}

describe('SwapService.swap', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => {
    delete process.env.NISHVAULT_PRE_SEND_GUARD;
    delete process.env.NISHVAULT_PRE_SEND_TIMEOUT_MS;
    delete process.env.NISHVAULT_SELLER_URL;
    delete process.env.ZEROX_API_KEY;
    vi.unstubAllGlobals();
  });

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
  });

  it('throws when wallet is not initialised', async () => {
    const wc = makeWalletClient();
    (wc as any).account = null;
    const service = new SwapService(wc as any);
    await expect(service.swap(ETH_ADDR, USDC_ADDR, '1', 'base-mainnet')).rejects.toThrow('Wallet not initialised');
  });

  it('keeps the 0x fallback path unchanged when Nishvault guard is disabled', async () => {
    process.env.ZEROX_API_KEY = 'test-0x-key';
    const wc = makeWalletClient();
    wc.mockSwap.mockRejectedValueOnce(new Error('CDP swap unavailable'));
    const service = new SwapService(wc as any);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        transaction: {
          to: USDC_ADDR,
          data: '0x1234',
          value: '0',
        },
      }),
    }));

    const result = await service.swap(ETH_ADDR, USDC_ADDR, '0.5', 'base-mainnet');

    expect(wc.mockSendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        address: wc.address,
        network: 'base',
        transaction: expect.objectContaining({
          to: USDC_ADDR,
          data: '0x1234',
          value: 0n,
        }),
      }),
    );
    expect(result).toEqual({ txHash: '0x0xFallbackHash', status: 'executed_via_0x' });
  });

  it('requires an explicit Nishvault package install before guarded 0x fallback broadcasts', async () => {
    process.env.ZEROX_API_KEY = 'test-0x-key';
    process.env.NISHVAULT_PRE_SEND_GUARD = '1';
    const wc = makeWalletClient();
    wc.mockSwap.mockRejectedValueOnce(new Error('CDP swap unavailable'));
    const service = new SwapService(wc as any);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        transaction: {
          to: USDC_ADDR,
          data: '0x1234',
          value: '0',
        },
      }),
    }));

    await expect(service.swap(ETH_ADDR, USDC_ADDR, '0.5', 'base-mainnet')).rejects.toThrow(
      'requires `npm install nishvault-preflight-buy`',
    );
    expect(wc.mockSendTransaction).not.toHaveBeenCalled();
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
