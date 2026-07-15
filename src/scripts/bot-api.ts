// src/scripts/bot-api.ts — shared HTTP plumbing for out-of-process review-agent scripts.
// Rule: scripts may READ SQLite directly (reads are not the bug) but every WRITE must go
// through the bot's HTTP API so the live engine reacts. Never import src/config.ts here
// (it Zod-validates the full env and would crash the script container).

export const FETCH_TIMEOUT_MS = 10_000;

export interface BotApiOptions {
  baseUrl?: string;         // default `http://localhost:${process.env.WEB_PORT ?? '8080'}`
  token?: string;           // default process.env.DASHBOARD_SECRET || 'review-agent'
  fetchImpl?: typeof fetch; // default globalThis.fetch
}

export class BotUnreachableError extends Error {
  constructor(public readonly baseUrl: string, public readonly detail: string) {
    super(`Bot unreachable at ${baseUrl} (${detail})`);
    this.name = 'BotUnreachableError';
  }
}

export interface BotApiResult {
  ok: boolean;                    // res.ok
  status: number;                 // res.status
  body: Record<string, unknown>;  // parsed JSON, {} on parse failure
}

/** POST/PUT to the running bot. Always sends Authorization: Bearer <token>.
 *  jsonBody === undefined → no request body (still sends Content-Type + Bearer).
 *  Throws BotUnreachableError on any network/timeout failure — callers MUST fail
 *  closed (no DB-write fallback). Non-2xx is returned, not thrown. */
export async function callBot(
  method: 'POST' | 'PUT',
  path: string,                   // starts with '/', e.g. '/api/settings'
  jsonBody: unknown,
  options: BotApiOptions = {},
): Promise<BotApiResult> {
  const baseUrl = options.baseUrl ?? `http://localhost:${process.env.WEB_PORT ?? '8080'}`;
  const token = options.token ?? (process.env.DASHBOARD_SECRET || 'review-agent');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  try {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: body as Record<string, unknown> };
  } catch (err: unknown) {
    throw new BotUnreachableError(baseUrl, err instanceof Error ? err.message : String(err));
  }
}

/** Maps a non-2xx BotApiResult to the reason string format shipped in apply-change
 *  (tests match these: /auth/i, "Rejected by bot: ..."). */
export function httpFailureReason(res: BotApiResult): string {
  if (res.status === 400) return `Rejected by bot: ${res.body.error}`;
  if (res.status === 401 || res.status === 403) {
    return `Bot API auth failed (HTTP ${res.status}): ${res.body.error ?? ''} — check DASHBOARD_SECRET env`;
  }
  return `Bot API returned HTTP ${res.status}`;
}

/** Echo body for strategy-config-bearing endpoints (PUT /config, POST /enable), built
 *  from the current DB row. Grid bounds are sent ONLY when a manual override exists —
 *  the config endpoint recomputes grid_manual_override from bound presence, so omitting
 *  them preserves auto-calculated bounds. */
export interface StrategyRowLite {
  address: string;
  strategy: string;
  drop_pct: number; rise_pct: number;
  sma_short: number; sma_long: number;
  sma_use_ema: number; sma_volume_filter: number; sma_rsi_filter: number;
  grid_levels: number;
  grid_upper_bound: number | null;
  grid_lower_bound: number | null;
  grid_manual_override: number;
}

export function buildStrategyEchoBody(row: StrategyRowLite): Record<string, unknown> {
  const body: Record<string, unknown> = {
    strategyType: row.strategy,
    dropPct: row.drop_pct,
    risePct: row.rise_pct,
    smaShort: row.sma_short,
    smaLong: row.sma_long,
    smaUseEma: row.sma_use_ema === 1,
    smaVolumeFilter: row.sma_volume_filter === 1,
    smaRsiFilter: row.sma_rsi_filter === 1,
  };
  if (row.strategy === 'grid') {
    body.grid_levels = row.grid_levels;
    if (row.grid_manual_override === 1) {
      body.grid_upper_bound = row.grid_upper_bound;
      body.grid_lower_bound = row.grid_lower_bound;
    }
  }
  return body;
}
