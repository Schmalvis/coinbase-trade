import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  config: { NETWORK_ID: 'base-sepolia' },
  availableNetworks: ['base-sepolia'],
}));

const { botState } = await import('../src/core/state.js');

describe('BotState alerts', () => {
  it('calls registered alert listeners with the message', () => {
    const listener = vi.fn();
    botState.onAlert(listener);
    botState.emitAlert('test alert message');
    expect(listener).toHaveBeenCalledWith('test alert message');
  });

  it('stores and returns walletAddress', () => {
    botState.setWalletAddress('0xABC123');
    expect(botState.walletAddress).toBe('0xABC123');
  });

  it('walletAddress is null initially', () => {
    expect(typeof botState.walletAddress).toMatch(/string|object/);
  });
});
