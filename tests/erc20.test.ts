import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── vi.hoisted ensures these are available when vi.mock factory runs ──
const { mockGetBalance, mockReadContract } = vi.hoisted(() => ({
  mockGetBalance: vi.fn(),
  mockReadContract: vi.fn(),
}));

vi.mock('viem', () => ({
  createPublicClient: vi.fn().mockReturnValue({
    getBalance: mockGetBalance,
    readContract: mockReadContract,
  }),
  http: vi.fn().mockReturnValue({}),
}));

vi.mock('viem/chains', () => ({
  base: { id: 8453, name: 'Base' },
  baseSepolia: { id: 84532, name: 'Base Sepolia' },
}));

import { getTokenBalance } from '../src/wallet/erc20.js';

const ETH_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ERC20_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WALLET       = '0xWalletAddress000000000000000000000000001';

describe('getTokenBalance (Erc20Reader)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ETH sentinel → calls getBalance and returns human-readable float', async () => {
    mockGetBalance.mockResolvedValue(1500000000000000000n); // 1.5 ETH in wei

    const result = await getTokenBalance(ETH_SENTINEL, WALLET, 'base-mainnet', 18);

    expect(mockGetBalance).toHaveBeenCalledWith({ address: WALLET });
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(result).toBeCloseTo(1.5);
  });

  it('ERC20 address → calls readContract balanceOf and returns human-readable float', async () => {
    // readContract called twice: decimals then balanceOf
    mockReadContract
      .mockResolvedValueOnce(6)            // decimals
      .mockResolvedValueOnce(5000000n);    // balanceOf (5 USDC = 5_000_000 with 6 decimals)

    const result = await getTokenBalance(ERC20_ADDRESS, WALLET, 'base-mainnet');

    expect(mockReadContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'decimals' }),
    );
    expect(mockReadContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'balanceOf' }),
    );
    expect(result).toBeCloseTo(5);
  });

  it('ERC20 with provided decimals skips decimals readContract call', async () => {
    mockReadContract.mockResolvedValueOnce(1000000n); // only balanceOf

    const result = await getTokenBalance(ERC20_ADDRESS, WALLET, 'base-mainnet', 6);

    expect(mockReadContract).toHaveBeenCalledTimes(1);
    expect(result).toBeCloseTo(1);
  });
});
