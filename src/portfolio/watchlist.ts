import { watchlistQueries, discoveredAssetQueries } from '../data/db.js';
import { logger } from '../core/logger.js';

export interface WatchlistRow {
  id: number; symbol: string; network: string; address: string | null;
  source: string; added_at: string; status: string; coinbase_pair: string | null;
}

export class WatchlistManager {
  add(symbol: string, network: string, address?: string, coinbasePair?: string, source = 'manual'): void {
    watchlistQueries.insertWatchlistItem.run({
      symbol, network, address: address ?? null, coinbase_pair: coinbasePair ?? null, source,
    });
    logger.info(`Watchlist: added ${symbol} on ${network}`);
  }

  remove(symbol: string, network: string): void {
    watchlistQueries.removeWatchlistItem.run(symbol, network);
    logger.info(`Watchlist: removed ${symbol} on ${network}`);
  }

  getAll(network: string): WatchlistRow[] {
    return watchlistQueries.getWatchlist.all(network) as WatchlistRow[];
  }

  promote(symbol: string, network: string): void {
    const items = this.getAll(network);
    const item = items.find(i => i.symbol === symbol);
    if (!item) throw new Error(`${symbol} not on watchlist for ${network}`);
    if (!item.address) throw new Error(`Cannot promote ${symbol}: contract address is required`);

    discoveredAssetQueries.upsertDiscoveredAsset.run({
      address: item.address, network, symbol, name: symbol, decimals: 18,
    });
    discoveredAssetQueries.updateAssetStatus.run({ status: 'active', address: item.address, network });
    watchlistQueries.updateWatchlistStatus.run({ status: 'promoted', symbol, network });
    logger.info(`Watchlist: promoted ${symbol} to active discovered asset`);
  }
}
