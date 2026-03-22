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
};
