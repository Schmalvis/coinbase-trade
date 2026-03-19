import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { RuntimeConfig } from '../src/core/runtime-config.js';

// Re-usable in-memory DB factory (mirrors settingQueries shape)
function makeTestQueries() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  return {
    getSetting:    db.prepare('SELECT value FROM settings WHERE key = ?'),
    upsertSetting: db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `),
    getAllSettings: db.prepare('SELECT key, value FROM settings'),
  };
}

// Minimal defaults matching the shape of config
const defaults = {
  STRATEGY: 'threshold' as const,
  TRADE_INTERVAL_SECONDS: 60,
  POLL_INTERVAL_SECONDS: 30,
  PRICE_DROP_THRESHOLD_PCT: 2.0,
  PRICE_RISE_TARGET_PCT: 3.0,
  SMA_SHORT_WINDOW: 5,
  SMA_LONG_WINDOW: 20,
  MAX_TRADE_SIZE_ETH: 0.01,
  MAX_TRADE_SIZE_USDC: 10,
  TRADE_COOLDOWN_SECONDS: 300,
  DRY_RUN: false,
  LOG_LEVEL: 'info' as const,
  WEB_PORT: 8080,
  DATA_DIR: '/tmp/test',
  MCP_SERVER_URL: 'http://localhost:3002/mcp',
  NETWORK_ID: 'base-sepolia',
  TELEGRAM_BOT_TOKEN: undefined,
  TELEGRAM_ALLOWED_CHAT_IDS: undefined,
};

describe('RuntimeConfig', () => {
  let rc: RuntimeConfig;

  beforeEach(() => {
    rc = new RuntimeConfig(defaults, makeTestQueries() as any);
  });

  // ── get() ──────────────────────────────────────────────────────────────────
  describe('get()', () => {
    it('returns default value for a writable key', () => {
      expect(rc.get('STRATEGY')).toBe('threshold');
    });
    it('returns default value for a read-only key', () => {
      expect(rc.get('WEB_PORT')).toBe(8080);
    });
  });

  // ── set() ──────────────────────────────────────────────────────────────────
  describe('set()', () => {
    it('updates in-memory value', () => {
      rc.set('STRATEGY', 'sma');
      expect(rc.get('STRATEGY')).toBe('sma');
    });
    it('coerces string input to number for numeric keys', () => {
      rc.set('POLL_INTERVAL_SECONDS', '10' as any);
      expect(rc.get('POLL_INTERVAL_SECONDS')).toBe(10);
    });
    it('throws on unknown key', () => {
      expect(() => rc.set('UNKNOWN' as any, 'x')).toThrow('Unknown config key');
    });
    it('throws on read-only key', () => {
      expect(() => rc.set('NETWORK_ID', 'base-mainnet')).toThrow('read-only');
    });
    it('throws when STRATEGY is invalid', () => {
      expect(() => rc.set('STRATEGY', 'invalid')).toThrow();
    });
    it('throws when POLL_INTERVAL_SECONDS is below minimum', () => {
      expect(() => rc.set('POLL_INTERVAL_SECONDS', 3)).toThrow('>= 5');
    });
    it('throws when SMA_SHORT_WINDOW is not an integer', () => {
      expect(() => rc.set('SMA_SHORT_WINDOW', 3.5)).toThrow();
    });
  });

  // ── setBatch() ─────────────────────────────────────────────────────────────
  describe('setBatch()', () => {
    it('applies all changes', () => {
      rc.setBatch({ STRATEGY: 'sma', SMA_SHORT_WINDOW: 3, SMA_LONG_WINDOW: 10 });
      expect(rc.get('STRATEGY')).toBe('sma');
      expect(rc.get('SMA_SHORT_WINDOW')).toBe(3);
      expect(rc.get('SMA_LONG_WINDOW')).toBe(10);
    });
    it('rejects entire batch if one key is invalid — no partial apply', () => {
      expect(() => rc.setBatch({ STRATEGY: 'sma', POLL_INTERVAL_SECONDS: 1 })).toThrow();
      expect(rc.get('STRATEGY')).toBe('threshold'); // unchanged
    });
    it('fires events only after all values are updated in memory', () => {
      let strategySeenDuringEvent = '';
      let longWindowSeenDuringEvent = 0;
      rc.subscribe('STRATEGY', () => {
        strategySeenDuringEvent = rc.get('STRATEGY') as string;
        longWindowSeenDuringEvent = rc.get('SMA_LONG_WINDOW') as number;
      });
      rc.setBatch({ STRATEGY: 'sma', SMA_LONG_WINDOW: 25 });
      expect(strategySeenDuringEvent).toBe('sma');
      expect(longWindowSeenDuringEvent).toBe(25); // already updated when event fired
    });
  });

  // ── subscribe() ────────────────────────────────────────────────────────────
  describe('subscribe()', () => {
    it('fires callback with new value when key changes', () => {
      const calls: unknown[] = [];
      rc.subscribe('STRATEGY', v => calls.push(v));
      rc.set('STRATEGY', 'sma');
      expect(calls).toEqual(['sma']);
    });
    it('does not fire for unrelated key changes', () => {
      const calls: unknown[] = [];
      rc.subscribe('STRATEGY', v => calls.push(v));
      rc.set('DRY_RUN', true);
      expect(calls).toHaveLength(0);
    });
  });

  // ── subscribeMany() ────────────────────────────────────────────────────────
  describe('subscribeMany()', () => {
    it('fires once when one of the watched keys changes', () => {
      let count = 0;
      rc.subscribeMany(['STRATEGY', 'SMA_LONG_WINDOW'], () => { count++; });
      rc.set('STRATEGY', 'sma');
      expect(count).toBe(1);
    });
    it('fires once (not twice) when a setBatch changes two watched keys', () => {
      let count = 0;
      rc.subscribeMany(['STRATEGY', 'SMA_LONG_WINDOW'], () => { count++; });
      rc.setBatch({ STRATEGY: 'sma', SMA_LONG_WINDOW: 25 });
      expect(count).toBe(1);
    });
  });

  // ── DB persistence ─────────────────────────────────────────────────────────
  describe('persistence', () => {
    it('overlays saved DB values on construction', () => {
      const q = makeTestQueries() as any;
      q.upsertSetting.run('STRATEGY', 'sma');
      const rc2 = new RuntimeConfig(defaults, q);
      expect(rc2.get('STRATEGY')).toBe('sma');
    });
    it('persists set() to DB', () => {
      const q = makeTestQueries() as any;
      const rc2 = new RuntimeConfig(defaults, q);
      rc2.set('STRATEGY', 'sma');
      const row = q.getSetting.get('STRATEGY') as { value: string };
      expect(row.value).toBe('sma');
    });
    it('serialises boolean DRY_RUN correctly', () => {
      const q = makeTestQueries() as any;
      const rc2 = new RuntimeConfig(defaults, q);
      rc2.set('DRY_RUN', true);
      const row = q.getSetting.get('DRY_RUN') as { value: string };
      expect(row.value).toBe('true');
    });
    it('deserialises DRY_RUN back to boolean on load', () => {
      const q = makeTestQueries() as any;
      q.upsertSetting.run('DRY_RUN', 'true');
      const rc2 = new RuntimeConfig(defaults, q);
      expect(rc2.get('DRY_RUN')).toBe(true);
    });
  });

  // ── getAll() ───────────────────────────────────────────────────────────────
  describe('getAll()', () => {
    it('returns all 40 config keys', () => {
      const all = rc.getAll();
      expect(Object.keys(all)).toHaveLength(40);
    });
    it('includes read-only keys', () => {
      const all = rc.getAll();
      expect(all.NETWORK_ID).toBeDefined();
      expect(all.WEB_PORT).toBeDefined();
    });
  });
});
