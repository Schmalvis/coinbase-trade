import { db } from '../connection.js';
import type { Statement } from 'better-sqlite3';

export interface RotationRow {
  id: number;
  timestamp: string;
  sell_symbol: string;
  buy_symbol: string;
  sell_amount: number;
  buy_amount: number | null;
  sell_tx_hash: string | null;
  buy_tx_hash: string | null;
  estimated_gain_pct: number;
  actual_gain_pct: number | null;
  estimated_fee_pct: number;
  status: string;
  veto_reason: string | null;
  dry_run: number;
  network: string;
}

export const rotationQueries = {
  insertRotation: db.prepare(`
    INSERT INTO rotations (sell_symbol, buy_symbol, sell_amount, estimated_gain_pct, estimated_fee_pct, dry_run, network)
    VALUES (@sell_symbol, @buy_symbol, @sell_amount, @estimated_gain_pct, @estimated_fee_pct, @dry_run, @network)
  `) as Statement<{ sell_symbol: string; buy_symbol: string; sell_amount: number; estimated_gain_pct: number; estimated_fee_pct: number; dry_run: number; network: string }>,

  updateRotation: db.prepare(`
    UPDATE rotations
    SET status = @status, buy_amount = @buy_amount, sell_tx_hash = @sell_tx_hash,
        buy_tx_hash = @buy_tx_hash, actual_gain_pct = @actual_gain_pct, veto_reason = @veto_reason
    WHERE id = @id
  `) as Statement<{ status: string; buy_amount: number | null; sell_tx_hash: string | null; buy_tx_hash: string | null; actual_gain_pct: number | null; veto_reason: string | null; id: number }>,

  getRecentRotations: db.prepare(`
    SELECT * FROM rotations WHERE network = ? ORDER BY id DESC LIMIT ?
  `) as Statement<[string, number], RotationRow>,

  getTodayRotationCount: db.prepare(`
    SELECT COUNT(*) as cnt FROM rotations
    WHERE network = ? AND date(timestamp) = date('now') AND status IN ('executed', 'leg1_done')
  `) as Statement<[string], { cnt: number }>,
};

export interface DailyPnlRow {
  date: string;
  network: string;
  high_water: number;
  current_usd: number;
  rotations: number;
  realized_pnl: number;
}

export const dailyPnlQueries = {
  upsertDailyPnl: db.prepare(`
    INSERT INTO daily_pnl (date, network, high_water, current_usd, rotations, realized_pnl)
    VALUES (@date, @network, @high_water, @current_usd, @rotations, @realized_pnl)
    ON CONFLICT(date, network) DO UPDATE SET
      high_water = MAX(daily_pnl.high_water, excluded.high_water),
      current_usd = excluded.current_usd,
      rotations = excluded.rotations,
      realized_pnl = excluded.realized_pnl
  `) as Statement<{ date: string; network: string; high_water: number; current_usd: number; rotations: number; realized_pnl: number }>,

  getDailyPnl: db.prepare(`
    SELECT * FROM daily_pnl WHERE date = ? AND network = ?
  `) as Statement<[string, string], DailyPnlRow>,

  getTodayPnl: db.prepare(`
    SELECT * FROM daily_pnl WHERE date = date('now') AND network = ?
  `) as Statement<[string], DailyPnlRow>,

  getRecentDailyPnl: db.prepare(`
    SELECT * FROM daily_pnl WHERE network = ? ORDER BY date DESC LIMIT ?
  `) as Statement<[string, number], DailyPnlRow>,
};
