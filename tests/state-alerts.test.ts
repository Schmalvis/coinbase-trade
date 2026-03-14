import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/config.js', () => ({
  config: { NETWORK_ID: 'base-sepolia' },
  availableNetworks: ['base-sepolia'],
}));

const { botState } = await import('../src/core/state.js');

describe('BotState alerts', () => {
  beforeEach(() => {
    botState.setWalletAddress(null);
  });

  it('walletAddress is null initially', () => {
    expect(botState.walletAddress).toBeNull();
  });

  it('stores and returns walletAddress', () => {
    botState.setWalletAddress('0xABC123');
    expect(botState.walletAddress).toBe('0xABC123');
  });

  it('setWalletAddress(null) clears the address', () => {
    botState.setWalletAddress('0xABC123');
    botState.setWalletAddress(null);
    expect(botState.walletAddress).toBeNull();
  });

  it('calls registered alert listeners with the message', () => {
    const listener = vi.fn();
    botState.onAlert(listener);
    botState.emitAlert('test alert message');
    expect(listener).toHaveBeenCalledWith('test alert message');
  });
});
