import Database, { type Database as DB, type Statement } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config.js';

fs.mkdirSync(config.DATA_DIR, { recursive: true });

const dbPath = path.join(config.DATA_DIR, 'trades.db');
export const db: DB = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migration: add network column to existing DBs that predate this field
try { db.exec(`ALTER TABLE trades ADD COLUMN network TEXT NOT NULL DEFAULT 'unknown'`); } catch { /* already exists */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS price_snapshots (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT    NOT NULL DEFAULT (datetime('now')),
    eth_price REAL    NOT NULL,
    eth_balance REAL  NOT NULL,
    portfolio_usd REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trades (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp    TEXT NOT NULL DEFAULT (datetime('now')),
    action       TEXT NOT NULL CHECK(action IN ('buy', 'sell')),
    amount_eth   REAL NOT NULL,
    price_usd    REAL NOT NULL,
    tx_hash      TEXT,
    triggered_by TEXT NOT NULL DEFAULT 'strategy',
    status       TEXT NOT NULL DEFAULT 'pending',
    dry_run      INTEGER NOT NULL DEFAULT 1,
    reason       TEXT,
    network      TEXT NOT NULL DEFAULT 'unknown'
  );

  CREATE TABLE IF NOT EXISTS bot_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    event     TEXT NOT NULL,
    detail    TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS asset_snapshots (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT    NOT NULL DEFAULT (datetime('now')),
    symbol    TEXT    NOT NULL,
    price_usd REAL    NOT NULL,
    balance   REAL    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     TEXT    NOT NULL DEFAULT (datetime('now')),
    portfolio_usd REAL    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS candles (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol    TEXT NOT NULL,
    network   TEXT NOT NULL,
    interval  TEXT NOT NULL CHECK(interval IN ('15m', '1h', '24h')),
    open_time TEXT NOT NULL,
    open      REAL NOT NULL,
    high      REAL NOT NULL,
    low       REAL NOT NULL,
    close     REAL NOT NULL,
    volume    REAL NOT NULL DEFAULT 0,
    source    TEXT NOT NULL CHECK(source IN ('coinbase', 'dex', 'synthetic')),
    UNIQUE(symbol, network, interval, open_time)
  );

  CREATE TABLE IF NOT EXISTS watchlist (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol        TEXT NOT NULL,
    network       TEXT NOT NULL,
    address       TEXT,
    source        TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual', 'trending', 'suggested')),
    added_at      TEXT NOT NULL DEFAULT (datetime('now')),
    status        TEXT NOT NULL DEFAULT 'watching' CHECK(status IN ('watching', 'promoted', 'removed')),
    coinbase_pair TEXT,
    UNIQUE(symbol, network)
  );

  CREATE TABLE IF NOT EXISTS rotations (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp           TEXT NOT NULL DEFAULT (datetime('now')),
    sell_symbol         TEXT NOT NULL,
    buy_symbol          TEXT NOT NULL,
    sell_amount         REAL NOT NULL,
    buy_amount          REAL,
    sell_tx_hash        TEXT,
    buy_tx_hash         TEXT,
    estimated_gain_pct  REAL NOT NULL,
    actual_gain_pct     REAL,
    estimated_fee_pct   REAL NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending', 'leg1_done', 'executed', 'failed', 'vetoed')),
    veto_reason         TEXT,
    dry_run             INTEGER NOT NULL DEFAULT 0,
    network             TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_rotations_network_ts ON rotations(network, timestamp);

  CREATE TABLE IF NOT EXISTS daily_pnl (
    date          TEXT NOT NULL,
    network       TEXT NOT NULL,
    high_water    REAL NOT NULL,
    current_usd   REAL NOT NULL,
    rotations     INTEGER NOT NULL DEFAULT 0,
    realized_pnl  REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (date, network)
  );
`);

export const queries: Record<string, Statement> = {
  insertSnapshot: db.prepare(`
    INSERT INTO price_snapshots (eth_price, eth_balance, portfolio_usd)
    VALUES (@eth_price, @eth_balance, @portfolio_usd)
  `),

  recentSnapshots: db.prepare(`
    SELECT * FROM price_snapshots ORDER BY id DESC LIMIT ?
  `),

  insertTrade: db.prepare(`
    INSERT INTO trades (action, amount_eth, price_usd, tx_hash, triggered_by, status, dry_run, reason, network)
    VALUES (@action, @amount_eth, @price_usd, @tx_hash, @triggered_by, @status, @dry_run, @reason, @network)
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

  insertPortfolioSnapshot: db.prepare(
    'INSERT INTO portfolio_snapshots (portfolio_usd) VALUES (@portfolio_usd)'
  ),

  recentPortfolioSnapshots: db.prepare(
    'SELECT * FROM portfolio_snapshots ORDER BY id DESC LIMIT ?'
  ),
};

export const settingQueries = {
  getSetting:    db.prepare('SELECT value FROM settings WHERE key = ?') as Statement<[string], { value: string }>,
  upsertSetting: db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `) as Statement<[string, string]>,
  getAllSettings: db.prepare('SELECT key, value FROM settings') as Statement<[], { key: string; value: string }>,
};

// discovered_assets DDL
db.prepare(`
  CREATE TABLE IF NOT EXISTS discovered_assets (
    address     TEXT NOT NULL,
    network     TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    decimals    INTEGER NOT NULL DEFAULT 18,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','dismissed')),
    drop_pct    REAL NOT NULL DEFAULT 2.0,
    rise_pct    REAL NOT NULL DEFAULT 3.0,
    sma_short   INTEGER NOT NULL DEFAULT 5,
    sma_long    INTEGER NOT NULL DEFAULT 20,
    strategy    TEXT NOT NULL DEFAULT 'threshold' CHECK(strategy IN ('threshold','sma')),
    discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (address, network)
  )
`).run();

export interface DiscoveredAssetRow {
  address:      string;
  network:      string;
  symbol:       string;
  name:         string;
  decimals:     number;
  status:       'pending' | 'active' | 'dismissed';
  drop_pct:     number;
  rise_pct:     number;
  sma_short:    number;
  sma_long:     number;
  strategy:     'threshold' | 'sma';
  discovered_at: string;
}

export const discoveredAssetQueries = {
  upsertDiscoveredAsset: db.prepare(`
    INSERT OR IGNORE INTO discovered_assets (address, network, symbol, name, decimals)
    VALUES (@address, @network, @symbol, @name, @decimals)
  `) as Statement<{ address: string; network: string; symbol: string; name: string; decimals: number }>,

  getDiscoveredAssets: db.prepare(`
    SELECT * FROM discovered_assets WHERE network = ?
  `) as Statement<[string], DiscoveredAssetRow>,

  getActiveAssets: db.prepare(`
    SELECT * FROM discovered_assets WHERE status = 'active' AND network = ?
  `) as Statement<[string], DiscoveredAssetRow>,

  updateAssetStatus: db.prepare(`
    UPDATE discovered_assets SET status = @status WHERE address = @address AND network = @network
  `) as Statement<{ status: string; address: string; network: string }>,

  updateAssetStrategyConfig: db.prepare(`
    UPDATE discovered_assets
    SET drop_pct = @drop_pct, rise_pct = @rise_pct,
        sma_short = @sma_short, sma_long = @sma_long, strategy = @strategy
    WHERE address = @address AND network = @network
  `) as Statement<{ drop_pct: number; rise_pct: number; sma_short: number; sma_long: number; strategy: string; address: string; network: string }>,

  dismissAsset: db.prepare(`
    UPDATE discovered_assets SET status = 'dismissed' WHERE address = ? AND network = ?
  `) as Statement<[string, string]>,

  getAssetByAddress: db.prepare(`
    SELECT * FROM discovered_assets WHERE address = ? AND network = ?
  `) as Statement<[string, string], DiscoveredAssetRow>,
};

// ── Optimizer tables: candles, watchlist, rotations, daily_pnl ──

export interface CandleRow {
  id: number;
  symbol: string;
  network: string;
  interval: string;
  open_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
}

export const candleQueries = {
  insertCandle: db.prepare(`
    INSERT OR REPLACE INTO candles (symbol, network, interval, open_time, open, high, low, close, volume, source)
    VALUES (@symbol, @network, @interval, @open_time, @open, @high, @low, @close, @volume, @source)
  `) as Statement<{ symbol: string; network: string; interval: string; open_time: string; open: number; high: number; low: number; close: number; volume: number; source: string }>,

  getCandles: db.prepare(`
    SELECT * FROM candles WHERE symbol = ? AND network = ? AND interval = ? ORDER BY open_time DESC LIMIT ?
  `) as Statement<[string, string, string, number], CandleRow>,

  deleteOldCandles: db.prepare(`
    DELETE FROM candles WHERE interval = ? AND open_time < ?
  `) as Statement<[string, string]>,
};

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

export interface RotationRow {
  id: number;
  timestamp: string;
  sell_symbol: string;
  buy_symbol: string;
  sell_amount: number;
  buy_amount: number | null;
  sell_tx_hash: string | null;
  buy_tx_hash: string | null;
  estimated_gain_pct: number;
  actual_gain_pct: number | null;
  estimated_fee_pct: number;
  status: string;
  veto_reason: string | null;
  dry_run: number;
  network: string;
}

export const rotationQueries = {
  insertRotation: db.prepare(`
    INSERT INTO rotations (sell_symbol, buy_symbol, sell_amount, estimated_gain_pct, estimated_fee_pct, dry_run, network)
    VALUES (@sell_symbol, @buy_symbol, @sell_amount, @estimated_gain_pct, @estimated_fee_pct, @dry_run, @network)
  `) as Statement<{ sell_symbol: string; buy_symbol: string; sell_amount: number; estimated_gain_pct: number; estimated_fee_pct: number; dry_run: number; network: string }>,

  updateRotation: db.prepare(`
    UPDATE rotations
    SET status = @status, buy_amount = @buy_amount, sell_tx_hash = @sell_tx_hash,
        buy_tx_hash = @buy_tx_hash, actual_gain_pct = @actual_gain_pct, veto_reason = @veto_reason
    WHERE id = @id
  `) as Statement<{ status: string; buy_amount: number | null; sell_tx_hash: string | null; buy_tx_hash: string | null; actual_gain_pct: number | null; veto_reason: string | null; id: number }>,

  getRecentRotations: db.prepare(`
    SELECT * FROM rotations WHERE network = ? ORDER BY id DESC LIMIT ?
  `) as Statement<[string, number], RotationRow>,

  getTodayRotationCount: db.prepare(`
    SELECT COUNT(*) as cnt FROM rotations
    WHERE network = ? AND date(timestamp) = date('now') AND status IN ('executed', 'leg1_done')
  `) as Statement<[string], { cnt: number }>,
};

export interface DailyPnlRow {
  date: string;
  network: string;
  high_water: number;
  current_usd: number;
  rotations: number;
  realized_pnl: number;
}

export const dailyPnlQueries = {
  upsertDailyPnl: db.prepare(`
    INSERT INTO daily_pnl (date, network, high_water, current_usd, rotations, realized_pnl)
    VALUES (@date, @network, @high_water, @current_usd, @rotations, @realized_pnl)
    ON CONFLICT(date, network) DO UPDATE SET
      high_water = MAX(daily_pnl.high_water, excluded.high_water),
      current_usd = excluded.current_usd,
      rotations = excluded.rotations,
      realized_pnl = excluded.realized_pnl
  `) as Statement<{ date: string; network: string; high_water: number; current_usd: number; rotations: number; realized_pnl: number }>,

  getDailyPnl: db.prepare(`
    SELECT * FROM daily_pnl WHERE date = ? AND network = ?
  `) as Statement<[string, string], DailyPnlRow>,

  getTodayPnl: db.prepare(`
    SELECT * FROM daily_pnl WHERE date = date('now') AND network = ?
  `) as Statement<[string], DailyPnlRow>,

  getRecentDailyPnl: db.prepare(`
    SELECT * FROM daily_pnl WHERE network = ? ORDER BY date DESC LIMIT ?
  `) as Statement<[string, number], DailyPnlRow>,
};

export const portfolioSnapshotQueries = {
  getRecentSnapshots: db.prepare(`
    SELECT * FROM portfolio_snapshots ORDER BY id DESC LIMIT ?
  `) as Statement<[number], { id: number; timestamp: string; portfolio_usd: number }>,
};
