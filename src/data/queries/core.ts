import { db } from '../connection.js';
import type { Statement } from 'better-sqlite3';

/** Wraps `fn` in BEGIN/COMMIT with automatic ROLLBACK on error. */
export const runTransaction: (fn: () => void) => void = db.transaction((fn: () => void) => fn());

export const queries: Record<string, Statement> = {
  insertSnapshot: db.prepare(`
    INSERT INTO price_snapshots (eth_price, eth_balance, portfolio_usd)
    VALUES (@eth_price, @eth_balance, @portfolio_usd)
  `),

  recentSnapshots: db.prepare(`
    SELECT * FROM price_snapshots ORDER BY id DESC LIMIT ?
  `),

  insertTrade: db.prepare(`
    INSERT INTO trades (action, amount_eth, price_usd, tx_hash, triggered_by, status, dry_run, reason, network, entry_price, realized_pnl, strategy, symbol)
    VALUES (@action, @amount_eth, @price_usd, @tx_hash, @triggered_by, @status, @dry_run, @reason, @network, @entry_price, @realized_pnl, @strategy, @symbol)
  `),

  recentTrades: db.prepare(`
    SELECT * FROM trades ORDER BY id DESC LIMIT ?
  `),

  insertEvent: db.prepare(`
    INSERT INTO bot_events (event, detail) VALUES (?, ?)
  `),

  insertAssetSnapshot: db.prepare(
    'INSERT INTO asset_snapshots (symbol, price_usd, balance) VALUES (@symbol, @price_usd, @balance)'
  ),

  recentAssetSnapshots: db.prepare(
    'SELECT * FROM asset_snapshots WHERE symbol = ? ORDER BY id DESC LIMIT ?'
  ),

  getLatestAssetSnapshot: db.prepare(
    'SELECT * FROM asset_snapshots WHERE symbol = ? ORDER BY id DESC LIMIT 1'
  ),

  insertPortfolioSnapshot: db.prepare(
    'INSERT INTO portfolio_snapshots (portfolio_usd) VALUES (@portfolio_usd)'
  ),

  recentPortfolioSnapshots: db.prepare(
    'SELECT * FROM portfolio_snapshots ORDER BY id DESC LIMIT ?'
  ),
};

export const portfolioSnapshotQueries = {
  getRecentSnapshots: db.prepare(`
    SELECT * FROM portfolio_snapshots ORDER BY id DESC LIMIT ?
  `) as Statement<[number], { id: number; timestamp: string; portfolio_usd: number }>,
};
