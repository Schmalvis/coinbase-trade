import { db } from '../connection.js';
import type { Statement } from 'better-sqlite3';

export interface GridStateRow {
  id: number;
  symbol: string;
  network: string;
  level_price: number;
  state: 'pending_buy' | 'pending_sell' | 'idle';
  last_triggered: string | null;
}

export const gridStateQueries = {
  upsertGridLevel: db.prepare(`
    INSERT INTO grid_state (symbol, network, level_price, state)
    VALUES (@symbol, @network, @level_price, @state)
    ON CONFLICT(symbol, network, level_price) DO UPDATE SET
      state = excluded.state, last_triggered = datetime('now')
  `) as Statement<{ symbol: string; network: string; level_price: number; state: string }>,

  getGridLevels: db.prepare(`
    SELECT * FROM grid_state WHERE symbol = ? AND network = ? ORDER BY level_price ASC
  `) as Statement<[string, string], GridStateRow>,

  clearGridLevels: db.prepare(`
    DELETE FROM grid_state WHERE symbol = ? AND network = ?
  `) as Statement<[string, string]>,
};
