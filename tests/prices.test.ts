import { describe, it, expect, vi, beforeEach } from 'vitest';

import { fetchPrice, getTokenPrices } from '../src/wallet/prices.js';

function mockFetch(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(''),
  });
}

describe('fetchPrice', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns correct USD price from Pyth Hermes response', async () => {
    // price "300000000000" with expo -8 → 3000.00
    global.fetch = mockFetch({
      parsed: [{ price: { price: '300000000000', expo: -8 } }],
    });

    const price = await fetchPrice('0xabc123');
    expect(price).toBeCloseTo(3000);
  });

  it('throws when Pyth returns non-ok status', async () => {
    global.fetch = mockFetch({}, false);
    await expect(fetchPrice('0xabc123')).rejects.toThrow('Pyth price fetch failed');
  });

  it('throws when parsed array is empty', async () => {
    global.fetch = mockFetch({ parsed: [] });
    await expect(fetchPrice('0xabc123')).rejects.toThrow('No price data returned');
  });
});

describe('getTokenPrices', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns a price map for known symbols', async () => {
    global.fetch = mockFetch({
      coins: {
        'coingecko:ethereum':            { price: 3000 },
        'coingecko:usd-coin':            { price: 1 },
      },
    });

    const result = await getTokenPrices(['ETH', 'USDC']);
    expect(result['coingecko:ethereum'].usd).toBe(3000);
    expect(result['coingecko:usd-coin'].usd).toBe(1);
  });

  it('throws on non-ok DeFiLlama response', async () => {
    global.fetch = mockFetch({}, false);
    await expect(getTokenPrices(['ETH'])).rejects.toThrow('DeFiLlama price fetch failed');
  });
});
