// tests/apply-status.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyStatus } from '../src/scripts/apply-status.js';
import { makeFetchStub } from './helpers/fetch-stub.js';
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
      sma_use_ema INTEGER NOT NULL DEFAULT 1,
      sma_volume_filter INTEGER NOT NULL DEFAULT 1,
      sma_rsi_filter INTEGER NOT NULL DEFAULT 1,
      grid_levels INTEGER DEFAULT 10,
      grid_upper_bound REAL,
      grid_lower_bound REAL,
      grid_manual_override INTEGER NOT NULL DEFAULT 0,
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

const opts = (stub: ReturnType<typeof makeFetchStub>) => ({
  fetchImpl: stub.fn,
  baseUrl: 'http://bot.test',
  token: 'test-secret',
});

describe('applyStatus', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => closeDb(db));

  // ── Zero-HTTP guards ─────────────────────────────────────────────────────────

  it('rejects invalid target status, zero http calls', async () => {
    const stub = makeFetchStub();
    const r = await applyStatus(db, 'AERO', 'base-mainnet', 'watching', opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/invalid/i);
    expect(stub.calls.length).toBe(0);
  });

  it('rejects unknown asset, zero http calls', async () => {
    const stub = makeFetchStub();
    const r = await applyStatus(db, 'NOSUCHTOKEN', 'base-mainnet', 'active', opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/not found/i);
    expect(stub.calls.length).toBe(0);
  });

  it('rejects dismissed → active, zero http calls', async () => {
    const stub = makeFetchStub();
    const r = await applyStatus(db, 'BRETT', 'base-mainnet', 'active', opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/dismissed/i);
    expect(stub.calls.length).toBe(0);
  });

  it('active → active is a no-op, zero http calls', async () => {
    const stub = makeFetchStub();
    const r = await applyStatus(db, 'DEGEN', 'base-mainnet', 'active', opts(stub));
    expect(r.accepted).toBe(true);
    expect(r.reason).toMatch(/no change needed/i);
    expect(stub.calls.length).toBe(0);
  });

  it('rejects promotion when no price snapshots older than 24h, zero http calls', async () => {
    db.prepare(`INSERT INTO discovered_assets (address, network, symbol, name, status, discovered_at)
      VALUES ('0xnew', 'base-mainnet', 'NEWTOKEN', 'New', 'pending', datetime('now', '-1 hour'))`).run();
    const stub = makeFetchStub();
    const r = await applyStatus(db, 'NEWTOKEN', 'base-mainnet', 'active', opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/data|24h|snapshot/i);
    expect(stub.calls.length).toBe(0);
  });

  // ── Enable happy path ────────────────────────────────────────────────────────

  it('promotes pending → active via POST /enable, full echo body, shadow read-back', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fn = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      db.prepare(`UPDATE discovered_assets SET status='active', shadow_until=? WHERE address='0xaero'`)
        .run(Date.now() + 24 * 3600 * 1000);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const before = Date.now();
    const r = await applyStatus(db, 'AERO', 'base-mainnet', 'active', { fetchImpl: fn, baseUrl: 'http://bot.test', token: 'test-secret' });

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('http://bot.test/api/assets/0xaero/enable');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-secret');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      strategyType: 'threshold', dropPct: 2, risePct: 3, smaShort: 5, smaLong: 20,
      smaUseEma: true, smaVolumeFilter: true, smaRsiFilter: true,
    });

    expect(r.accepted).toBe(true);
    expect(r.newStatus).toBe('active');
    expect(r.shadow_until).toBeGreaterThan(before + 23 * 3600 * 1000);
    expect(r.reason).toMatch(/shadow/i);
  });

  // ── Grid echo ────────────────────────────────────────────────────────────────

  it('grid asset with manual override sends bounds in the enable body', async () => {
    db.prepare(`INSERT INTO discovered_assets (address, network, symbol, name, status, discovered_at, strategy, grid_levels, grid_upper_bound, grid_lower_bound, grid_manual_override)
      VALUES ('0xgrid', 'base-mainnet', 'GRID', 'GridToken', 'pending', datetime('now', '-2 days'), 'grid', 8, 100, 50, 1)`).run();
    db.prepare(`INSERT INTO asset_snapshots (symbol, timestamp, price_usd, balance)
      VALUES ('GRID', datetime('now', '-25 hours'), 10, 0)`).run();
    const stub = makeFetchStub(200, { ok: true });
    await applyStatus(db, 'GRID', 'base-mainnet', 'active', opts(stub));
    const body = JSON.parse(stub.calls[0].init.body);
    expect(body.grid_levels).toBe(8);
    expect(body.grid_upper_bound).toBe(100);
    expect(body.grid_lower_bound).toBe(50);
  });

  it('grid asset without manual override omits bounds in the enable body', async () => {
    db.prepare(`INSERT INTO discovered_assets (address, network, symbol, name, status, discovered_at, strategy, grid_levels, grid_manual_override)
      VALUES ('0xgridauto', 'base-mainnet', 'GRIDAUTO', 'GridAutoToken', 'pending', datetime('now', '-2 days'), 'grid', 6, 0)`).run();
    db.prepare(`INSERT INTO asset_snapshots (symbol, timestamp, price_usd, balance)
      VALUES ('GRIDAUTO', datetime('now', '-25 hours'), 10, 0)`).run();
    const stub = makeFetchStub(200, { ok: true });
    await applyStatus(db, 'GRIDAUTO', 'base-mainnet', 'active', opts(stub));
    const body = JSON.parse(stub.calls[0].init.body);
    expect(body.grid_levels).toBe(6);
    expect('grid_upper_bound' in body).toBe(false);
    expect('grid_lower_bound' in body).toBe(false);
  });

  // ── Dismiss happy path ───────────────────────────────────────────────────────

  it('dismisses active → dismissed via POST /dismiss, no body', async () => {
    const stub = makeFetchStub(200, { ok: true });
    const r = await applyStatus(db, 'DEGEN', 'base-mainnet', 'dismissed', opts(stub));
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0].url).toBe('http://bot.test/api/assets/0xdegen/dismiss');
    expect(stub.calls[0].init.method).toBe('POST');
    expect(stub.calls[0].init.body).toBeUndefined();
    expect(stub.calls[0].init.headers.Authorization).toBe('Bearer test-secret');
    expect(r.accepted).toBe(true);
    expect(r.newStatus).toBe('dismissed');
  });

  it('dismissed → dismissed is a no-op, zero http calls', async () => {
    const stub = makeFetchStub();
    const r = await applyStatus(db, 'BRETT', 'base-mainnet', 'dismissed', opts(stub));
    expect(r.accepted).toBe(true);
    expect(r.reason).toMatch(/no change needed/i);
    expect(stub.calls.length).toBe(0);
  });

  // ── Server errors ────────────────────────────────────────────────────────────

  it('server 400 rejection surfaces server error reason', async () => {
    const stub = makeFetchStub(400, { error: 'AERO: no buy liquidity' });
    const r = await applyStatus(db, 'AERO', 'base-mainnet', 'active', opts(stub));
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/Rejected by bot/);
    expect(r.reason).toMatch(/no buy liquidity/);
  });

  it('bot unreachable (fetch throws) fails closed, no fallback write', async () => {
    const fn = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    const r = await applyStatus(db, 'DEGEN', 'base-mainnet', 'dismissed', { fetchImpl: fn, baseUrl: 'http://bot.test', token: 'test-secret' });
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/unreachable/i);
    const row = db.prepare(`SELECT status FROM discovered_assets WHERE symbol = 'DEGEN'`).get() as any;
    expect(row.status).toBe('active'); // unchanged
  });

  // ── Regression: script no longer writes directly ────────────────────────────

  it('regression: a plain-200-stub enable does not write the DB itself (server-side only)', async () => {
    const stub = makeFetchStub(200, { ok: true }); // stub does NOT simulate the server's write
    const r = await applyStatus(db, 'AERO', 'base-mainnet', 'active', opts(stub));
    expect(r.accepted).toBe(true);
    // apply-status never writes discovered_assets itself; since our stub didn't either,
    // the row must be exactly as it was before the call.
    const row = db.prepare(`SELECT status, shadow_until FROM discovered_assets WHERE symbol = 'AERO'`).get() as any;
    expect(row.status).toBe('pending');
    expect(row.shadow_until).toBeNull();
  });

  it('regression: dismiss does not write the DB itself (server-side only)', async () => {
    const stub = makeFetchStub(200, { ok: true });
    const r = await applyStatus(db, 'DEGEN', 'base-mainnet', 'dismissed', opts(stub));
    expect(r.accepted).toBe(true);
    const row = db.prepare(`SELECT status FROM discovered_assets WHERE symbol = 'DEGEN'`).get() as any;
    expect(row.status).toBe('active'); // unchanged — apply-status made no DB write
  });

  // ── Case-insensitive snapshot lookup ─────────────────────────────────────────

  it('promotes when snapshot is stored with different case', async () => {
    // asset_snapshots may store lowercase symbol from portfolio tracker
    db.prepare(`INSERT INTO discovered_assets (address, network, symbol, name, status, discovered_at)
      VALUES ('0xwell', 'base-mainnet', 'WELL', 'Moonwell', 'pending', datetime('now', '-2 days'))`).run();
    db.prepare(`INSERT INTO asset_snapshots (symbol, timestamp, price_usd, balance)
      VALUES ('well', datetime('now', '-25 hours'), 0.5, 0)`).run();
    const stub = makeFetchStub(200, { ok: true });
    const r = await applyStatus(db, 'WELL', 'base-mainnet', 'active', opts(stub));
    expect(r.accepted).toBe(true);
  });

  // ── Duplicate-symbol deterministic resolution ────────────────────────────────

  describe('duplicate-symbol rows', () => {
    beforeEach(() => {
      db.prepare(`INSERT INTO discovered_assets (address, network, symbol, name, status, discovered_at)
        VALUES ('0xtrump1', 'base-mainnet', 'TRUMP', 'Trump Dismissed', 'dismissed', datetime('now', '-10 days'))`).run();
      db.prepare(`INSERT INTO discovered_assets (address, network, symbol, name, status, discovered_at)
        VALUES ('0xtrump2', 'base-mainnet', 'TRUMP', 'Trump Pending', 'pending', datetime('now', '-2 days'))`).run();
      db.prepare(`INSERT INTO asset_snapshots (symbol, timestamp, price_usd, balance)
        VALUES ('TRUMP', datetime('now', '-25 hours'), 12, 0)`).run();
    });

    it('dismiss resolves to the active/pending row, not the already-dismissed one', async () => {
      const stub = makeFetchStub(200, { ok: true });
      const r = await applyStatus(db, 'TRUMP', 'base-mainnet', 'dismissed', opts(stub));
      expect(stub.calls.length).toBe(1);
      expect(stub.calls[0].url).toBe('http://bot.test/api/assets/0xtrump2/dismiss');
      expect(r.accepted).toBe(true);
    });

    it('active (enable) resolves to the pending row, not the dismissed one', async () => {
      const stub = makeFetchStub(200, { ok: true });
      const r = await applyStatus(db, 'TRUMP', 'base-mainnet', 'active', opts(stub));
      expect(stub.calls.length).toBe(1);
      expect(stub.calls[0].url).toBe('http://bot.test/api/assets/0xtrump2/enable');
      expect(r.accepted).toBe(true);
    });
  });
});
