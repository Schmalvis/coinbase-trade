import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetAccount, mockGetOrCreateAccount } = vi.hoisted(() => ({
  mockGetAccount: vi.fn(),
  mockGetOrCreateAccount: vi.fn(),
}));

vi.mock('@coinbase/cdp-sdk', () => ({
  CdpClient: function MockCdpClient() {
    return {
      evm: {
        getAccount: mockGetAccount,
        getOrCreateAccount: mockGetOrCreateAccount,
      },
    };
  },
}));

vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { CdpWalletClient } from '../src/wallet/client.js';

describe('CdpWalletClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('init() with walletAddress calls getAccount and sets _address', async () => {
    const knownAddress = '0xABCDEF1234567890abcdef1234567890abcdef12';
    mockGetAccount.mockResolvedValue({ address: knownAddress });

    const client = new CdpWalletClient('key-id', 'key-secret', 'wallet-secret', 'base-sepolia', knownAddress);
    const result = await client.init();

    expect(mockGetAccount).toHaveBeenCalledWith({ address: knownAddress });
    expect(mockGetOrCreateAccount).not.toHaveBeenCalled();
    expect(result).toBe(knownAddress);
    expect(client.address).toBe(knownAddress);
  });

  it('init() without walletAddress calls getOrCreateAccount', async () => {
    const derivedAddress = '0x1111111111111111111111111111111111111111';
    mockGetOrCreateAccount.mockResolvedValue({ address: derivedAddress });

    const client = new CdpWalletClient('key-id', 'key-secret', 'wallet-secret', 'base-sepolia');
    const result = await client.init();

    expect(mockGetOrCreateAccount).toHaveBeenCalledWith({ name: 'coinbase-trade-bot' });
    expect(mockGetAccount).not.toHaveBeenCalled();
    expect(result).toBe(derivedAddress);
    expect(client.address).toBe(derivedAddress);
  });

  it('network getter returns initial network', () => {
    const client = new CdpWalletClient('k', 's', 'ws', 'base-mainnet');
    expect(client.network).toBe('base-mainnet');
  });

  it('network setter updates the network', () => {
    const client = new CdpWalletClient('k', 's', 'ws', 'base-sepolia');
    client.network = 'base-mainnet';
    expect(client.network).toBe('base-mainnet');
  });
});
