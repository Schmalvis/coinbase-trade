// src/scripts/apply-status.ts
import Database from 'better-sqlite3';

const VALID_TARGET_STATUSES = new Set(['active', 'dismissed']);
const SHADOW_PERIOD_MS = 24 * 60 * 60 * 1000;

export interface StatusResult {
  accepted: boolean;
  symbol: string;
  network: string;
  oldStatus?: string;
  newStatus?: string;
  shadow_until?: number;
  reason: string;
}

export function applyStatus(
  db: Database.Database,
  symbol: string,
  network: string,
  newStatus: string,
): StatusResult {
  if (!VALID_TARGET_STATUSES.has(newStatus)) {
    return { accepted: false, symbol, network, reason: `Invalid target status '${newStatus}'. Allowed: active, dismissed` };
  }

  const asset = db.prepare(
    `SELECT status FROM discovered_assets WHERE LOWER(symbol) = LOWER(?) AND network = ?`
  ).get(symbol, network) as { status: string } | undefined;

  if (!asset) {
    return { accepted: false, symbol, network, reason: `Asset '${symbol}' not found on ${network}` };
  }

  const oldStatus = asset.status;

  if (oldStatus === 'dismissed' && newStatus === 'active') {
    return { accepted: false, symbol, network, oldStatus, reason: `Cannot reactivate a dismissed token. Manual re-enable required.` };
  }

  if (oldStatus === newStatus) {
    return { accepted: true, symbol, network, oldStatus, newStatus, reason: 'No change needed' };
  }

  if (newStatus === 'active') {
    const snapshotRow = db.prepare(
      `SELECT COUNT(*) as cnt FROM asset_snapshots WHERE symbol = ? AND datetime(timestamp) <= datetime('now', '-24 hours')`
    ).get(symbol) as { cnt: number };

    if (snapshotRow.cnt === 0) {
      return {
        accepted: false, symbol, network, oldStatus,
        reason: `Promotion requires ≥24h of price snapshot data. No snapshots older than 24h found for ${symbol}.`,
      };
    }

    const shadow_until = Date.now() + SHADOW_PERIOD_MS;
    db.prepare(
      `UPDATE discovered_assets SET status = 'active', shadow_until = ? WHERE LOWER(symbol) = LOWER(?) AND network = ?`
    ).run(shadow_until, symbol, network);

    return { accepted: true, symbol, network, oldStatus, newStatus: 'active', shadow_until, reason: 'Applied — 24h shadow period started' };
  }

  // active → dismissed
  db.prepare(
    `UPDATE discovered_assets SET status = 'dismissed', shadow_until = NULL WHERE LOWER(symbol) = LOWER(?) AND network = ?`
  ).run(symbol, network);

  return { accepted: true, symbol, network, oldStatus, newStatus: 'dismissed', reason: 'Applied' };
}

// CLI entry point — only runs when executed directly, not when imported
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const args = process.argv.slice(2);
  function arg(name: string): string | undefined {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : undefined;
  }

  const symbol = arg('symbol');
  const network = arg('network') ?? 'base-mainnet';
  const status = arg('status');

  if (!symbol || !status) {
    console.error('Usage: node apply-status.js --symbol SYMBOL --status STATUS [--network NETWORK]');
    process.exit(1);
  }

  const dbPath = (process.env.DATA_DIR ?? '/app/data') + '/trades.db';
  const db = new Database(dbPath);
  try {
    const result = applyStatus(db, symbol, network, status);
    console.log(JSON.stringify(result));
    process.exit(result.accepted ? 0 : 1);
  } finally {
    db.close();
  }
}
