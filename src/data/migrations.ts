import type { Database as DB } from 'better-sqlite3';

interface Migration {
  version: number;
  description: string;
  run: (db: DB) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'add network column to trades',
    run: (db) => {
      try { db.exec(`ALTER TABLE trades ADD COLUMN network TEXT NOT NULL DEFAULT 'unknown'`); } catch { /* exists */ }
    },
  },
  {
    version: 2,
    description: 'add P&L and strategy columns to trades',
    run: (db) => {
      try { db.exec(`ALTER TABLE trades ADD COLUMN entry_price REAL`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE trades ADD COLUMN realized_pnl REAL`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE trades ADD COLUMN strategy TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE trades ADD COLUMN symbol TEXT`); } catch { /* exists */ }
    },
  },
  {
    version: 3,
    description: 'add grid columns to discovered_assets',
    run: (db) => {
      try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN grid_manual_override INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN grid_upper_bound REAL`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN grid_lower_bound REAL`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN grid_levels INTEGER NOT NULL DEFAULT 10`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN grid_amount_pct REAL NOT NULL DEFAULT 5.0`); } catch { /* exists */ }
    },
  },
  {
    version: 4,
    description: 'add SMA toggle columns to discovered_assets',
    run: (db) => {
      try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN sma_use_ema INTEGER NOT NULL DEFAULT 1`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN sma_volume_filter INTEGER NOT NULL DEFAULT 1`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN sma_rsi_filter INTEGER NOT NULL DEFAULT 1`); } catch { /* exists */ }
    },
  },
  {
    version: 5,
    description: 'add memecoin and shadow_until columns to discovered_assets',
    run: (db) => {
      try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN is_memecoin INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE discovered_assets ADD COLUMN shadow_until INTEGER`); } catch { /* exists */ }
    },
  },
  {
    version: 6,
    description: 'rebuild discovered_assets with expanded strategy CHECK constraint',
    run: (db) => {
      // Only applies to existing DBs — fresh DBs get the correct schema from CREATE TABLE IF NOT EXISTS in initSchema
      const tableExists = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='discovered_assets'`
      ).get();
      if (!tableExists) return;

      try {
        db.exec(`INSERT INTO discovered_assets (address, network, symbol, name, strategy)
                 VALUES ('__tcptest__', '__test__', '__test__', '', 'trend-continuation')`);
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
            strategy    TEXT NOT NULL DEFAULT 'threshold'
                        CHECK(strategy IN ('threshold','sma','grid','momentum-burst','volatility-breakout','trend-continuation')),
            discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
            grid_manual_override INTEGER NOT NULL DEFAULT 0,
            grid_upper_bound REAL,
            grid_lower_bound REAL,
            grid_levels INTEGER NOT NULL DEFAULT 10,
            grid_amount_pct REAL NOT NULL DEFAULT 5.0,
            sma_use_ema INTEGER NOT NULL DEFAULT 1,
            sma_volume_filter INTEGER NOT NULL DEFAULT 1,
            sma_rsi_filter INTEGER NOT NULL DEFAULT 1,
            is_memecoin INTEGER NOT NULL DEFAULT 0,
            shadow_until INTEGER,
            PRIMARY KEY (address, network)
          )`);
          db.exec(`INSERT INTO discovered_assets_v2
            SELECT address, network, symbol, name, decimals, status, drop_pct, rise_pct,
                   sma_short, sma_long, strategy, discovered_at, grid_manual_override,
                   grid_upper_bound, grid_lower_bound, grid_levels, grid_amount_pct,
                   sma_use_ema, sma_volume_filter, sma_rsi_filter,
                   COALESCE(is_memecoin, 0) AS is_memecoin, shadow_until
            FROM discovered_assets`);
          db.exec(`DROP TABLE discovered_assets`);
          db.exec(`ALTER TABLE discovered_assets_v2 RENAME TO discovered_assets`);
        });
        try { rebuildDiscoveredAssets(); } catch { /* non-fatal — existing data preserved */ }
      }
    },
  },
];

export function getSchemaVersion(db: DB): number {
  try {
    const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}

export function runMigrations(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
      description TEXT NOT NULL
    )
  `);

  const currentVersion = getSchemaVersion(db);
  const record = db.prepare(
    `INSERT OR IGNORE INTO schema_version (version, description) VALUES (?, ?)`
  );

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    db.transaction(() => {
      migration.run(db);
      record.run(migration.version, migration.description);
    })();
  }
}
