// src/scripts/apply-change.ts
import Database from 'better-sqlite3';

const GLOBAL_NUMERIC_KEYS = new Set([
  'ROTATION_BUY_THRESHOLD', 'ROTATION_SELL_THRESHOLD', 'MIN_ROTATION_SCORE_DELTA',
  'RISK_OFF_THRESHOLD', 'RISK_ON_THRESHOLD',
  'OPTIMIZER_INTERVAL_SECONDS',
  'MAX_POSITION_PCT', 'MAX_DAILY_LOSS_PCT', 'MAX_ROTATION_PCT', 'MAX_DAILY_ROTATIONS',
  'MIN_ROTATION_GAIN_PCT', 'MAX_CASH_PCT', 'DEFAULT_FEE_ESTIMATE_PCT',
  'MEMECOIN_CAP_PCT', 'MEMECOIN_COOLDOWN_SECONDS',
  'BB_PERIOD', 'BB_STD_DEV', 'GRID_LEVELS', 'GRID_AMOUNT_PCT', 'GRID_RECALC_HOURS',
  'STOP_LOSS_PCT', 'TRAILING_STOP_PCT', 'MIN_ROTATION_PROFIT_USD',
  'PORTFOLIO_FLOOR_USD',
]);

const PER_ASSET_COLUMNS: Record<string, string> = {
  drop_pct: 'drop_pct',
  rise_pct: 'rise_pct',
  sma_short: 'sma_short',
  sma_long: 'sma_long',
};

const SESSION_DATE_KEY = 'review_session_date';
const SESSION_COUNT_KEY = 'review_session_count';
const MAX_SESSION_CHANGES = 3;

export interface ChangeResult {
  accepted: boolean;
  key: string;
  symbol?: string;
  oldValue?: number;
  newValue?: number;
  reason: string;
}

function getSessionCount(db: Database.Database): { date: string; count: number } {
  const dateRow = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(SESSION_DATE_KEY) as { value: string } | undefined;
  const countRow = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(SESSION_COUNT_KEY) as { value: string } | undefined;
  const today = new Date().toISOString().slice(0, 10);
  const sessionDate = dateRow?.value ?? '';
  const count = sessionDate === today ? parseInt(countRow?.value ?? '0') : 0;
  return { date: today, count };
}

function incrementSessionCount(db: Database.Database, today: string, currentCount: number): void {
  const upsert = db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`);
  upsert.run(SESSION_DATE_KEY, today);
  upsert.run(SESSION_COUNT_KEY, String(currentCount + 1));
}

export function applyChange(
  db: Database.Database,
  key: string,
  rawValue: string,
  symbol?: string,
  network?: string,
): ChangeResult {
  const isPerAsset = symbol !== undefined;

  if (key === 'DRY_RUN') {
    return { accepted: false, key, reason: 'DRY_RUN cannot be changed by the review agent' };
  }

  if (!isPerAsset && !GLOBAL_NUMERIC_KEYS.has(key)) {
    return { accepted: false, key, reason: `Unknown or non-numeric setting key: ${key}` };
  }
  if (isPerAsset && !(key in PER_ASSET_COLUMNS)) {
    return { accepted: false, key, reason: `Unknown per-asset param: ${key}. Allowed: drop_pct, rise_pct, sma_short, sma_long` };
  }

  const newValue = parseFloat(rawValue);
  if (isNaN(newValue)) {
    return { accepted: false, key, reason: `Value '${rawValue}' is not a number` };
  }

  const { date: today, count: sessionCount } = getSessionCount(db);
  if (sessionCount >= MAX_SESSION_CHANGES) {
    return { accepted: false, key, reason: `Session limit: ${MAX_SESSION_CHANGES} changes already applied this session` };
  }

  if (!isPerAsset) {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
    const oldValue = row ? parseFloat(row.value) : undefined;

    // Hard range checks run before the ±20% cap so range errors take priority
    if (key === 'PORTFOLIO_FLOOR_USD' && newValue < 80) {
      return { accepted: false, key, reason: `PORTFOLIO_FLOOR_USD cannot go below $80 (requested: ${newValue})` };
    }
    if (key === 'MAX_POSITION_PCT' && (newValue < 15 || newValue > 45)) {
      return { accepted: false, key, reason: `MAX_POSITION_PCT must be in range 15–45 (requested: ${newValue})` };
    }
    if (key === 'MEMECOIN_CAP_PCT' && (newValue < 10 || newValue > 35)) {
      return { accepted: false, key, reason: `MEMECOIN_CAP_PCT must be in range 10–35 (requested: ${newValue})` };
    }
    if (key === 'OPTIMIZER_INTERVAL_SECONDS' && (newValue < 120 || newValue > 600)) {
      return { accepted: false, key, reason: `OPTIMIZER_INTERVAL_SECONDS must be in range 120–600 (requested: ${newValue})` };
    }

    if (oldValue !== undefined && oldValue !== 0) {
      const lo = Math.min(oldValue * 0.8, oldValue * 1.2);
      const hi = Math.max(oldValue * 0.8, oldValue * 1.2);
      if (newValue < lo || newValue > hi) {
        return {
          accepted: false, key,
          reason: `Exceeds ±20% cap. Current: ${oldValue}, allowed: [${lo.toFixed(4)}, ${hi.toFixed(4)}], requested: ${newValue}`,
        };
      }
    }

    const applyGlobal = db.transaction(() => {
      db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`).run(key, String(newValue));
      incrementSessionCount(db, today, sessionCount);
    });
    applyGlobal();
    return { accepted: true, key, oldValue, newValue, reason: 'Applied' };
  }

  // Per-asset change — use column map (not raw key) to eliminate SQL injection risk
  const net = network ?? 'base-mainnet';
  const col = PER_ASSET_COLUMNS[key];
  const asset = db.prepare(
    `SELECT ${col} as current_val FROM discovered_assets WHERE LOWER(symbol) = LOWER(?) AND network = ?`
  ).get(symbol!, net) as { current_val: number } | undefined;

  if (!asset) {
    return { accepted: false, key, symbol, reason: `Asset '${symbol}' not found on ${net}` };
  }

  const oldValue = asset.current_val;
  if (oldValue !== 0) {
    const lo = Math.min(oldValue * 0.8, oldValue * 1.2);
    const hi = Math.max(oldValue * 0.8, oldValue * 1.2);
    if (newValue < lo || newValue > hi) {
      return {
        accepted: false, key, symbol,
        reason: `Exceeds ±20% cap. Current ${key}: ${oldValue}, allowed: [${lo.toFixed(4)}, ${hi.toFixed(4)}], requested: ${newValue}`,
      };
    }
  }

  const applyPerAsset = db.transaction(() => {
    db.prepare(`UPDATE discovered_assets SET ${col} = ? WHERE LOWER(symbol) = LOWER(?) AND network = ?`)
      .run(newValue, symbol!, net);
    incrementSessionCount(db, today, sessionCount);
  });
  applyPerAsset();
  return { accepted: true, key, symbol, oldValue, newValue, reason: 'Applied' };
}

// CLI entry point — only runs when executed directly, not when imported
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const args = process.argv.slice(2);
  function arg(name: string): string | undefined {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : undefined;
  }

  const key = arg('key');
  const value = arg('value');
  if (!key || !value) {
    console.error('Usage: node apply-change.js --key KEY --value VALUE [--symbol SYMBOL] [--network NETWORK]');
    process.exit(1);
  }

  const dbPath = (process.env.DATA_DIR ?? '/app/data') + '/trades.db';
  const db = new Database(dbPath);
  try {
    const result = applyChange(db, key, value, arg('symbol'), arg('network'));
    console.log(JSON.stringify(result));
    process.exit(result.accepted ? 0 : 1);
  } finally {
    db.close();
  }
}
