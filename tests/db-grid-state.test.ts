import { describe, it, expect, beforeEach } from 'vitest';
import { db, gridStateQueries } from '../src/data/db.js';

describe('grid_state table', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM grid_state').run();
  });

  it('upserts a grid level', () => {
    gridStateQueries.upsertGridLevel.run({
      symbol: 'ETH', network: 'base-sepolia',
      level_price: 1800, state: 'pending_buy',
    });
    const rows = gridStateQueries.getGridLevels.all('ETH', 'base-sepolia');
    expect(rows).toHaveLength(1);
    expect(rows[0].level_price).toBe(1800);
    expect(rows[0].state).toBe('pending_buy');
  });

  it('updates state on conflict', () => {
    gridStateQueries.upsertGridLevel.run({
      symbol: 'ETH', network: 'base-sepolia',
      level_price: 1800, state: 'pending_buy',
    });
    gridStateQueries.upsertGridLevel.run({
      symbol: 'ETH', network: 'base-sepolia',
      level_price: 1800, state: 'pending_sell',
    });
    const rows = gridStateQueries.getGridLevels.all('ETH', 'base-sepolia');
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('pending_sell');
  });

  it('clears all levels for a symbol/network', () => {
    gridStateQueries.upsertGridLevel.run({
      symbol: 'ETH', network: 'base-sepolia',
      level_price: 1800, state: 'pending_buy',
    });
    gridStateQueries.upsertGridLevel.run({
      symbol: 'ETH', network: 'base-sepolia',
      level_price: 1900, state: 'pending_sell',
    });
    gridStateQueries.clearGridLevels.run('ETH', 'base-sepolia');
    expect(gridStateQueries.getGridLevels.all('ETH', 'base-sepolia')).toHaveLength(0);
  });
});
