import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

const DDL = `
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
`;

describe('discovered_assets DDL', () => {
  it('inserts and retrieves a row with defaults', () => {
    const db = new Database(':memory:');
    db.prepare(DDL).run();
    db.prepare(`INSERT OR IGNORE INTO discovered_assets (address, network, symbol, name, decimals) VALUES (?, ?, ?, ?, ?)`).run('0xabc', 'base-mainnet', 'PEPE', 'Pepe Token', 18);
    const row = db.prepare(`SELECT * FROM discovered_assets WHERE address = ?`).get('0xabc') as any;
    expect(row.symbol).toBe('PEPE');
    expect(row.status).toBe('pending');
    expect(row.strategy).toBe('threshold');
    expect(row.drop_pct).toBe(2.0);
    expect(row.rise_pct).toBe(3.0);
    expect(row.name).toBe('Pepe Token');
    expect(row.decimals).toBe(18);
  });

  it('INSERT OR IGNORE does not overwrite existing row', () => {
    const db = new Database(':memory:');
    db.prepare(DDL).run();
    db.prepare(`INSERT OR IGNORE INTO discovered_assets (address, network, symbol, name, decimals) VALUES (?, ?, ?, ?, ?)`).run('0xabc', 'base-mainnet', 'PEPE', 'Pepe Token', 18);
    db.prepare(`UPDATE discovered_assets SET status = ? WHERE address = ? AND network = ?`).run('active', '0xabc', 'base-mainnet');
    db.prepare(`INSERT OR IGNORE INTO discovered_assets (address, network, symbol, name, decimals) VALUES (?, ?, ?, ?, ?)`).run('0xabc', 'base-mainnet', 'PEPE2', 'Different', 6);
    const row = db.prepare(`SELECT * FROM discovered_assets WHERE address = ? AND network = ?`).get('0xabc', 'base-mainnet') as any;
    expect(row.status).toBe('active');  // not overwritten
    expect(row.symbol).toBe('PEPE');

    // Verify network boundary: inserting same address with different network creates new row
    db.prepare(`INSERT OR IGNORE INTO discovered_assets (address, network, symbol, name, decimals) VALUES (?, ?, ?, ?, ?)`).run('0xabc', 'base-sepolia', 'PEPE', 'Pepe Token', 18);
    const count = db.prepare(`SELECT COUNT(*) as cnt FROM discovered_assets WHERE address = ?`).get('0xabc') as any;
    expect(count.cnt).toBe(2);  // two networks, same address
    const sepoliaRow = db.prepare(`SELECT * FROM discovered_assets WHERE address = ? AND network = ?`).get('0xabc', 'base-sepolia') as any;
    expect(sepoliaRow.network).toBe('base-sepolia');
  });
});
