// tests/apply-status.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyStatus } from '../src/scripts/apply-status.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

function makeDb(): Database.Database {
  const dbPath = path.join(os.tmpdir(), `applystatus-${Date.now()}-${Math.random()}.db`);
  const db = new Database(dbPath);
  db.exec(`
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
      discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (address, network)
    );
    CREATE TABLE asset_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      symbol TEXT NOT NULL,
      price_usd REAL NOT NULL DEFAULT 0,
      balance REAL NOT NULL DEFAULT 0
    );
  `);
  // AERO: pending with 25h+ of price data (eligible for promotion)
  db.prepare(`INSERT INTO discovered_assets (address, network, symbol, name, status, discovered_at)
    VALUES ('0xaero', 'base-mainnet', 'AERO', 'Aerodrome', 'pending', datetime('now', '-2 days'))`).run();
  db.prepare(`INSERT INTO asset_snapshots (symbol, timestamp, price_usd, balance)
    VALUES ('AERO', datetime('now', '-25 hours'), 1.5, 0)`).run();
  // DEGEN: active
  db.prepare(`INSERT INTO discovered_assets (address, network, symbol, name, status, discovered_at)
    VALUES ('0xdegen', 'base-mainnet', 'DEGEN', 'Degen', 'active', datetime('now', '-3 days'))`).run();
  // BRETT: dismissed
  db.prepare(`INSERT INTO discovered_assets (address, network, symbol, name, status, discovered_at)
    VALUES ('0xbrett', 'base-mainnet', 'BRETT', 'Brett', 'dismissed', datetime('now', '-5 days'))`).run();
  (db as any).__dbPath = dbPath;
  return db;
}

function closeDb(db: Database.Database) {
  db.close();
  const p = (db as any).__dbPath;
  if (p && fs.existsSync(p)) fs.unlinkSync(p);
}

describe('applyStatus', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => closeDb(db));

  it('promotes pending → active and sets shadow_until 24h from now', () => {
    const before = Date.now();
    const r = applyStatus(db, 'AERO', 'base-mainnet', 'active');
    expect(r.accepted).toBe(true);
    expect(r.shadow_until).toBeGreaterThan(before + 23 * 3600 * 1000);
    const row = db.prepare(`SELECT status, shadow_until FROM discovered_assets WHERE symbol = 'AERO'`).get() as any;
    expect(row.status).toBe('active');
    expect(row.shadow_until).toBeGreaterThan(Date.now());
  });

  it('dismisses active → dismissed and clears shadow_until', () => {
    const r = applyStatus(db, 'DEGEN', 'base-mainnet', 'dismissed');
    expect(r.accepted).toBe(true);
    const row = db.prepare(`SELECT status, shadow_until FROM discovered_assets WHERE symbol = 'DEGEN'`).get() as any;
    expect(row.status).toBe('dismissed');
    expect(row.shadow_until).toBeNull();
  });

  it('rejects dismissed → active', () => {
    const r = applyStatus(db, 'BRETT', 'base-mainnet', 'active');
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/dismissed/i);
  });

  it('rejects unknown asset', () => {
    const r = applyStatus(db, 'NOSUCHTOKEN', 'base-mainnet', 'active');
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/not found/i);
  });

  it('rejects promotion when no price snapshots older than 24h', () => {
    db.prepare(`INSERT INTO discovered_assets (address, network, symbol, name, status, discovered_at)
      VALUES ('0xnew', 'base-mainnet', 'NEWTOKEN', 'New', 'pending', datetime('now', '-1 hour'))`).run();
    const r = applyStatus(db, 'NEWTOKEN', 'base-mainnet', 'active');
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/data|24h|snapshot/i);
  });

  it('rejects invalid target status', () => {
    const r = applyStatus(db, 'AERO', 'base-mainnet', 'watching');
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/invalid/i);
  });
});
