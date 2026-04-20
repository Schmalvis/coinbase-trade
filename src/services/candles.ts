import { logger } from '../core/logger.js';
import { candleQueries, queries } from '../data/db.js';

export interface Candle {
  symbol: string;
  network: string;
  interval: '15m' | '1h' | '24h';
  openTime: string;  // ISO8601
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: 'coinbase' | 'dex' | 'synthetic';
}

interface PendingCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  count: number;
  startedAt: number;
}

const GRANULARITY_MAP: Record<'15m' | '1h' | '24h', string> = {
  '15m': 'FIFTEEN_MINUTE',
  '1h': 'ONE_HOUR',
  '24h': 'ONE_DAY',
};

const INTERVAL_SECONDS: Record<'15m' | '1h' | '24h', number> = {
  '15m': 15 * 60,
  '1h': 60 * 60,
  '24h': 24 * 60 * 60,
};

// Coinbase API uses BTC-USD; our asset registry uses CBBTC
const CANDLE_SYMBOL_OVERRIDES: Record<string, string> = {
  BTC: 'CBBTC',
};

export class CandleService {
  private pendingCandles: Map<string, PendingCandle> = new Map();
  private pollingIntervalId: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly network: string,
    private readonly coinbasePairs: string[] = ['ETH-USD', 'BTC-USD', 'CBETH-USD'],
  ) {}

  async fetchCoinbaseCandles(
    productId: string,
    interval: '15m' | '1h' | '24h',
    limit: number,
  ): Promise<Candle[]> {
    try {
      const granularity = GRANULARITY_MAP[interval];
      const now = Math.floor(Date.now() / 1000);
      const start = now - limit * INTERVAL_SECONDS[interval];
      const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${productId}/candles?start=${start}&end=${now}&granularity=${granularity}`;

      const res = await fetch(url);
      if (!res.ok) {
        logger.warn(`Coinbase candles HTTP ${res.status} for ${productId} ${interval}`);
        return [];
      }

      const json = (await res.json()) as {
        candles?: Array<{
          start: string;
          low: string;
          high: string;
          open: string;
          close: string;
          volume: string;
        }>;
      };

      if (!json.candles || !Array.isArray(json.candles)) return [];

      const rawSymbol = productId.split('-')[0];
      const symbol = CANDLE_SYMBOL_OVERRIDES[rawSymbol] ?? rawSymbol;
      return json.candles.map((c) => ({
        symbol,
        network: this.network,
        interval,
        openTime: new Date(Number(c.start) * 1000).toISOString(),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume),
        source: 'coinbase' as const,
      }));
    } catch (err) {
      logger.warn(`Coinbase candles fetch error for ${productId} ${interval}: ${err}`);
      return [];
    }
  }

  recordSpotPrice(symbol: string, network: string, price: number): void {
    const key = `${symbol}:${network}`;
    const existing = this.pendingCandles.get(key);

    if (existing) {
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
      existing.count++;
    } else {
      this.pendingCandles.set(key, {
        open: price,
        high: price,
        low: price,
        close: price,
        count: 1,
        startedAt: Date.now(),
      });
    }
  }

  getPendingSyntheticCandle(symbol: string, network: string): PendingCandle | undefined {
    return this.pendingCandles.get(`${symbol}:${network}`);
  }

  flushSyntheticCandles(): Candle[] {
    const flushed: Candle[] = [];
    const cutoff = Date.now() - 15 * 60 * 1000;

    for (const [key, pending] of this.pendingCandles.entries()) {
      if (pending.startedAt <= cutoff && pending.count >= 2) {
        const [symbol, network] = key.split(':');
        const candle: Candle = {
          symbol,
          network,
          interval: '15m',
          openTime: new Date(pending.startedAt).toISOString(),
          open: pending.open,
          high: pending.high,
          low: pending.low,
          close: pending.close,
          volume: 0,
          source: 'synthetic',
        };
        flushed.push(candle);
        this.storeCandles([candle]);
        this.pendingCandles.delete(key);
      }
    }

    if (flushed.length > 0) {
      logger.debug(`Flushed ${flushed.length} synthetic candle(s)`);
    }
    return flushed;
  }

  storeCandles(candles: Candle[]): void {
    for (const c of candles) {
      candleQueries.insertCandle.run({
        symbol: c.symbol,
        network: c.network,
        interval: c.interval,
        open_time: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        source: c.source,
      });
    }
  }

  getStoredCandles(symbol: string, network: string, interval: string, limit: number): Candle[] {
    const rows = candleQueries.getCandles.all(symbol, network, interval, limit);
    return rows.map((r) => ({
      symbol: r.symbol,
      network: r.network,
      interval: r.interval as Candle['interval'],
      openTime: r.open_time,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      source: r.source as Candle['source'],
    }));
  }

  async pollCoinbaseCandles(): Promise<void> {
    const intervals: Array<'15m' | '1h' | '24h'> = ['15m', '1h', '24h'];
    for (const pair of this.coinbasePairs) {
      for (const interval of intervals) {
        const candles = await this.fetchCoinbaseCandles(pair, interval, 50);
        if (candles.length > 0) {
          this.storeCandles(candles);
          logger.debug(`Stored ${candles.length} ${pair} ${interval} candles`);
        }
      }
    }
  }

  startPolling(intervalMs = 15 * 60 * 1000): void {
    if (this.pollingIntervalId) return;
    logger.info(`CandleService polling started (every ${intervalMs / 1000}s)`);
    this.pollingIntervalId = setInterval(() => {
      this.pollCoinbaseCandles().catch((err) =>
        logger.warn(`CandleService poll error: ${err}`),
      );
    }, intervalMs);
    // Also poll immediately on start
    this.pollCoinbaseCandles().catch((err) =>
      logger.warn(`CandleService initial poll error: ${err}`),
    );
  }

  stopPolling(): void {
    if (this.pollingIntervalId) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = undefined;
      logger.info('CandleService polling stopped');
    }
  }

  warmupFromSnapshots(symbols: string[], network: string): void {
    for (const symbol of symbols) {
      // Skip if candles already exist
      const existing = candleQueries.getCandles.all(symbol, network, '15m', 1);
      if ((existing as any[]).length > 0) continue;

      // Get last 500 snapshots (~8hrs at 60s poll)
      const snaps = (queries.recentAssetSnapshots.all(symbol, 500) as {
        price_usd: number; balance: number; timestamp: string;
      }[]).reverse(); // oldest first

      if (snaps.length < 2) continue;

      const windowMs = 15 * 60 * 1000;
      let windowStart = new Date(snaps[0].timestamp).getTime();
      let open = snaps[0].price_usd, high = open, low = open, close = open, count = 0;

      for (const snap of snaps) {
        const t = new Date(snap.timestamp).getTime();
        if (t >= windowStart + windowMs && count > 0) {
          candleQueries.insertCandle.run({
            symbol, network, interval: '15m',
            open_time: new Date(windowStart).toISOString(),
            open, high, low, close, volume: 0, source: 'synthetic',
          });
          windowStart += windowMs;
          open = snap.price_usd; high = open; low = open; close = open; count = 0;
        }
        high = Math.max(high, snap.price_usd);
        low = Math.min(low, snap.price_usd);
        close = snap.price_usd;
        count++;
      }
      if (count > 0) {
        candleQueries.insertCandle.run({
          symbol, network, interval: '15m',
          open_time: new Date(windowStart).toISOString(),
          open, high, low, close, volume: 0, source: 'synthetic',
        });
      }
      logger.info(`Warmup: synthesised ${symbol} candles from ${snaps.length} snapshots`);
    }
  }

  cleanupOldCandles(): void {
    const now = new Date();

    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    candleQueries.deleteOldCandles.run('15m', sevenDaysAgo);

    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    candleQueries.deleteOldCandles.run('1h', thirtyDaysAgo);

    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
    candleQueries.deleteOldCandles.run('24h', oneYearAgo);

    logger.debug('Old candles cleaned up');
  }
}
