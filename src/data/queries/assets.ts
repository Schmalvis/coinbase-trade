import { db } from '../connection.js';
import type { Statement } from 'better-sqlite3';

export interface DiscoveredAssetRow {
  address:      string;
  network:      string;
  symbol:       string;
  name:         string;
  decimals:     number;
  status:       'pending' | 'active' | 'dismissed';
  drop_pct:     number;
  rise_pct:     number;
  sma_short:    number;
  sma_long:     number;
  strategy:     'threshold' | 'sma' | 'grid';
  discovered_at: string;
  grid_manual_override: number;
  grid_upper_bound: number | null;
  grid_lower_bound: number | null;
  grid_levels:  number;
  grid_amount_pct: number;
  sma_use_ema: number;
  sma_volume_filter: number;
  sma_rsi_filter: number;
}

export const discoveredAssetQueries = {
  upsertDiscoveredAsset: db.prepare(`
    INSERT OR IGNORE INTO discovered_assets (address, network, symbol, name, decimals)
    VALUES (@address, @network, @symbol, @name, @decimals)
  `) as Statement<{ address: string; network: string; symbol: string; name: string; decimals: number }>,

  seedRegistryAsset: db.prepare(`
    INSERT OR IGNORE INTO discovered_assets (address, network, symbol, name, decimals, status)
    VALUES (@address, @network, @symbol, @name, @decimals, 'active')
  `) as Statement<{ address: string; network: string; symbol: string; name: string; decimals: number }>,

  getDiscoveredAssets: db.prepare(`
    SELECT * FROM discovered_assets WHERE network = ?
  `) as Statement<[string], DiscoveredAssetRow>,

  getActiveAssets: db.prepare(`
    SELECT * FROM discovered_assets WHERE status = 'active' AND network = ?
  `) as Statement<[string], DiscoveredAssetRow>,

  updateAssetStatus: db.prepare(`
    UPDATE discovered_assets SET status = @status WHERE address = @address AND network = @network
  `) as Statement<{ status: string; address: string; network: string }>,

  updateAssetStrategyConfig: db.prepare(`
    UPDATE discovered_assets
    SET drop_pct = @drop_pct, rise_pct = @rise_pct,
        sma_short = @sma_short, sma_long = @sma_long, strategy = @strategy,
        sma_use_ema = @sma_use_ema, sma_volume_filter = @sma_volume_filter,
        sma_rsi_filter = @sma_rsi_filter
    WHERE address = @address AND network = @network
  `) as Statement<{ drop_pct: number; rise_pct: number; sma_short: number; sma_long: number; strategy: string; sma_use_ema: number; sma_volume_filter: number; sma_rsi_filter: number; address: string; network: string }>,

  updateGridConfig: db.prepare(`
    UPDATE discovered_assets
    SET grid_levels = @grid_levels, grid_upper_bound = @grid_upper_bound,
        grid_lower_bound = @grid_lower_bound, grid_manual_override = @grid_manual_override
    WHERE address = @address AND network = @network
  `) as Statement<{ grid_levels: number; grid_upper_bound: number | null; grid_lower_bound: number | null; grid_manual_override: number; address: string; network: string }>,

  dismissAsset: db.prepare(`
    UPDATE discovered_assets SET status = 'dismissed' WHERE address = ? AND network = ?
  `) as Statement<[string, string]>,

  getAssetByAddress: db.prepare(`
    SELECT * FROM discovered_assets WHERE address = ? AND network = ?
  `) as Statement<[string, string], DiscoveredAssetRow>,

  getAssetBySymbol: db.prepare(
    `SELECT * FROM discovered_assets WHERE UPPER(symbol) = UPPER(?) AND network = ? LIMIT 1`
  ) as Statement<[string, string], DiscoveredAssetRow>,

  // C10: scoped to network + status='active' — an unscoped lookup could return a
  // dismissed/pending spam token's address for a symbol shared with an active/curated
  // asset, causing the executor to swap into the wrong (impostor) contract.
  getAddressBySymbol: db.prepare(
    `SELECT address FROM discovered_assets WHERE symbol = ? AND network = ? AND status = 'active' LIMIT 1`
  ) as Statement<[string, string], { address: string }>,

  getMemecoinflagBySymbol: db.prepare(
    `SELECT is_memecoin FROM discovered_assets WHERE symbol = ? LIMIT 1`
  ) as Statement<[string], { is_memecoin: number }>,

  getActiveMemecoins: db.prepare(
    `SELECT symbol FROM discovered_assets WHERE is_memecoin = 1 AND status = 'active'`
  ) as Statement<[], { symbol: string }>,

  // C3 — losing-streak auto-disable: last N realized (executed) sell trades for a symbol
  getRecentRealizedTrades: db.prepare(
    `SELECT realized_pnl FROM trades
     WHERE symbol = ? AND network = ? AND action = 'sell'
       AND realized_pnl IS NOT NULL AND status = 'executed'
     ORDER BY id DESC LIMIT ?`
  ) as Statement<[string, string, number], { realized_pnl: number }>,

  // C3 — set shadow_until (Unix ms) to pause an asset after a losing streak
  setShadowUntil: db.prepare(
    `UPDATE discovered_assets SET shadow_until = @shadow_until
     WHERE UPPER(symbol) = UPPER(@symbol) AND network = @network`
  ) as Statement<{ shadow_until: number; symbol: string; network: string }>,
};
