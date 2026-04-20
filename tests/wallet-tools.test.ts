import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── vi.hoisted for mock values referenced inside vi.mock factories ──
const { mockGetTokenBalance, mockSwapServiceSwap } = vi.hoisted(() => ({
  mockGetTokenBalance: vi.fn(),
  mockSwapServiceSwap: vi.fn(),
}));

vi.mock('../src/wallet/erc20.js', () => ({
  getTokenBalance: mockGetTokenBalance,
}));

vi.mock('../src/wallet/swap.js', () => ({
  SwapService: function MockSwapService() {
    return {
      swap: mockSwapServiceSwap,
      getSwapPrice: vi.fn(),
    };
  },
}));

vi.mock('../src/wallet/prices.js', () => ({
  fetchPriceFeedId: vi.fn(),
  fetchPrice: vi.fn(),
  getTokenPrices: vi.fn(),
}));

vi.mock('../src/assets/registry.js', () => ({
  ASSET_REGISTRY: [
    { symbol: 'CBBTC', addresses: { 'base-mainnet': '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf' }, decimals: 8 },
    { symbol: 'ETH',   addresses: { 'base-mainnet': '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }, decimals: 18 },
  ],
}));

vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { CoinbaseTools } from '../src/wallet/tools.js';

function makeWalletClient(address = '0xWallet000000000000000000000000000000001', network = 'base-mainnet') {
  return { address, network, account: {}, sdk: { evm: {} } } as any;
}

describe('CoinbaseTools', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('getWalletDetails — ETH balance', () => {
    it('returns ETH balance as string', async () => {
      mockGetTokenBalance.mockResolvedValue(1.23);
      const tools = new CoinbaseTools(makeWalletClient());
      const details = await tools.getWalletDetails();
      expect(details.balance).toBe('1.23');
      expect(mockGetTokenBalance).toHaveBeenCalledWith(
        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        expect.any(String),
        'base-mainnet',
        18,
      );
    });

    it('throws when wallet address is null', async () => {
      const wc = makeWalletClient();
      wc.address = null;
      const tools = new CoinbaseTools(wc);
      await expect(tools.getWalletDetails()).rejects.toThrow('Wallet not initialised');
    });
  });

  describe('swap — ETH → USDC', () => {
    it('calls SwapService.swap with resolved token addresses', async () => {
      mockSwapServiceSwap.mockResolvedValue({ txHash: '0xtx1', status: 'executed' });
      const tools = new CoinbaseTools(makeWalletClient());

      const result = await tools.swap('ETH', 'USDC', '0.5');

      expect(mockSwapServiceSwap).toHaveBeenCalledWith(
        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // ETH address
        expect.stringMatching(/^0x/),                // USDC address
        '0.5',
        'base-mainnet',
      );
      expect(result.txHash).toBe('0xtx1');
    });
  });

  describe('swap — USDC → ETH', () => {
    it('calls SwapService.swap with USDC as fromToken', async () => {
      mockSwapServiceSwap.mockResolvedValue({ txHash: '0xtx2', status: 'executed' });
      const tools = new CoinbaseTools(makeWalletClient());

      await tools.swap('USDC', 'ETH', '100');

      expect(mockSwapServiceSwap).toHaveBeenCalledWith(
        expect.stringMatching(/^0x/),                // USDC address
        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // ETH address
        '100',
        'base-mainnet',
      );
    });
  });
});
