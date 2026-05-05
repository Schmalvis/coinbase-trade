// tests/db-report.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { generateReport } from '../src/scripts/db-report.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

function makeDb(): Database.Database {
  const dbPath = path.join(os.tmpdir(), `dbreport-${Date.now()}-${Math.random()}.db`);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      action TEXT NOT NULL,
      amount_eth REAL NOT NULL DEFAULT 0,
      price_usd REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      dry_run INTEGER NOT NULL DEFAULT 0,
      realized_pnl REAL,
      strategy TEXT,
      symbol TEXT,
      network TEXT NOT NULL DEFAULT 'base-mainnet'
    );
    CREATE TABLE rotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      sell_symbol TEXT NOT NULL,
      buy_symbol TEXT NOT NULL,
      sell_amount REAL NOT NULL DEFAULT 0,
      estimated_gain_pct REAL NOT NULL DEFAULT 0,
      actual_gain_pct REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      veto_reason TEXT,
      dry_run INTEGER NOT NULL DEFAULT 0,
      network TEXT NOT NULL DEFAULT 'base-mainnet'
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE discovered_assets (
      address TEXT NOT NULL,
      network TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      strategy TEXT NOT NULL DEFAULT 'threshold',
      drop_pct REAL NOT NULL DEFAULT 2.0,
      rise_pct REAL NOT NULL DEFAULT 3.0,
      sma_short INTEGER NOT NULL DEFAULT 5,
      sma_long INTEGER NOT NULL DEFAULT 20,
      is_memecoin INTEGER NOT NULL DEFAULT 0,
      shadow_until INTEGER,
      PRIMARY KEY (address, network)
    );
    CREATE TABLE daily_pnl (
      date TEXT NOT NULL,
      network TEXT NOT NULL,
      high_water REAL NOT NULL DEFAULT 0,
      current_usd REAL NOT NULL DEFAULT 0,
      rotations INTEGER NOT NULL DEFAULT 0,
      realized_pnl REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (date, network)
    );
    CREATE TABLE asset_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      symbol TEXT NOT NULL,
      price_usd REAL NOT NULL DEFAULT 0,
      balance REAL NOT NULL DEFAULT 0
    );
  `);
  (db as any).__dbPath = dbPath;
  return db;
}

function closeDb(db: Database.Database) {
  db.close();
  const p = (db as any).__dbPath;
  if (p && fs.existsSync(p)) fs.unlinkSync(p);
}

describe('generateReport', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => closeDb(db));

  it('returns all sections with empty tables', () => {
    const report = generateReport(db);
    expect(report.last24hTrades).toEqual([]);
    expect(report.last24hRotations).toEqual([]);
    expect(report.tokenMetrics).toEqual([]);
    expect(report.settings).toEqual({});
    expect(report.assets).toEqual([]);
    expect(report.dailyPnl).toEqual([]);
  });

  it('includes only non-dry-run trades from last 24h', () => {
    db.prepare(`INSERT INTO trades (action, amount_eth, price_usd, dry_run, symbol, network, timestamp)
      VALUES ('buy', 0.01, 2000, 0, 'ETH', 'base-mainnet', datetime('now', '-1 hour'))`).run();
    db.prepare(`INSERT INTO trades (action, amount_eth, price_usd, dry_run, symbol, network, timestamp)
      VALUES ('buy', 0.01, 2000, 1, 'ETH', 'base-mainnet', datetime('now', '-1 hour'))`).run();
    db.prepare(`INSERT INTO trades (action, amount_eth, price_usd, dry_run, symbol, network, timestamp)
      VALUES ('sell', 0.01, 2100, 0, 'ETH', 'base-mainnet', datetime('now', '-25 hours'))`).run();
    const report = generateReport(db);
    expect(report.last24hTrades).toHaveLength(1);
    expect(report.last24hTrades[0].symbol).toBe('ETH');
    expect(report.last24hTrades[0].action).toBe('buy');
  });

  it('computes 7-day token win/loss from non-dry-run sell trades', () => {
    db.prepare(`INSERT INTO trades (action, amount_eth, price_usd, dry_run, symbol, network, realized_pnl, timestamp)
      VALUES ('sell', 0.01, 2100, 0, 'ETH', 'base-mainnet', 2.5, datetime('now', '-2 days'))`).run();
    db.prepare(`INSERT INTO trades (action, amount_eth, price_usd, dry_run, symbol, network, realized_pnl, timestamp)
      VALUES ('sell', 0.01, 1900, 0, 'ETH', 'base-mainnet', -1.0, datetime('now', '-3 days'))`).run();
    const report = generateReport(db);
    const eth = report.tokenMetrics.find(t => t.symbol === 'ETH');
    expect(eth).toBeDefined();
    expect(eth!.wins).toBe(1);
    expect(eth!.losses).toBe(1);
    expect(eth!.realized_pnl_7d).toBeCloseTo(1.5);
  });

  it('includes last 7 daily_pnl rows in chronological order', () => {
    for (let i = 7; i >= 1; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().slice(0, 10);
      db.prepare(`INSERT OR REPLACE INTO daily_pnl (date, network, high_water, current_usd, rotations, realized_pnl)
        VALUES (?, 'base-mainnet', 100, 100, 0, ?)`).run(ds, i * 0.5);
    }
    const report = generateReport(db);
    expect(report.dailyPnl).toHaveLength(7);
    // Chronological order — first entry is oldest
    expect(report.dailyPnl[0].date < report.dailyPnl[6].date).toBe(true);
  });
});
