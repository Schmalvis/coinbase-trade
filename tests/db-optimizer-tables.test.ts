import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database, { type Database as DB } from 'better-sqlite3';

const DDL = `
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
`;

let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(DDL);
});

afterEach(() => {
  db.close();
});

describe('optimizer tables schema', () => {
  it('candles table has correct columns', () => {
    const cols = db.pragma('table_info(candles)') as { name: string }[];
    const names = cols.map(c => c.name);
    expect(names).toEqual([
      'id', 'symbol', 'network', 'interval', 'open_time',
      'open', 'high', 'low', 'close', 'volume', 'source',
    ]);
  });

  it('watchlist table has correct columns', () => {
    const cols = db.pragma('table_info(watchlist)') as { name: string }[];
    const names = cols.map(c => c.name);
    expect(names).toEqual([
      'id', 'symbol', 'network', 'address', 'source',
      'added_at', 'status', 'coinbase_pair',
    ]);
  });

  it('rotations table has correct columns', () => {
    const cols = db.pragma('table_info(rotations)') as { name: string }[];
    const names = cols.map(c => c.name);
    expect(names).toEqual([
      'id', 'timestamp', 'sell_symbol', 'buy_symbol', 'sell_amount',
      'buy_amount', 'sell_tx_hash', 'buy_tx_hash', 'estimated_gain_pct',
      'actual_gain_pct', 'estimated_fee_pct', 'status', 'veto_reason',
      'dry_run', 'network',
    ]);
  });

  it('daily_pnl table has correct columns', () => {
    const cols = db.pragma('table_info(daily_pnl)') as { name: string }[];
    const names = cols.map(c => c.name);
    expect(names).toEqual([
      'date', 'network', 'high_water', 'current_usd', 'rotations', 'realized_pnl',
    ]);
  });
});

describe('candles UNIQUE constraint', () => {
  it('INSERT OR REPLACE overwrites on duplicate key', () => {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO candles (symbol, network, interval, open_time, open, high, low, close, volume, source)
      VALUES (@symbol, @network, @interval, @open_time, @open, @high, @low, @close, @volume, @source)
    `);

    insert.run({
      symbol: 'ETH', network: 'base-sepolia', interval: '1h',
      open_time: '2026-01-01T00:00:00Z', open: 100, high: 110, low: 95, close: 105, volume: 500, source: 'coinbase',
    });

    insert.run({
      symbol: 'ETH', network: 'base-sepolia', interval: '1h',
      open_time: '2026-01-01T00:00:00Z', open: 101, high: 112, low: 96, close: 108, volume: 600, source: 'coinbase',
    });

    const count = (db.prepare('SELECT COUNT(*) as cnt FROM candles').get() as { cnt: number }).cnt;
    expect(count).toBe(1);

    const row = db.prepare('SELECT * FROM candles WHERE symbol = ?').get('ETH') as any;
    expect(row.close).toBe(108); // replaced with second insert
  });

  it('allows different symbols with same open_time', () => {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO candles (symbol, network, interval, open_time, open, high, low, close, volume, source)
      VALUES (@symbol, @network, @interval, @open_time, @open, @high, @low, @close, @volume, @source)
    `);

    insert.run({
      symbol: 'ETH', network: 'base-sepolia', interval: '1h',
      open_time: '2026-01-01T00:00:00Z', open: 100, high: 110, low: 95, close: 105, volume: 500, source: 'coinbase',
    });

    insert.run({
      symbol: 'CBBTC', network: 'base-sepolia', interval: '1h',
      open_time: '2026-01-01T00:00:00Z', open: 40000, high: 41000, low: 39000, close: 40500, volume: 10, source: 'coinbase',
    });

    const count = (db.prepare('SELECT COUNT(*) as cnt FROM candles').get() as { cnt: number }).cnt;
    expect(count).toBe(2);
  });
});
