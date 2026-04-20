/**
 * Previously tested MCPClient circuit-breaker behaviour.
 * Rewritten for v2: tests CdpWalletClient resilience — init() error handling.
 * The MCP client and its circuit-breaker were removed in the v2 refactor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockGetOrCreateAccount, mockGetAccount } = vi.hoisted(() => ({
  mockGetOrCreateAccount: vi.fn(),
  mockGetAccount: vi.fn(),
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

import { CdpWalletClient } from '../src/wallet/client.js';

describe('CdpWalletClient resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('init() succeeds on first try', async () => {
    mockGetOrCreateAccount.mockResolvedValue({ address: '0xabc' });
    const client = new CdpWalletClient('k', 's', 'ws', 'base-sepolia');
    const addr = await client.init();
    expect(addr).toBe('0xabc');
  });

  it('init() throws when CDP SDK rejects', async () => {
    mockGetOrCreateAccount.mockRejectedValue(new Error('CDP network error'));
    const client = new CdpWalletClient('k', 's', 'ws', 'base-sepolia');
    await expect(client.init()).rejects.toThrow('CDP network error');
  });

  it('init() with wrong address throws from CDP SDK', async () => {
    mockGetAccount.mockRejectedValue(new Error('Account not found'));
    const client = new CdpWalletClient('k', 's', 'ws', 'base-sepolia', '0xbadaddr');
    await expect(client.init()).rejects.toThrow('Account not found');
  });

  it('address is null before init()', () => {
    const client = new CdpWalletClient('k', 's', 'ws', 'base-sepolia');
    expect(client.address).toBeNull();
  });

  it('address is set after successful init()', async () => {
    mockGetOrCreateAccount.mockResolvedValue({ address: '0xdeadbeef' });
    const client = new CdpWalletClient('k', 's', 'ws', 'base-sepolia');
    await client.init();
    expect(client.address).toBe('0xdeadbeef');
  });

  it('multiple init() calls each resolve correctly', async () => {
    mockGetOrCreateAccount
      .mockResolvedValueOnce({ address: '0xfirst' })
      .mockResolvedValueOnce({ address: '0xsecond' });

    const client = new CdpWalletClient('k', 's', 'ws', 'base-sepolia');
    await client.init();
    expect(client.address).toBe('0xfirst');

    await client.init();
    expect(client.address).toBe('0xsecond');
  });
});
