// src/scripts/db-report.ts
import Database from 'better-sqlite3';

export interface TradeRow {
  timestamp: string;
  symbol: string | null;
  action: string;
  amount_eth: number;
  price_usd: number;
  realized_pnl: number | null;
  status: string;
  strategy: string | null;
}

export interface RotationRow {
  timestamp: string;
  sell_symbol: string;
  buy_symbol: string;
  estimated_gain_pct: number;
  actual_gain_pct: number | null;
  status: string;
  veto_reason: string | null;
}

export interface TokenMetric {
  symbol: string;
  network: string;
  wins: number;
  losses: number;
  realized_pnl_7d: number;
}

export interface AssetRow {
  symbol: string;
  network: string;
  status: string;
  strategy: string;
  drop_pct: number;
  rise_pct: number;
  sma_short: number;
  sma_long: number;
  is_memecoin: number;
  shadow_until: number | null;
}

export interface DailyPnlRow {
  date: string;
  network: string;
  realized_pnl: number;
  current_usd: number;
  rotations: number;
}

export interface AssetFreshness {
  symbol: string;
  network: string;
  latestSnapshotMinutesAgo: number | null;
  latestCandle15mMinutesAgo: number | null;
  candle15mCountLast24h: number;
}

export interface DataFreshness {
  // null means no portfolio_snapshots row exists at all (never polled successfully)
  latestPortfolioSnapshotMinutesAgo: number | null;
  assets: AssetFreshness[];
  // e.g. { coinbase: 90, dex: 4, synthetic: 2 } across all active assets, last 24h of 15m candles
  candleSourceMixLast24h: Record<string, number>;
}

export interface ReportData {
  generatedAt: string;
  last24hTrades: TradeRow[];
  last24hRotations: RotationRow[];
  tokenMetrics: TokenMetric[];
  settings: Record<string, string>;
  assets: AssetRow[];
  dailyPnl: DailyPnlRow[];
  dataFreshness: DataFreshness;
}

export function generateReport(db: Database.Database): ReportData {
  const last24hTrades = db.prepare(`
    SELECT timestamp, symbol, action, amount_eth, price_usd, realized_pnl, status, strategy
    FROM trades
    WHERE dry_run = 0
      AND datetime(timestamp) >= datetime('now', '-24 hours')
    ORDER BY timestamp DESC
  `).all() as TradeRow[];

  const last24hRotations = db.prepare(`
    SELECT timestamp, sell_symbol, buy_symbol, estimated_gain_pct, actual_gain_pct, status, veto_reason
    FROM rotations
    WHERE dry_run = 0
      AND datetime(timestamp) >= datetime('now', '-24 hours')
    ORDER BY timestamp DESC
  `).all() as RotationRow[];

  const tokenMetrics = db.prepare(`
    SELECT
      symbol,
      network,
      SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) AS losses,
      COALESCE(SUM(realized_pnl), 0) AS realized_pnl_7d
    FROM trades
    WHERE dry_run = 0
      AND action = 'sell'
      AND symbol IS NOT NULL
      AND datetime(timestamp) >= datetime('now', '-7 days')
    GROUP BY symbol, network
  `).all() as TokenMetric[];

  const settingsRows = db.prepare(`SELECT key, value FROM settings`).all() as Array<{ key: string; value: string }>;
  const settings: Record<string, string> = {};
  for (const row of settingsRows) settings[row.key] = row.value;

  const assets = db.prepare(`
    SELECT symbol, network, status, strategy, drop_pct, rise_pct, sma_short, sma_long, is_memecoin, shadow_until
    FROM discovered_assets
    WHERE status != 'dismissed'
    ORDER BY symbol
  `).all() as AssetRow[];

  const dailyPnl = (db.prepare(`
    SELECT date, network, realized_pnl, current_usd, rotations
    FROM daily_pnl
    ORDER BY date DESC
    LIMIT 7
  `).all() as DailyPnlRow[]).reverse();

  // Data-freshness pre-flight: distinguishes "quiet because no signals" from "quiet because
  // blind" (dead price feed, stalled candle ingest, degraded portfolio poll). See
  // wiki/code-fixes-needed.md — three consecutive nights of "0 rotations" were correctly
  // traced to a code bug, but nothing forced that check first; a dead feed would look
  // identical in Steps 3-4 without this.
  const portfolioFreshnessRow = db.prepare(`
    SELECT (julianday('now') - julianday(MAX(timestamp))) * 24 * 60 AS minutes_ago
    FROM portfolio_snapshots
  `).get() as { minutes_ago: number | null };

  const assetFreshness = db.prepare(`
    SELECT
      da.symbol,
      da.network,
      (SELECT (julianday('now') - julianday(MAX(a.timestamp))) * 24 * 60
         FROM asset_snapshots a WHERE a.symbol = da.symbol) AS latest_snapshot_minutes_ago,
      (SELECT (julianday('now') - julianday(MAX(c.open_time))) * 24 * 60
         FROM candles c WHERE c.symbol = da.symbol AND c.network = da.network AND c.interval = '15m'
      ) AS latest_candle_15m_minutes_ago,
      (SELECT COUNT(*) FROM candles c
         WHERE c.symbol = da.symbol AND c.network = da.network AND c.interval = '15m'
           AND datetime(c.open_time) >= datetime('now', '-24 hours')
      ) AS candle_15m_count_last_24h
    FROM discovered_assets da
    WHERE da.status = 'active'
    ORDER BY da.symbol
  `).all() as Array<{
    symbol: string; network: string;
    latest_snapshot_minutes_ago: number | null;
    latest_candle_15m_minutes_ago: number | null;
    candle_15m_count_last_24h: number;
  }>;

  const sourceMixRows = db.prepare(`
    SELECT source, COUNT(*) AS n
    FROM candles
    WHERE interval = '15m' AND datetime(open_time) >= datetime('now', '-24 hours')
    GROUP BY source
  `).all() as Array<{ source: string; n: number }>;
  const candleSourceMixLast24h: Record<string, number> = {};
  for (const row of sourceMixRows) candleSourceMixLast24h[row.source] = row.n;

  const dataFreshness: DataFreshness = {
    latestPortfolioSnapshotMinutesAgo: portfolioFreshnessRow?.minutes_ago ?? null,
    assets: assetFreshness.map(r => ({
      symbol: r.symbol,
      network: r.network,
      latestSnapshotMinutesAgo: r.latest_snapshot_minutes_ago,
      latestCandle15mMinutesAgo: r.latest_candle_15m_minutes_ago,
      candle15mCountLast24h: r.candle_15m_count_last_24h,
    })),
    candleSourceMixLast24h,
  };

  return {
    generatedAt: new Date().toISOString(),
    last24hTrades,
    last24hRotations,
    tokenMetrics,
    settings,
    assets,
    dailyPnl,
    dataFreshness,
  };
}

// CLI entry point — only runs when executed directly, not when imported
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const dbPath = (process.env.DATA_DIR ?? '/app/data') + '/trades.db';
  const db = new Database(dbPath, { readonly: true });
  try {
    console.log(JSON.stringify(generateReport(db), null, 2));
  } finally {
    db.close();
  }
}
