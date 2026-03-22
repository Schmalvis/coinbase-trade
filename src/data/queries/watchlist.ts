import { db } from '../connection.js';
import type { Statement } from 'better-sqlite3';

export interface WatchlistRow {
  id: number;
  symbol: string;
  network: string;
  address: string | null;
  source: string;
  added_at: string;
  status: string;
  coinbase_pair: string | null;
}

export const watchlistQueries = {
  insertWatchlistItem: db.prepare(`
    INSERT OR IGNORE INTO watchlist (symbol, network, address, source, coinbase_pair)
    VALUES (@symbol, @network, @address, @source, @coinbase_pair)
  `) as Statement<{ symbol: string; network: string; address: string | null; source: string; coinbase_pair: string | null }>,

  getWatchlist: db.prepare(`
    SELECT * FROM watchlist WHERE network = ? AND status = 'watching'
  `) as Statement<[string], WatchlistRow>,

  updateWatchlistStatus: db.prepare(`
    UPDATE watchlist SET status = @status WHERE symbol = @symbol AND network = @network
  `) as Statement<{ status: string; symbol: string; network: string }>,

  removeWatchlistItem: db.prepare(`
    UPDATE watchlist SET status = 'removed' WHERE symbol = ? AND network = ?
  `) as Statement<[string, string]>,
};
