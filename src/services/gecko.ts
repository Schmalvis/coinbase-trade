import { logger } from '../core/logger.js';
import { queries } from '../data/db.js';

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';
const RATE_LIMIT_MS = 4000; // 4s between token requests (~15 req/min)

export interface Candle {
  symbol: string;
  network: string;
  interval: string;
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
    const cached = queries.getSetting.get(cacheKey) as { value: string } | undefined;
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
      queries.upsertSetting.run({ key: cacheKey, value: poolAddress });
      logger.info(`GeckoTerminal: cached pool ${poolAddress} for ${tokenAddress}`);
      return poolAddress;
    } catch (err) {
      logger.warn(`GeckoTerminal pool lookup error: ${err}`);
      return null;
    }
  }
}
