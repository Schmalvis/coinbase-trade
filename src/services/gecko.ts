import { logger } from '../core/logger.js';
import { settingQueries } from '../data/db.js';

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';
const RATE_LIMIT_MS = 4000; // 4s between token requests (~15 req/min)

export interface Candle {
  symbol: string;
  network: string;
  interval: '15m' | '1h' | '24h';
  openTime: string; // ISO string
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: 'dex';
}

export class GeckoTerminalService {
  private lastRequestAt = 0;

  private async throttledFetch(url: string): Promise<Response> {
    const now = Date.now();
    const wait = RATE_LIMIT_MS - (now - this.lastRequestAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
    return fetch(url, { headers: { Accept: 'application/json;version=20230302' } });
  }

  async getPoolAddress(tokenAddress: string): Promise<string | null> {
    const cacheKey = `gecko_pool_${tokenAddress.toLowerCase()}`;
    const cached = settingQueries.getSetting.get(cacheKey) as { value: string } | undefined;
    if (cached) return cached.value;

    const url = `${GECKO_BASE}/networks/base/tokens/${tokenAddress}/pools?page=1`;
    try {
      const res = await this.throttledFetch(url);
      if (!res.ok) {
        logger.warn(`GeckoTerminal pool lookup failed: ${res.status} for ${tokenAddress}`);
        return null;
      }
      const body = await res.json() as { data: Array<{ attributes: { address: string } }> };
      if (!body.data?.length) return null;

      const poolAddress = body.data[0].attributes.address;
      settingQueries.upsertSetting.run(cacheKey, poolAddress);
      logger.info(`GeckoTerminal: cached pool ${poolAddress} for ${tokenAddress}`);
      return poolAddress;
    } catch (err) {
      logger.warn(`GeckoTerminal pool lookup error: ${err}`);
      return null;
    }
  }

  private intervalParams(interval: '15m' | '1h'): { timeframe: string; aggregate: number } {
    return interval === '15m'
      ? { timeframe: 'minute', aggregate: 15 }
      : { timeframe: 'hour', aggregate: 1 };
  }

  async fetchCandles(
    tokenAddress: string,
    symbol: string,
    network: string,
    interval: '15m' | '1h',
  ): Promise<Candle[]> {
    const poolAddress = await this.getPoolAddress(tokenAddress.toLowerCase());
    if (!poolAddress) return [];

    const { timeframe, aggregate } = this.intervalParams(interval);
    const url = `${GECKO_BASE}/networks/base/pools/${poolAddress}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=200`;

    try {
      const res = await this.throttledFetch(url);
      if (!res.ok) {
        logger.warn(`GeckoTerminal OHLCV failed: ${res.status} for ${symbol} ${interval}`);
        return [];
      }
      const body = await res.json() as {
        data: { attributes: { ohlcv_list: number[][] } };
      };
      return (body.data?.attributes?.ohlcv_list ?? []).map(([ts, open, high, low, close, volume]) => ({
        symbol,
        network,
        interval,
        openTime: new Date(ts * 1000).toISOString(),
        open,
        high,
        low,
        close,
        volume,
        source: 'dex' as const,
      }));
    } catch (err) {
      logger.warn(`GeckoTerminal fetchCandles error for ${symbol}: ${err}`);
      return [];
    }
  }
}
