// tests/apply-change.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyChange } from '../src/scripts/apply-change.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

function makeDb(): Database.Database {
  const dbPath = path.join(os.tmpdir(), `applychange-${Date.now()}-${Math.random()}.db`);
  const db = new Database(dbPath);
  db.exec(`
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
      PRIMARY KEY (address, network)
    );
  `);
  const ins = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
  for (const [k, v] of [
    ['ROTATION_BUY_THRESHOLD', '20'],
    ['MIN_ROTATION_SCORE_DELTA', '30'],
    ['OPTIMIZER_INTERVAL_SECONDS', '180'],
    ['MAX_POSITION_PCT', '30'],
    ['PORTFOLIO_FLOOR_USD', '80'],
    ['DRY_RUN', 'false'],
    ['MEMECOIN_CAP_PCT', '20'],
    ['RISK_OFF_THRESHOLD', '-30'],
  ]) ins.run(k, v);
  (db as any).__dbPath = dbPath;
  return db;
}

function closeDb(db: Database.Database) {
  db.close();
  const p = (db as any).__dbPath;
  if (p && fs.existsSync(p)) fs.unlinkSync(p);
}

describe('applyChange — global settings', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => closeDb(db));

  it('rejects DRY_RUN unconditionally', () => {
    const r = applyChange(db, 'DRY_RUN', 'true');
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/DRY_RUN/i);
  });

  it('rejects unknown key', () => {
    const r = applyChange(db, 'MADE_UP_KEY', '10');
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/unknown/i);
  });

  it('rejects change beyond +20% of current value', () => {
    // ROTATION_BUY_THRESHOLD is 20; +21% = 24.2 — try 25
    const r = applyChange(db, 'ROTATION_BUY_THRESHOLD', '25');
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/20%/i);
  });

  it('accepts valid change within ±20%', () => {
    // 20 * 0.8 = 16 — within range
    const r = applyChange(db, 'ROTATION_BUY_THRESHOLD', '16');
    expect(r.accepted).toBe(true);
    expect(r.newValue).toBe(16);
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'ROTATION_BUY_THRESHOLD'`).get() as { value: string };
    expect(Number(row.value)).toBe(16);
  });

  it('rejects PORTFOLIO_FLOOR_USD below $80', () => {
    // 80 * 0.85 = 68 — below $80 hard floor
    const r = applyChange(db, 'PORTFOLIO_FLOOR_USD', '68');
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/floor|\$80/i);
  });

  it('rejects MAX_POSITION_PCT outside 15–45 range', () => {
    const r = applyChange(db, 'MAX_POSITION_PCT', '14');
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/15.*45|range/i);
  });

  it('enforces max 3 numeric changes per session', () => {
    applyChange(db, 'MEMECOIN_CAP_PCT', '24');            // 20 → 24 (+20%)
    applyChange(db, 'OPTIMIZER_INTERVAL_SECONDS', '144'); // 180 → 144 (-20%)
    applyChange(db, 'MIN_ROTATION_SCORE_DELTA', '24');    // 30 → 24 (-20%)
    const r = applyChange(db, 'ROTATION_BUY_THRESHOLD', '16'); // 4th → rejected
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/session.*limit|3.*changes/i);
  });

  it('rejects MEMECOIN_CAP_PCT outside 10–35 range', () => {
    // Reset current to 30 to make 36 reachable via ±20%
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('MEMECOIN_CAP_PCT', '30')`).run();
    const r = applyChange(db, 'MEMECOIN_CAP_PCT', '36');
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/10.*35|range/i);
  });

  it('rejects OPTIMIZER_INTERVAL_SECONDS outside 120–600 range', () => {
    // Reset to 150 so 150*0.8=120 is the boundary; request 100
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('OPTIMIZER_INTERVAL_SECONDS', '150')`).run();
    const r = applyChange(db, 'OPTIMIZER_INTERVAL_SECONDS', '100');
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/120.*600|range/i);
  });

  it('enforces ±20% cap correctly for negative thresholds', () => {
    // RISK_OFF_THRESHOLD = -30; ±20% window is [-36, -24]
    // -38 is outside (more negative than -36) → reject
    const r1 = applyChange(db, 'RISK_OFF_THRESHOLD', '-38');
    expect(r1.accepted).toBe(false);
    expect(r1.reason).toMatch(/20%/i);
    // -33 is inside → accept
    const r2 = applyChange(db, 'RISK_OFF_THRESHOLD', '-33');
    expect(r2.accepted).toBe(true);
  });
});

describe('applyChange — per-asset params', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    db.prepare(`INSERT INTO discovered_assets (address, network, symbol, name, drop_pct, rise_pct)
      VALUES ('0xaero', 'base-mainnet', 'AERO', 'Aerodrome', 0.7, 1.0)`).run();
  });
  afterEach(() => closeDb(db));

  it('accepts valid drop_pct change for known asset', () => {
    const r = applyChange(db, 'drop_pct', '0.56', 'AERO', 'base-mainnet');
    expect(r.accepted).toBe(true);
    expect(r.newValue).toBeCloseTo(0.56);
    const row = db.prepare(`SELECT drop_pct FROM discovered_assets WHERE symbol = 'AERO'`).get() as { drop_pct: number };
    expect(row.drop_pct).toBeCloseTo(0.56);
  });

  it('rejects per-asset change for unknown asset', () => {
    const r = applyChange(db, 'drop_pct', '0.56', 'NOSUCHTOKEN', 'base-mainnet');
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/not found/i);
  });

  it('counts per-asset change toward session limit', () => {
    applyChange(db, 'MEMECOIN_CAP_PCT', '24');
    applyChange(db, 'OPTIMIZER_INTERVAL_SECONDS', '144');
    applyChange(db, 'drop_pct', '0.56', 'AERO', 'base-mainnet'); // 3rd
    const r = applyChange(db, 'MIN_ROTATION_SCORE_DELTA', '24'); // 4th → rejected
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/session.*limit|3.*changes/i);
  });
});
