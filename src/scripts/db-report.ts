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

export interface ReportData {
  generatedAt: string;
  last24hTrades: TradeRow[];
  last24hRotations: RotationRow[];
  tokenMetrics: TokenMetric[];
  settings: Record<string, string>;
  assets: AssetRow[];
  dailyPnl: DailyPnlRow[];
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
      AND realized_pnl IS NOT NULL
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

  return {
    generatedAt: new Date().toISOString(),
    last24hTrades,
    last24hRotations,
    tokenMetrics,
    settings,
    assets,
    dailyPnl,
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
