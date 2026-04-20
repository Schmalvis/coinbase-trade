import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock DB ──
vi.mock('../src/data/db.js', () => ({
  candleQueries: {
    upsertCandle: { run: vi.fn() },
    getCandles:   { all: vi.fn().mockReturnValue([]) },
  },
  queries: {
    recentAssetSnapshots: { all: vi.fn().mockReturnValue([]) },
  },
}));

vi.mock('../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { CandleService } from '../src/services/candles.js';

function makeCoinbaseResponse(productId: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    candles: [
      { start: String(now - 900), open: '100', high: '105', low: '99', close: '103', volume: '500' },
      { start: String(now - 1800), open: '98', high: '101', low: '97', close: '100', volume: '400' },
    ],
  };
}

describe('CandleService — CBBTC symbol override', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('candles fetched for BTC-USD are stored under CBBTC symbol, not BTC', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(makeCoinbaseResponse('BTC-USD')),
    });

    const service = new CandleService('base-mainnet', ['BTC-USD']);
    const candles = await service.fetchCoinbaseCandles('BTC-USD', '1h', 2);

    expect(candles.length).toBeGreaterThan(0);
    for (const candle of candles) {
      expect(candle.symbol).toBe('CBBTC');
      expect(candle.symbol).not.toBe('BTC');
    }
  });

  it('candles fetched for ETH-USD keep ETH symbol (no override)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(makeCoinbaseResponse('ETH-USD')),
    });

    const service = new CandleService('base-mainnet', ['ETH-USD']);
    const candles = await service.fetchCoinbaseCandles('ETH-USD', '1h', 2);

    expect(candles.length).toBeGreaterThan(0);
    for (const candle of candles) {
      expect(candle.symbol).toBe('ETH');
    }
  });
});
