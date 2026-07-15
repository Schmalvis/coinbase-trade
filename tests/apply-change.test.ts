// tests/apply-change.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyChange } from '../src/scripts/apply-change.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

function makeFetchStub(status = 200, body: unknown = { ok: true }) {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, calls };
}

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
      sma_use_ema INTEGER NOT NULL DEFAULT 1,
      sma_volume_filter INTEGER NOT NULL DEFAULT 1,
      sma_rsi_filter INTEGER NOT NULL DEFAULT 1,
      grid_levels INTEGER DEFAULT 10,
      grid_upper_bound REAL,
      grid_lower_bound REAL,
      grid_manual_override INTEGER NOT NULL DEFAULT 0,
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

const opts = (stub: ReturnType<typeof makeFetchStub>) => ({
  fetchImpl: stub.fn,
  baseUrl: 'http://bot.test',
  token: 'test-secret',
});

describe('applyChange — global settings', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => closeDb(db));

  it('rejects DRY_RUN unconditionally, zero http calls', async () => {
    const stub = makeFetchStub();
    const r = await applyChange(db, 'DRY_RUN', 'true', undefined, undefined, opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/DRY_RUN/i);
    expect(stub.calls.length).toBe(0);
  });

  it('rejects unknown key, zero http calls', async () => {
    const stub = makeFetchStub();
    const r = await applyChange(db, 'MADE_UP_KEY', '10', undefined, undefined, opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/unknown/i);
    expect(stub.calls.length).toBe(0);
  });

  it('rejects non-numeric value, zero http calls', async () => {
    const stub = makeFetchStub();
    const r = await applyChange(db, 'ROTATION_BUY_THRESHOLD', 'abc', undefined, undefined, opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/not a number/i);
    expect(stub.calls.length).toBe(0);
  });

  it('rejects change beyond +20% of current value, zero http calls', async () => {
    // ROTATION_BUY_THRESHOLD is 20; +21% = 24.2 — try 25
    const stub = makeFetchStub();
    const r = await applyChange(db, 'ROTATION_BUY_THRESHOLD', '25', undefined, undefined, opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/20%/i);
    expect(stub.calls.length).toBe(0);
  });

  it('rejects change beyond -20% of current value, zero http calls', async () => {
    // ROTATION_BUY_THRESHOLD is 20; -20% floor = 16 — try 15
    const stub = makeFetchStub();
    const r = await applyChange(db, 'ROTATION_BUY_THRESHOLD', '15', undefined, undefined, opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/20%/i);
    expect(stub.calls.length).toBe(0);
  });

  it('accepts valid change within ±20% — POSTs to /api/settings and does not write DB directly', async () => {
    // 20 * 0.8 = 16 — within range
    const stub = makeFetchStub(200, { ok: true });
    const r = await applyChange(db, 'ROTATION_BUY_THRESHOLD', '16', undefined, undefined, opts(stub));
    expect(r.accepted).toBe(true);
    expect(r.newValue).toBe(16);
    expect(r.oldValue).toBe(20);

    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0].url).toBe('http://bot.test/api/settings');
    expect(stub.calls[0].init.method).toBe('POST');
    expect(stub.calls[0].init.headers.Authorization).toBe('Bearer test-secret');
    expect(JSON.parse(stub.calls[0].init.body)).toEqual({ changes: { ROTATION_BUY_THRESHOLD: 16 } });

    // Regression proof: apply-change no longer writes the settings row directly.
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'ROTATION_BUY_THRESHOLD'`).get() as { value: string };
    expect(Number(row.value)).toBe(20);

    // Session count still increments on success
    const countRow = db.prepare(`SELECT value FROM settings WHERE key = 'review_session_count'`).get() as { value: string };
    expect(Number(countRow.value)).toBe(1);
  });

  it('server 400 rejection surfaces server error, no increment', async () => {
    const stub = makeFetchStub(400, { error: 'ROTATION_BUY_THRESHOLD: bad value', field: 'ROTATION_BUY_THRESHOLD' });
    const r = await applyChange(db, 'ROTATION_BUY_THRESHOLD', '16', undefined, undefined, opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/bad value/);
    const countRow = db.prepare(`SELECT value FROM settings WHERE key = 'review_session_count'`).get() as { value: string } | undefined;
    expect(countRow).toBeUndefined();
  });

  it('bot unreachable (fetch throws) fails closed, no write, no increment', async () => {
    const fn = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    const r = await applyChange(db, 'ROTATION_BUY_THRESHOLD', '16', undefined, undefined, { fetchImpl: fn, baseUrl: 'http://bot.test', token: 'test-secret' });
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/unreachable/i);
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'ROTATION_BUY_THRESHOLD'`).get() as { value: string };
    expect(Number(row.value)).toBe(20);
    const countRow = db.prepare(`SELECT value FROM settings WHERE key = 'review_session_count'`).get() as { value: string } | undefined;
    expect(countRow).toBeUndefined();
  });

  it('auth 403 surfaces auth failure reason', async () => {
    const stub = makeFetchStub(403, { error: 'Invalid dashboard secret' });
    const r = await applyChange(db, 'ROTATION_BUY_THRESHOLD', '16', undefined, undefined, opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/auth/i);
  });

  it('auth 401 surfaces auth failure reason', async () => {
    const stub = makeFetchStub(401, { error: 'Authorization required' });
    const r = await applyChange(db, 'ROTATION_BUY_THRESHOLD', '16', undefined, undefined, opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/auth/i);
  });

  it('rejects PORTFOLIO_FLOOR_USD below $80, zero http calls', async () => {
    // 80 * 0.85 = 68 — below $80 hard floor
    const stub = makeFetchStub();
    const r = await applyChange(db, 'PORTFOLIO_FLOOR_USD', '68', undefined, undefined, opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/floor|\$80/i);
    expect(stub.calls.length).toBe(0);
  });

  it('rejects MAX_POSITION_PCT outside 15–45 range, zero http calls', async () => {
    const stub = makeFetchStub();
    const r = await applyChange(db, 'MAX_POSITION_PCT', '14', undefined, undefined, opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/15.*45|range/i);
    expect(stub.calls.length).toBe(0);
  });

  it('enforces max 3 numeric changes per session', async () => {
    const stub = makeFetchStub();
    await applyChange(db, 'MEMECOIN_CAP_PCT', '24', undefined, undefined, opts(stub));            // 20 → 24 (+20%)
    await applyChange(db, 'OPTIMIZER_INTERVAL_SECONDS', '144', undefined, undefined, opts(stub)); // 180 → 144 (-20%)
    await applyChange(db, 'MIN_ROTATION_SCORE_DELTA', '24', undefined, undefined, opts(stub));    // 30 → 24 (-20%)
    const r = await applyChange(db, 'ROTATION_BUY_THRESHOLD', '16', undefined, undefined, opts(stub)); // 4th → rejected
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/session.*limit|3.*changes/i);
    expect(stub.calls.length).toBe(3);
  });

  it('rejects MEMECOIN_CAP_PCT outside 10–35 range, zero http calls', async () => {
    // Reset current to 30 to make 36 reachable via ±20%
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('MEMECOIN_CAP_PCT', '30')`).run();
    const stub = makeFetchStub();
    const r = await applyChange(db, 'MEMECOIN_CAP_PCT', '36', undefined, undefined, opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/10.*35|range/i);
    expect(stub.calls.length).toBe(0);
  });

  it('rejects OPTIMIZER_INTERVAL_SECONDS outside 120–600 range, zero http calls', async () => {
    // Reset to 150 so 150*0.8=120 is the boundary; request 100
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('OPTIMIZER_INTERVAL_SECONDS', '150')`).run();
    const stub = makeFetchStub();
    const r = await applyChange(db, 'OPTIMIZER_INTERVAL_SECONDS', '100', undefined, undefined, opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/120.*600|range/i);
    expect(stub.calls.length).toBe(0);
  });

  it('enforces ±20% cap correctly for negative thresholds', async () => {
    // RISK_OFF_THRESHOLD = -30; ±20% window is [-36, -24]
    // -38 is outside (more negative than -36) → reject, zero http calls
    const stub1 = makeFetchStub();
    const r1 = await applyChange(db, 'RISK_OFF_THRESHOLD', '-38', undefined, undefined, opts(stub1));
    expect(r1.accepted).toBe(false);
    expect(r1.reason).toMatch(/20%/i);
    expect(stub1.calls.length).toBe(0);

    // -33 is inside → accept
    const stub2 = makeFetchStub();
    const r2 = await applyChange(db, 'RISK_OFF_THRESHOLD', '-33', undefined, undefined, opts(stub2));
    expect(r2.accepted).toBe(true);
    expect(stub2.calls.length).toBe(1);
  });
});

describe('applyChange — per-asset params', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    db.prepare(`INSERT INTO discovered_assets (address, network, symbol, name, status, drop_pct, rise_pct)
      VALUES ('0xaero', 'base-mainnet', 'AERO', 'Aerodrome', 'active', 0.7, 1.0)`).run();
    db.prepare(`INSERT INTO discovered_assets (address, network, symbol, name, status, strategy, grid_levels, grid_upper_bound, grid_lower_bound, grid_manual_override)
      VALUES ('0xgrid', 'base-mainnet', 'GRID', 'GridToken', 'active', 'grid', 8, 100, 50, 1)`).run();
    db.prepare(`INSERT INTO discovered_assets (address, network, symbol, name, status, strategy, grid_levels, grid_manual_override)
      VALUES ('0xgridauto', 'base-mainnet', 'GRIDAUTO', 'GridAutoToken', 'active', 'grid', 6, 0)`).run();
  });
  afterEach(() => closeDb(db));

  it('accepts valid drop_pct change for known asset — PUTs full echo body, DB row unchanged', async () => {
    const stub = makeFetchStub(200, { ok: true });
    const r = await applyChange(db, 'drop_pct', '0.56', 'AERO', 'base-mainnet', opts(stub));
    expect(r.accepted).toBe(true);
    expect(r.newValue).toBeCloseTo(0.56);
    expect(r.symbol).toBe('AERO');

    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0].url).toBe('http://bot.test/api/assets/0xaero/config');
    expect(stub.calls[0].init.method).toBe('PUT');
    expect(stub.calls[0].init.headers.Authorization).toBe('Bearer test-secret');
    const body = JSON.parse(stub.calls[0].init.body);
    expect(body).toEqual({
      strategyType: 'threshold',
      dropPct: 0.56,
      risePct: 1.0,
      smaShort: 5,
      smaLong: 20,
      smaUseEma: true,
      smaVolumeFilter: true,
      smaRsiFilter: true,
    });

    // Regression proof: apply-change no longer writes the discovered_assets row directly.
    const row = db.prepare(`SELECT drop_pct FROM discovered_assets WHERE symbol = 'AERO'`).get() as { drop_pct: number };
    expect(row.drop_pct).toBeCloseTo(0.7);
  });

  it('grid asset with manual override sends bounds', async () => {
    // drop_pct default is 2.0 — 2.2 is within the ±20% cap ([1.6, 2.4])
    const stub = makeFetchStub(200, { ok: true });
    await applyChange(db, 'drop_pct', '2.2', 'GRID', 'base-mainnet', opts(stub));
    const body = JSON.parse(stub.calls[0].init.body);
    expect(body.grid_levels).toBe(8);
    expect(body.grid_upper_bound).toBe(100);
    expect(body.grid_lower_bound).toBe(50);
  });

  it('grid asset without manual override omits bounds', async () => {
    const stub = makeFetchStub(200, { ok: true });
    await applyChange(db, 'drop_pct', '2.2', 'GRIDAUTO', 'base-mainnet', opts(stub));
    const body = JSON.parse(stub.calls[0].init.body);
    expect(body.grid_levels).toBe(6);
    expect('grid_upper_bound' in body).toBe(false);
    expect('grid_lower_bound' in body).toBe(false);
  });

  it('rejects per-asset change for unknown asset, zero http calls', async () => {
    const stub = makeFetchStub();
    const r = await applyChange(db, 'drop_pct', '0.56', 'NOSUCHTOKEN', 'base-mainnet', opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/not found/i);
    expect(stub.calls.length).toBe(0);
  });

  it('rejects per-asset change for a non-active (pending/dismissed) asset, zero http calls', async () => {
    // Guard: the review agent must never start a live loop for an unvetted token.
    db.prepare(`INSERT INTO discovered_assets (address, network, symbol, name, status, drop_pct, rise_pct)
      VALUES ('0xspam', 'base-mainnet', 'SPAM', 'SpamToken', 'pending', 5.0, 5.0)`).run();
    const stub = makeFetchStub();
    const r = await applyChange(db, 'drop_pct', '5.5', 'SPAM', 'base-mainnet', opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/not active/i);
    expect(stub.calls.length).toBe(0);
  });

  it('rejects non-integer sma_short pre-flight, zero http calls', async () => {
    const stub = makeFetchStub();
    const r = await applyChange(db, 'sma_short', '5.5', 'AERO', 'base-mainnet', opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/integer/i);
    expect(stub.calls.length).toBe(0);
  });

  it('server 400 on per-asset change surfaces server error, no increment', async () => {
    const stub = makeFetchStub(400, { error: 'dropPct must be a number >= 0.1' });
    const r = await applyChange(db, 'drop_pct', '0.56', 'AERO', 'base-mainnet', opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/dropPct/);
    const countRow = db.prepare(`SELECT value FROM settings WHERE key = 'review_session_count'`).get() as { value: string } | undefined;
    expect(countRow).toBeUndefined();
  });

  it('bot unreachable on per-asset change fails closed, no write', async () => {
    const fn = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    const r = await applyChange(db, 'drop_pct', '0.56', 'AERO', 'base-mainnet', { fetchImpl: fn, baseUrl: 'http://bot.test', token: 'test-secret' });
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/unreachable/i);
    const row = db.prepare(`SELECT drop_pct FROM discovered_assets WHERE symbol = 'AERO'`).get() as { drop_pct: number };
    expect(row.drop_pct).toBeCloseTo(0.7);
  });

  it('counts per-asset change toward session limit (mixed global + per-asset)', async () => {
    const stub = makeFetchStub();
    await applyChange(db, 'MEMECOIN_CAP_PCT', '24', undefined, undefined, opts(stub));
    await applyChange(db, 'OPTIMIZER_INTERVAL_SECONDS', '144', undefined, undefined, opts(stub));
    await applyChange(db, 'drop_pct', '0.56', 'AERO', 'base-mainnet', opts(stub)); // 3rd
    const r = await applyChange(db, 'MIN_ROTATION_SCORE_DELTA', '24', undefined, undefined, opts(stub)); // 4th → rejected
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/session.*limit|3.*changes/i);
    expect(stub.calls.length).toBe(3);
  });
});
