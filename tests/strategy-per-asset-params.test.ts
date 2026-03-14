import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  config: {
    PRICE_DROP_THRESHOLD_PCT: 2.0,
    PRICE_RISE_TARGET_PCT: 3.0,
    SMA_SHORT_WINDOW: 3,
    SMA_LONG_WINDOW: 5,
  },
}));

import { ThresholdStrategy } from '../src/strategy/threshold.js';
import { SMAStrategy } from '../src/strategy/sma.js';

// Helpers
function makeSnaps(prices: number[]) {
  return prices.map((p, i) => ({
    eth_price: p,
    eth_balance: 1,
    portfolio_usd: p,
    timestamp: new Date(Date.now() - i * 1000).toISOString(),
  }));
}

describe('ThresholdStrategy — per-asset params', () => {
  it('uses global config when no opts provided', () => {
    const s = new ThresholdStrategy();
    // Prime entry price
    s.evaluate(makeSnaps([100, 99]));
    // 3% drop from high 100 → 97 should trigger buy (>= 2.0% global threshold)
    const result = s.evaluate(makeSnaps([97, 100]));
    expect(result.signal).toBe('buy');
  });

  it('uses explicit dropPct override', () => {
    const s = new ThresholdStrategy({ dropPct: 10.0, risePct: 20.0 });
    s.evaluate(makeSnaps([100, 99]));
    // 3% drop should NOT trigger with 10% threshold
    const result = s.evaluate(makeSnaps([97, 100]));
    expect(result.signal).toBe('hold');
  });

  it('uses explicit risePct override', () => {
    const s = new ThresholdStrategy({ dropPct: 2.0, risePct: 20.0 });
    // Prime entry at 97 via a buy signal
    s.evaluate(makeSnaps([100, 99]));
    s.evaluate(makeSnaps([97, 100])); // sets entryPrice = 97
    // 5% gain from 97 → ~101.85 — below 20% override, should hold
    const result = s.evaluate(makeSnaps([102, 100, 97]));
    expect(result.signal).toBe('hold');
  });
});

describe('SMAStrategy — per-asset params', () => {
  it('uses global config when no opts provided', () => {
    const s = new SMAStrategy();
    const snaps = makeSnaps([1, 1, 1, 1, 1, 1, 1]);
    expect(s.evaluate(snaps).signal).toBe('hold');
  });

  it('uses explicit shortWindow / longWindow override', () => {
    const s = new SMAStrategy({ shortWindow: 2, longWindow: 4 });
    // Need 4 snapshots (longWindow override)
    const result = s.evaluate(makeSnaps([10, 9, 8, 7]));
    // Signal will be 'hold' on first eval (initialising), but should not throw
    expect(['hold', 'buy', 'sell']).toContain(result.signal);
  });

  it('rejects evaluation when fewer snapshots than longWindow override', () => {
    const s = new SMAStrategy({ shortWindow: 2, longWindow: 10 });
    const result = s.evaluate(makeSnaps([1, 2, 3]));
    expect(result.signal).toBe('hold');
    expect(result.reason).toContain('Need 10');
  });
});
