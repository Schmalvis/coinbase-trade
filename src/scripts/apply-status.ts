// src/scripts/apply-status.ts
import Database from 'better-sqlite3';
import { callBot, httpFailureReason, BotUnreachableError, buildStrategyEchoBody, type BotApiOptions, type StrategyRowLite } from './bot-api.js';

const VALID_TARGET_STATUSES = new Set(['active', 'dismissed']);

export interface StatusResult {
  accepted: boolean;
  symbol: string;
  network: string;
  oldStatus?: string;
  newStatus?: string;
  shadow_until?: number;
  reason: string;
}

interface AssetRow extends StrategyRowLite {
  symbol: string;
  status: string;
  shadow_until: number | null;
}

export async function applyStatus(
  db: Database.Database,
  symbol: string,
  network: string,
  newStatus: string,
  options: BotApiOptions = {},
): Promise<StatusResult> {
  // ── Local pre-flight guards: a rejected op makes ZERO HTTP calls ──────────────

  // 1. Invalid target status
  if (!VALID_TARGET_STATUSES.has(newStatus)) {
    return { accepted: false, symbol, network, reason: `Invalid target status '${newStatus}'. Allowed: active, dismissed` };
  }

  // 2. Row resolution — needs the FULL row (address for the URL + config for the enable
  //    echo body). Reads .all() and picks deterministically, fixing the documented
  //    duplicate-symbol bug (wiki: TRUMP/UGOR no-ops, VIRTUAL mis-dismissal).
  const rows = db.prepare(
    `SELECT * FROM discovered_assets WHERE LOWER(symbol) = LOWER(?) AND network = ?`
  ).all(symbol, network) as AssetRow[];

  if (rows.length === 0) {
    return { accepted: false, symbol, network, reason: `Asset '${symbol}' not found on ${network}` };
  }

  const byStatus = (s: string) => rows.find(r => r.status === s);
  let row: AssetRow;
  if (newStatus === 'active') {
    const active = byStatus('active');
    if (active) {
      return { accepted: true, symbol, network, oldStatus: 'active', newStatus: 'active', reason: 'No change needed' };
    }
    const pending = byStatus('pending');
    if (!pending) {
      // MUST stay local: the enable ENDPOINT does not check prior status — without this
      // guard, dismissed spam tokens would become re-enableable by the agent.
      return { accepted: false, symbol, network, oldStatus: 'dismissed', reason: 'Cannot reactivate a dismissed token. Manual re-enable required.' };
    }
    row = pending;
  } else {
    const target = byStatus('active') ?? byStatus('pending');
    if (!target) {
      return { accepted: true, symbol, network, oldStatus: 'dismissed', newStatus: 'dismissed', reason: 'No change needed' };
    }
    row = target;
  }
  const oldStatus = row.status;

  // ── Enable path ────────────────────────────────────────────────────────────────
  if (newStatus === 'active') {
    // Local ≥24h-snapshot pre-check: KEPT as a cheap clearer-message gate. The endpoint's
    // assertPromotable (assets.ts:47-83) is now the AUTHORITATIVE gate on top of it.
    const snapshotRow = db.prepare(
      `SELECT COUNT(*) as cnt FROM asset_snapshots WHERE LOWER(symbol) = LOWER(?) AND datetime(timestamp) <= datetime('now', '-24 hours')`
    ).get(symbol) as { cnt: number };
    if (snapshotRow.cnt === 0) {
      return { accepted: false, symbol, network, oldStatus,
        reason: `Promotion requires ≥24h of price snapshot data. No snapshots older than 24h found for ${symbol}.` };
    }

    // Enable REQUIRES a full strategy body (assets.ts:245-247 → 400 otherwise).
    const body = buildStrategyEchoBody(row);

    try {
      const res = await callBot('POST', `/api/assets/${encodeURIComponent(row.address)}/enable`, body, options);
      if (!res.ok) {
        return { accepted: false, symbol, network, oldStatus, reason: httpFailureReason(res) };
      }
      // shadow_until is written SERVER-side only (assets.ts:299-301) — no double-write.
      const after = db.prepare(
        `SELECT shadow_until FROM discovered_assets WHERE address = ? AND network = ?`
      ).get(row.address, network) as { shadow_until: number | null } | undefined;
      const shadow_until = after?.shadow_until ?? undefined;
      return {
        accepted: true, symbol, network, oldStatus, newStatus: 'active',
        ...(shadow_until != null ? { shadow_until } : {}),
        reason: shadow_until != null ? 'Applied (live) — 24h shadow period started' : 'Applied (live)',
      };
    } catch (err) {
      if (err instanceof BotUnreachableError) {
        return { accepted: false, symbol, network, oldStatus,
          reason: `${err.message} — status NOT applied; do not retry with direct DB writes` };
      }
      throw err;
    }
  }

  // ── Dismiss path: POST /api/assets/:address/dismiss — no body, no guards server-side ──
  try {
    const res = await callBot('POST', `/api/assets/${encodeURIComponent(row.address)}/dismiss`, undefined, options);
    if (!res.ok) {
      return { accepted: false, symbol, network, oldStatus, reason: httpFailureReason(res) };
    }
    return { accepted: true, symbol, network, oldStatus, newStatus: 'dismissed', reason: 'Applied (live)' };
  } catch (err) {
    if (err instanceof BotUnreachableError) {
      return { accepted: false, symbol, network, oldStatus,
        reason: `${err.message} — status NOT applied; do not retry with direct DB writes` };
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

    const symbol = arg('symbol');
    const network = arg('network') ?? 'base-mainnet';
    const status = arg('status');

    if (!symbol || !status) {
      console.error('Usage: node apply-status.js --symbol SYMBOL --status STATUS [--network NETWORK]');
      process.exit(1);
    }

    const dbPath = (process.env.DATA_DIR ?? '/app/data') + '/trades.db';
    const db = new Database(dbPath);
    db.pragma('busy_timeout = 5000'); // bot writes the same WAL DB concurrently
    try {
      const result = await applyStatus(db, symbol, network, status);
      console.log(JSON.stringify(result));
      process.exit(result.accepted ? 0 : 1);
    } finally {
      db.close();
    }
  })();
}
