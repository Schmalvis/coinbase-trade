import { describe, it, expect, beforeEach, vi } from 'vitest';

const levels: Array<{ symbol: string; network: string; level_price: number; state: string }> = [];

vi.mock('../src/data/db.js', () => ({
  gridStateQueries: {
    upsertGridLevel: { run: (row: any) => {
      const idx = levels.findIndex(l =>
        l.symbol === row.symbol && l.network === row.network && l.level_price === row.level_price);
      if (idx >= 0) levels[idx] = row; else levels.push({ ...row });
    }},
    getGridLevels: { all: (sym: string, net: string) =>
      levels.filter(l => l.symbol === sym && l.network === net)
        .sort((a, b) => a.level_price - b.level_price)
    },
    clearGridLevels: { run: (sym: string, net: string) => {
      for (let i = levels.length - 1; i >= 0; i--) {
        if (levels[i].symbol === sym && levels[i].network === net) levels.splice(i, 1);
      }
    }},
  },
}));

import { GridStrategy } from '../src/strategy/grid.js';

function snap(prices: number[]) {
  return prices.map(p => ({
    eth_price: p, eth_balance: 0, portfolio_usd: 0,
    timestamp: new Date().toISOString(),
  }));
}

describe('GridStrategy', () => {
  beforeEach(() => { levels.length = 0; });

  it('returns hold on first tick (initialization)', () => {
    const g = new GridStrategy({
      symbol: 'ETH', network: 'base-sepolia', gridLevels: 5,
      upperBound: 2000, lowerBound: 1800,
      getCandleHigh24h: () => 2000, getCandleLow24h: () => 1800,
      feeEstimatePct: 1.0,
    });
    expect(g.evaluate(snap([1900])).signal).toBe('hold');
  });

  it('emits buy when price drops below a pending_buy level', () => {
    const g = new GridStrategy({
      symbol: 'ETH', network: 'base-sepolia', gridLevels: 5,
      upperBound: 2000, lowerBound: 1800,
      getCandleHigh24h: () => 2000, getCandleLow24h: () => 1800,
      feeEstimatePct: 1.0,
    });
    g.evaluate(snap([1900])); // init
    const r = g.evaluate(snap([1900, 1810]));
    expect(r.signal).toBe('buy');
    expect(r.reason).toContain('Grid');
  });

  it('emits sell when price rises above a pending_sell level', () => {
    const g = new GridStrategy({
      symbol: 'ETH', network: 'base-sepolia', gridLevels: 5,
      upperBound: 2000, lowerBound: 1800,
      getCandleHigh24h: () => 2000, getCandleLow24h: () => 1800,
      feeEstimatePct: 1.0,
    });
    g.evaluate(snap([1900])); // init
    const r = g.evaluate(snap([1900, 1990]));
    expect(r.signal).toBe('sell');
    expect(r.reason).toContain('Grid');
  });

  it('flips level state after trigger (buy then sell)', () => {
    // With 5 levels between 1800-2000, step = 200/6 = 33.3
    // Levels at ~1833, 1867, 1900, 1933, 1967
    // Buy triggers at 1867 when price drops to 1810
    // After flip to pending_sell, sell triggers when price rises above 1867
    const g = new GridStrategy({
      symbol: 'ETH', network: 'base-sepolia', gridLevels: 5,
      upperBound: 2000, lowerBound: 1800,
      getCandleHigh24h: () => 2000, getCandleLow24h: () => 1800,
      feeEstimatePct: 1.0,
    });
    g.evaluate(snap([1900])); // init
    const buy = g.evaluate(snap([1900, 1810]));
    expect(buy.signal).toBe('buy');
    // Price must rise above the flipped level (~1867) for sell
    const sell = g.evaluate(snap([1810, 1880]));
    expect(sell.signal).toBe('sell');
  });

  it('auto-calculates bounds from candle data', () => {
    const g = new GridStrategy({
      symbol: 'ETH', network: 'base-sepolia', gridLevels: 5,
      getCandleHigh24h: () => 2000, getCandleLow24h: () => 1800,
      feeEstimatePct: 1.0,
    });
    g.evaluate(snap([1900])); // init with auto bounds (upper=2040, lower=1764)
    const r = g.evaluate(snap([1900, 1770]));
    expect(r.signal).toBe('buy');
  });
});
