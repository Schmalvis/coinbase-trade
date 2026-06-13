import type { Database as DB } from 'better-sqlite3';
import { db } from './connection.js';
import { runMigrations } from './migrations.js';

export function initSchema(db: DB): void {
  runMigrations(db);

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
      score_delta         REAL,
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
      strategy    TEXT NOT NULL DEFAULT 'threshold' CHECK(strategy IN ('threshold','sma','grid')),
      discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (address, network)
    )
  `).run();

  db.exec(`
    CREATE TABLE IF NOT EXISTS grid_state (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol        TEXT NOT NULL,
      network       TEXT NOT NULL,
      level_price   REAL NOT NULL,
      state         TEXT NOT NULL CHECK(state IN ('pending_buy','pending_sell','idle')),
      last_triggered TEXT,
      UNIQUE(symbol, network, level_price)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS passkeys (
      id              TEXT PRIMARY KEY,
      public_key      TEXT NOT NULL,
      counter         INTEGER NOT NULL DEFAULT 0,
      transports      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      label           TEXT NOT NULL DEFAULT 'default'
    );
  `);

  // Seeds these defaults on first run only — manual changes via dashboard are preserved
  const SETTINGS_DEFAULTS: Array<{ key: string; value: string }> = [
    { key: 'ROTATION_BUY_THRESHOLD',    value: '20' },
    { key: 'ROTATION_SELL_THRESHOLD',   value: '-15' },
    { key: 'MIN_ROTATION_SCORE_DELTA',  value: '30' },
    { key: 'RISK_OFF_THRESHOLD',        value: '-30' },
    { key: 'OPTIMIZER_INTERVAL_SECONDS', value: '180' },
    { key: 'MAX_POSITION_PCT',          value: '30' },
    { key: 'MEMECOIN_CAP_PCT',          value: '20' },
    { key: 'MEMECOIN_COOLDOWN_SECONDS', value: '600' },
  ];

  const seedSetting = db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES (@key, @value)`
  );

  const seedSettings = db.transaction(() => {
    for (const s of SETTINGS_DEFAULTS) {
      seedSetting.run(s);
    }
  });
  seedSettings();
}

// Auto-run on import: ensures migrations execute before any query module
// evaluates db.prepare() calls (ES module re-exports resolve before the
// importing module's body runs, so an explicit initSchema(db) call in db.ts
// fires too late for queries/core.ts to see the migrated schema).
initSchema(db);
