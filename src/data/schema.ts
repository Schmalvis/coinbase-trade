import type { Database as DB } from 'better-sqlite3';
import { db } from './connection.js';

export function initSchema(db: DB): void {
  // Migration: add network column to existing DBs that predate this field
  try { db.exec(`ALTER TABLE trades ADD COLUMN network TEXT NOT NULL DEFAULT 'unknown'`); } catch { /* already exists */ }

  // Migrations: trades P&L and strategy columns
  try { db.exec(`ALTER TABLE trades ADD COLUMN entry_price REAL`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE trades ADD COLUMN realized_pnl REAL`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE trades ADD COLUMN strategy TEXT`); } catch { /* exists */ }

  // Migrations: discovered_assets grid columns
  try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN grid_manual_override INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN grid_upper_bound REAL`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN grid_lower_bound REAL`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN grid_levels INTEGER NOT NULL DEFAULT 10`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN grid_amount_pct REAL NOT NULL DEFAULT 5.0`); } catch { /* exists */ }

  // Migrations: discovered_assets SMA toggle columns
  try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN sma_use_ema INTEGER NOT NULL DEFAULT 1`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN sma_volume_filter INTEGER NOT NULL DEFAULT 1`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN sma_rsi_filter INTEGER NOT NULL DEFAULT 1`); } catch { /* exists */ }

  // Migration: extend discovered_assets strategy CHECK constraint for new strategies
  try {
    db.exec(`INSERT INTO discovered_assets (address, network, symbol, name, strategy) VALUES ('__tcptest__', '__test__', '__test__', '', 'trend-continuation')`);
    db.exec(`DELETE FROM discovered_assets WHERE address = '__tcptest__'`);
  } catch {
    // CHECK constraint doesn't include new strategies — rebuild table
    const rebuildDiscoveredAssets = db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS discovered_assets_v2 (
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
        strategy    TEXT NOT NULL DEFAULT 'threshold' CHECK(strategy IN ('threshold','sma','grid','momentum-burst','volatility-breakout','trend-continuation')),
        discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
        grid_manual_override INTEGER NOT NULL DEFAULT 0,
        grid_upper_bound REAL,
        grid_lower_bound REAL,
        grid_levels INTEGER NOT NULL DEFAULT 10,
        grid_amount_pct REAL NOT NULL DEFAULT 5.0,
        sma_use_ema INTEGER NOT NULL DEFAULT 1,
        sma_volume_filter INTEGER NOT NULL DEFAULT 1,
        sma_rsi_filter INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (address, network)
      )`);
      db.exec(`INSERT INTO discovered_assets_v2
        SELECT address, network, symbol, name, decimals, status, drop_pct, rise_pct,
               sma_short, sma_long, strategy, discovered_at, grid_manual_override,
               grid_upper_bound, grid_lower_bound, grid_levels, grid_amount_pct,
               sma_use_ema, sma_volume_filter, sma_rsi_filter
        FROM discovered_assets`);
      db.exec(`DROP TABLE discovered_assets`);
      db.exec(`ALTER TABLE discovered_assets_v2 RENAME TO discovered_assets`);
    });
    try { rebuildDiscoveredAssets(); } catch { /* non-fatal — new strategies unavailable via UI but existing data preserved */ }
  }

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
}

// Auto-run on import: ensures migrations execute before any query module
// evaluates db.prepare() calls (ES module re-exports resolve before the
// importing module's body runs, so an explicit initSchema(db) call in db.ts
// fires too late for queries/core.ts to see the migrated schema).
initSchema(db);
