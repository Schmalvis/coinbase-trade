import { describe, it, expect, beforeEach } from 'vitest';
import { RuntimeConfig, type DbQueries } from '../src/core/runtime-config.js';

/** In-memory mock that matches DbQueries shape without native better-sqlite3 */
function makeTestQueries(): DbQueries {
  const store = new Map<string, string>();
  return {
    getSetting: {
      get(key: string) {
        const value = store.get(key);
        return value !== undefined ? { value } : undefined;
      },
    },
    upsertSetting: {
      run(key: string, value: string) {
        store.set(key, value);
      },
    },
    getAllSettings: {
      all() {
        return [...store.entries()].map(([key, value]) => ({ key, value }));
      },
    },
  };
}

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
  // Optimizer defaults
  MAX_POSITION_PCT: 40,
  MAX_DAILY_LOSS_PCT: 5,
  MAX_ROTATION_PCT: 25,
  MAX_DAILY_ROTATIONS: 10,
  PORTFOLIO_FLOOR_USD: 100,
  MIN_ROTATION_GAIN_PCT: 2,
  MAX_CASH_PCT: 80,
  OPTIMIZER_INTERVAL_SECONDS: 300,
  ROTATION_SELL_THRESHOLD: -20,
  ROTATION_BUY_THRESHOLD: 30,
  MIN_ROTATION_SCORE_DELTA: 40,
  RISK_OFF_THRESHOLD: -10,
  RISK_ON_THRESHOLD: 15,
  DEFAULT_FEE_ESTIMATE_PCT: 1.0,
  DASHBOARD_THEME: 'dark',
};

describe('RuntimeConfig – optimizer keys', () => {
  let rc: RuntimeConfig;

  beforeEach(() => {
    rc = new RuntimeConfig(defaults, makeTestQueries());
  });

  // ── defaults ────────────────────────────────────────────────────────────────
  describe('defaults', () => {
    it('MAX_POSITION_PCT defaults to 40', () => {
      expect(rc.get('MAX_POSITION_PCT')).toBe(40);
    });
    it('OPTIMIZER_INTERVAL_SECONDS defaults to 300', () => {
      expect(rc.get('OPTIMIZER_INTERVAL_SECONDS')).toBe(300);
    });
    it('DASHBOARD_THEME defaults to dark', () => {
      expect(rc.get('DASHBOARD_THEME')).toBe('dark');
    });
  });

  // ── validation rejects out-of-range ─────────────────────────────────────────
  describe('validation rejects out-of-range', () => {
    it('MAX_POSITION_PCT=3 throws', () => {
      expect(() => rc.set('MAX_POSITION_PCT', 3)).toThrow('5–100');
    });
    it('MAX_POSITION_PCT=101 throws', () => {
      expect(() => rc.set('MAX_POSITION_PCT', 101)).toThrow('5–100');
    });
    it('MAX_POSITION_PCT=50 works', () => {
      rc.set('MAX_POSITION_PCT', 50);
      expect(rc.get('MAX_POSITION_PCT')).toBe(50);
    });
  });

  // ── DASHBOARD_THEME validation ──────────────────────────────────────────────
  describe('DASHBOARD_THEME validation', () => {
    it('rejects "neon"', () => {
      expect(() => rc.set('DASHBOARD_THEME', 'neon')).toThrow('"light" or "dark"');
    });
    it('accepts "light"', () => {
      rc.set('DASHBOARD_THEME', 'light');
      expect(rc.get('DASHBOARD_THEME')).toBe('light');
    });
  });

  // ── persistence ─────────────────────────────────────────────────────────────
  describe('persistence', () => {
    it('persists to DB and reads back in new instance', () => {
      const q = makeTestQueries();
      const rc1 = new RuntimeConfig(defaults, q);
      rc1.set('MAX_POSITION_PCT', 75);
      rc1.set('DASHBOARD_THEME', 'light');

      const rc2 = new RuntimeConfig(defaults, q);
      expect(rc2.get('MAX_POSITION_PCT')).toBe(75);
      expect(rc2.get('DASHBOARD_THEME')).toBe('light');
    });
  });

  // ── negative thresholds ─────────────────────────────────────────────────────
  describe('negative thresholds', () => {
    it('ROTATION_SELL_THRESHOLD=-50 works', () => {
      rc.set('ROTATION_SELL_THRESHOLD', -50);
      expect(rc.get('ROTATION_SELL_THRESHOLD')).toBe(-50);
    });
    it('RISK_OFF_THRESHOLD=-30 works', () => {
      rc.set('RISK_OFF_THRESHOLD', -30);
      expect(rc.get('RISK_OFF_THRESHOLD')).toBe(-30);
    });
    it('ROTATION_SELL_THRESHOLD=5 throws (must be <= 0)', () => {
      expect(() => rc.set('ROTATION_SELL_THRESHOLD', 5)).toThrow('-100–0');
    });
    it('RISK_OFF_THRESHOLD=10 throws (must be <= 0)', () => {
      expect(() => rc.set('RISK_OFF_THRESHOLD', 10)).toThrow('-100–0');
    });
  });
});
