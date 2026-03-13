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
