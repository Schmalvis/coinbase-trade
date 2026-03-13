import { describe, it, expect } from 'vitest';

describe('BotState pendingTokenCount', () => {
  it('defaults to 0', async () => {
    const { botState } = await import('../src/core/state.js');
    expect(botState.pendingTokenCount).toBe(0);
  });

  it('setPendingTokenCount updates the value', async () => {
    const { botState } = await import('../src/core/state.js');
    botState.setPendingTokenCount(3);
    expect(botState.pendingTokenCount).toBe(3);
  });

  it('setNetwork resets pendingTokenCount to 0', async () => {
    const { botState } = await import('../src/core/state.js');
    botState.setPendingTokenCount(5);
    botState.setNetwork('base-mainnet');
    expect(botState.pendingTokenCount).toBe(0);
  });
});
