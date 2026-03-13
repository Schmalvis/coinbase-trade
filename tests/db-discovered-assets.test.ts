import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

const DDL = `
  CREATE TABLE IF NOT EXISTS discovered_assets (
    address TEXT NOT NULL,
    network TEXT NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    decimals INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    strategy_type TEXT NOT NULL DEFAULT 'threshold',
    quote_asset TEXT NOT NULL DEFAULT 'USDC',
    drop_pct REAL NOT NULL DEFAULT 3.0,
    rise_pct REAL NOT NULL DEFAULT 4.0,
    sma_short INTEGER NOT NULL DEFAULT 5,
    sma_long INTEGER NOT NULL DEFAULT 20,
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
    expect(row.strategy_type).toBe('threshold');
    expect(row.drop_pct).toBe(3.0);
  });

  it('INSERT OR IGNORE does not overwrite existing row', () => {
    const db = new Database(':memory:');
    db.prepare(DDL).run();
    db.prepare(`INSERT OR IGNORE INTO discovered_assets (address, network, symbol, name, decimals) VALUES (?, ?, ?, ?, ?)`).run('0xabc', 'base-mainnet', 'PEPE', 'Pepe Token', 18);
    db.prepare(`UPDATE discovered_assets SET status = ? WHERE address = ?`).run('active', '0xabc');
    db.prepare(`INSERT OR IGNORE INTO discovered_assets (address, network, symbol, name, decimals) VALUES (?, ?, ?, ?, ?)`).run('0xabc', 'base-mainnet', 'PEPE2', 'Different', 6);
    const row = db.prepare(`SELECT * FROM discovered_assets WHERE address = ?`).get('0xabc') as any;
    expect(row.status).toBe('active');  // not overwritten
    expect(row.symbol).toBe('PEPE');
  });
});
