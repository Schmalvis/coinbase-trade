// src/scripts/apply-change.ts
import Database from 'better-sqlite3';
import { callBot, httpFailureReason, BotUnreachableError, buildStrategyEchoBody, type BotApiOptions, type StrategyRowLite } from './bot-api.js';

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

export type ApplyChangeOptions = BotApiOptions;

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

export async function applyChange(
  db: Database.Database,
  key: string,
  rawValue: string,
  symbol?: string,
  network?: string,
  options: ApplyChangeOptions = {},
): Promise<ChangeResult> {
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
    // ±20% cap keeps reading the DB directly — reads are not the bug, direct writes are.
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

    // Route the write through the bot's HTTP API so the live in-memory RuntimeConfig
    // picks it up immediately — writing straight to SQLite (the old behaviour) left
    // the running bot unaware of the change until its next restart.
    try {
      const res = await callBot('POST', '/api/settings', { changes: { [key]: newValue } }, options);
      if (res.ok) {
        incrementSessionCount(db, today, sessionCount);
        return { accepted: true, key, oldValue, newValue, reason: 'Applied (live)' };
      }
      return { accepted: false, key, ...(res.status === 400 ? { oldValue } : {}), reason: httpFailureReason(res) };
    } catch (err) {
      if (err instanceof BotUnreachableError) {
        return { accepted: false, key, reason: `${err.message} — change NOT applied; do not retry with direct DB writes` };
      }
      throw err;
    }
  }

  // Per-asset change
  const net = network ?? 'base-mainnet';

  // Pre-flight: sma_short/sma_long must be integers, or the server's validateAssetParams
  // will 400 — catch it here to give a clearer reason and avoid a wasted HTTP round-trip.
  if ((key === 'sma_short' || key === 'sma_long') && !Number.isInteger(newValue)) {
    return { accepted: false, key, symbol, reason: `${key} must be an integer` };
  }

  // status='active' guard: the PUT below unconditionally starts a live trading loop for
  // the asset (engine.reloadAssetConfig → startAssetLoop), bypassing the promote-route's
  // C7 promotable gate. Restrict the review agent to already-active assets so it can never
  // begin ticking a pending/dismissed (potentially spam) token that was never vetted.
  const row = db.prepare(
    `SELECT * FROM discovered_assets WHERE LOWER(symbol) = LOWER(?) AND network = ? AND status = 'active'`
  ).get(symbol!, net) as StrategyRowLite | undefined;

  if (!row) {
    return { accepted: false, key, symbol, reason: `Asset '${symbol}' not found or not active on ${net}` };
  }

  const col = PER_ASSET_COLUMNS[key];
  const oldValue = (row as unknown as Record<string, number>)[col];
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

  // NOTE: the PUT below resolves the asset against botState.activeNetwork server-side,
  // ignoring the --network CLI flag entirely — a pre-existing network-flag mismatch,
  // not something this change fixes.
  const bodyOut = buildStrategyEchoBody(row);
  const FIELD_FOR_KEY: Record<string, string> = {
    drop_pct: 'dropPct', rise_pct: 'risePct', sma_short: 'smaShort', sma_long: 'smaLong',
  };
  bodyOut[FIELD_FOR_KEY[key]] = newValue;

  try {
    const res = await callBot('PUT', `/api/assets/${encodeURIComponent(row.address)}/config`, bodyOut, options);
    if (res.ok) {
      incrementSessionCount(db, today, sessionCount);
      return { accepted: true, key, symbol, oldValue, newValue, reason: 'Applied (live)' };
    }
    return { accepted: false, key, symbol, ...(res.status === 400 ? { oldValue } : {}), reason: httpFailureReason(res) };
  } catch (err) {
    // Same fail-closed rule as the global path — never fall back to a direct DB write.
    if (err instanceof BotUnreachableError) {
      return { accepted: false, key, symbol, reason: `${err.message} — change NOT applied; do not retry with direct DB writes` };
    }
    throw err;
  }
}

// CLI entry point — only runs when executed directly, not when imported
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  (async () => {
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
    db.pragma('busy_timeout = 5000'); // bot writes the same WAL DB concurrently
    try {
      const result = await applyChange(db, key, value, arg('symbol'), arg('network'));
      console.log(JSON.stringify(result));
      process.exit(result.accepted ? 0 : 1);
    } finally {
      db.close();
    }
  })();
}
