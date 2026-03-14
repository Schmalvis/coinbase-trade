import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB module before importing CandleService
vi.mock('../src/data/db.js', () => {
  const rows: unknown[] = [];
  return {
    candleQueries: {
      insertCandle: {
        run: vi.fn((params: Record<string, unknown>) => { rows.push(params); }),
      },
      getCandles: {
        all: vi.fn((_symbol: string, _network: string, _interval: string, _limit: number) =>
          rows.slice(0, _limit).map((r, i) => ({ id: i + 1, ...(r as object) })),
        ),
      },
      deleteOldCandles: {
        run: vi.fn(),
      },
    },
    __testRows: rows,
  };
});

// Mock the logger to suppress output
vi.mock('../src/core/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { CandleService } from '../src/services/candles.js';
import { candleQueries } from '../src/data/db.js';

describe('CandleService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Re-stub the DB mocks since restoreAllMocks clears them
    vi.mocked(candleQueries.insertCandle.run).mockImplementation(() => ({ changes: 1, lastInsertRowid: 1 }) as never);
    vi.mocked(candleQueries.deleteOldCandles.run).mockImplementation(() => ({ changes: 0, lastInsertRowid: 0 }) as never);
  });

  describe('fetchCoinbaseCandles', () => {
    it('parses API response correctly', async () => {
      const mockResponse = {
        candles: [
          { start: '1700000000', low: '1900.5', high: '2100.0', open: '2000.0', close: '2050.0', volume: '1234.56' },
          { start: '1700000900', low: '2010.0', high: '2150.0', open: '2050.0', close: '2100.0', volume: '567.89' },
        ],
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      }));

      const svc = new CandleService('base-mainnet');
      const candles = await svc.fetchCoinbaseCandles('ETH-USD', '15m', 10);

      expect(candles).toHaveLength(2);
      expect(candles[0]).toMatchObject({
        symbol: 'ETH',
        network: 'base-mainnet',
        interval: '15m',
        open: 2000.0,
        high: 2100.0,
        low: 1900.5,
        close: 2050.0,
        volume: 1234.56,
        source: 'coinbase',
      });
      expect(candles[0].openTime).toBe(new Date(1700000000 * 1000).toISOString());
      expect(candles[1].open).toBe(2050.0);

      // Verify URL was constructed correctly
      const fetchMock = vi.mocked(fetch);
      const calledUrl = fetchMock.mock.calls[0][0] as string;
      expect(calledUrl).toContain('ETH-USD');
      expect(calledUrl).toContain('granularity=FIFTEEN_MINUTE');
    });

    it('returns [] on network error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

      const svc = new CandleService('base-mainnet');
      const candles = await svc.fetchCoinbaseCandles('ETH-USD', '1h', 10);

      expect(candles).toEqual([]);
    });

    it('returns [] on non-ok HTTP response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
      }));

      const svc = new CandleService('base-mainnet');
      const candles = await svc.fetchCoinbaseCandles('ETH-USD', '24h', 5);

      expect(candles).toEqual([]);
    });
  });

  describe('recordSpotPrice', () => {
    it('builds synthetic candle with correct OHLC tracking', () => {
      const svc = new CandleService('base-sepolia');

      svc.recordSpotPrice('ETH', 'base-sepolia', 2000);
      let pending = svc.getPendingSyntheticCandle('ETH', 'base-sepolia');
      expect(pending).toBeDefined();
      expect(pending!.open).toBe(2000);
      expect(pending!.high).toBe(2000);
      expect(pending!.low).toBe(2000);
      expect(pending!.close).toBe(2000);
      expect(pending!.count).toBe(1);

      svc.recordSpotPrice('ETH', 'base-sepolia', 2100);
      pending = svc.getPendingSyntheticCandle('ETH', 'base-sepolia');
      expect(pending!.open).toBe(2000);   // open unchanged
      expect(pending!.high).toBe(2100);   // new high
      expect(pending!.low).toBe(2000);
      expect(pending!.close).toBe(2100);  // updated close
      expect(pending!.count).toBe(2);

      svc.recordSpotPrice('ETH', 'base-sepolia', 1950);
      pending = svc.getPendingSyntheticCandle('ETH', 'base-sepolia');
      expect(pending!.open).toBe(2000);
      expect(pending!.high).toBe(2100);
      expect(pending!.low).toBe(1950);    // new low
      expect(pending!.close).toBe(1950);
      expect(pending!.count).toBe(3);
    });

    it('tracks separate candles per symbol', () => {
      const svc = new CandleService('base-mainnet');

      svc.recordSpotPrice('ETH', 'base-mainnet', 2000);
      svc.recordSpotPrice('CBBTC', 'base-mainnet', 60000);

      const ethCandle = svc.getPendingSyntheticCandle('ETH', 'base-mainnet');
      const btcCandle = svc.getPendingSyntheticCandle('CBBTC', 'base-mainnet');

      expect(ethCandle!.open).toBe(2000);
      expect(btcCandle!.open).toBe(60000);
    });
  });

  describe('flushSyntheticCandles', () => {
    it('flushes candles older than 15min with 2+ data points', () => {
      const svc = new CandleService('base-mainnet');

      // Record two data points
      svc.recordSpotPrice('ETH', 'base-mainnet', 2000);
      svc.recordSpotPrice('ETH', 'base-mainnet', 2050);

      // Manually backdate the startedAt to make it older than 15min
      const pending = svc.getPendingSyntheticCandle('ETH', 'base-mainnet');
      pending!.startedAt = Date.now() - 16 * 60 * 1000;

      const flushed = svc.flushSyntheticCandles();
      expect(flushed).toHaveLength(1);
      expect(flushed[0].symbol).toBe('ETH');
      expect(flushed[0].interval).toBe('15m');
      expect(flushed[0].source).toBe('synthetic');
      expect(flushed[0].open).toBe(2000);
      expect(flushed[0].close).toBe(2050);

      // Should be cleared after flush
      expect(svc.getPendingSyntheticCandle('ETH', 'base-mainnet')).toBeUndefined();
    });

    it('does NOT flush candles with only 1 data point', () => {
      const svc = new CandleService('base-mainnet');
      svc.recordSpotPrice('ETH', 'base-mainnet', 2000);
      const pending = svc.getPendingSyntheticCandle('ETH', 'base-mainnet');
      pending!.startedAt = Date.now() - 20 * 60 * 1000;

      const flushed = svc.flushSyntheticCandles();
      expect(flushed).toHaveLength(0);
    });

    it('does NOT flush candles newer than 15min', () => {
      const svc = new CandleService('base-mainnet');
      svc.recordSpotPrice('ETH', 'base-mainnet', 2000);
      svc.recordSpotPrice('ETH', 'base-mainnet', 2050);
      // startedAt is just now, so < 15min

      const flushed = svc.flushSyntheticCandles();
      expect(flushed).toHaveLength(0);
    });
  });

  describe('storeCandles + getStoredCandles round-trip', () => {
    it('stores and retrieves candles via DB queries', () => {
      const storedRows: Record<string, unknown>[] = [];
      vi.mocked(candleQueries.insertCandle.run).mockImplementation((params) => {
        storedRows.push(params as Record<string, unknown>);
        return { changes: 1, lastInsertRowid: storedRows.length } as never;
      });
      vi.mocked(candleQueries.getCandles.all).mockImplementation(() =>
        storedRows.map((r, i) => ({
          id: i + 1,
          symbol: r.symbol as string,
          network: r.network as string,
          interval: r.interval as string,
          open_time: r.open_time as string,
          open: r.open as number,
          high: r.high as number,
          low: r.low as number,
          close: r.close as number,
          volume: r.volume as number,
          source: r.source as string,
        })),
      );

      const svc = new CandleService('base-mainnet');
      const candles = [
        {
          symbol: 'ETH',
          network: 'base-mainnet',
          interval: '15m' as const,
          openTime: '2024-01-01T00:00:00.000Z',
          open: 2000,
          high: 2100,
          low: 1950,
          close: 2050,
          volume: 100,
          source: 'coinbase' as const,
        },
      ];

      svc.storeCandles(candles);
      expect(candleQueries.insertCandle.run).toHaveBeenCalled();

      const retrieved = svc.getStoredCandles('ETH', 'base-mainnet', '15m', 10);
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].symbol).toBe('ETH');
      expect(retrieved[0].openTime).toBe('2024-01-01T00:00:00.000Z');
      expect(retrieved[0].open).toBe(2000);
      expect(retrieved[0].source).toBe('coinbase');
    });
  });

  describe('cleanupOldCandles', () => {
    it('calls deleteOldCandles for each interval with correct cutoff dates', () => {
      const svc = new CandleService('base-mainnet');
      svc.cleanupOldCandles();

      expect(candleQueries.deleteOldCandles.run).toHaveBeenCalledTimes(3);

      const calls = vi.mocked(candleQueries.deleteOldCandles.run).mock.calls;
      expect(calls[0][0]).toBe('15m');
      expect(calls[1][0]).toBe('1h');
      expect(calls[2][0]).toBe('24h');
    });
  });
});
