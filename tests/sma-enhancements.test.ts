import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  config: {
    SMA_SHORT_WINDOW: 3,
    SMA_LONG_WINDOW: 5,
  },
}));

import { SMAStrategy } from '../src/strategy/sma.js';

function makeSnaps(prices: number[]) {
  return prices.map((p, i) => ({
    eth_price: p,
    eth_balance: 1,
    portfolio_usd: p,
    timestamp: new Date(Date.now() - i * 1000).toISOString(),
  }));
}

describe('SMAStrategy — backward compatibility', () => {
  it('returns hold when insufficient data', () => {
    const s = new SMAStrategy();
    const result = s.evaluate(makeSnaps([100, 101, 102]));
    expect(result.signal).toBe('hold');
    expect(result.reason).toContain('Need 5');
  });

  it('returns hold on first evaluation (initialising)', () => {
    const s = new SMAStrategy();
    const result = s.evaluate(makeSnaps([10, 10, 10, 10, 10]));
    expect(result.signal).toBe('hold');
    expect(result.reason).toContain('Initialising');
  });

  it('detects bullish crossover (buy)', () => {
    const s = new SMAStrategy({ shortWindow: 2, longWindow: 4 });
    // First call: short below long → initialise
    s.evaluate(makeSnaps([1, 2, 3, 4])); // short avg(1,2)=1.5, long avg(1,2,3,4)=2.5 → short < long
    // Second call: short above long → bullish crossover
    const result = s.evaluate(makeSnaps([10, 9, 3, 4])); // short avg(10,9)=9.5, long avg(10,9,3,4)=6.5 → short > long
    expect(result.signal).toBe('buy');
    expect(result.reason).toContain('Bullish crossover');
  });

  it('detects bearish crossover (sell)', () => {
    const s = new SMAStrategy({ shortWindow: 2, longWindow: 4 });
    // First call: short above long → initialise
    s.evaluate(makeSnaps([10, 9, 3, 4])); // short avg(10,9)=9.5, long avg(10,9,3,4)=6.5 → short > long
    // Second call: short below long → bearish crossover
    const result = s.evaluate(makeSnaps([1, 2, 3, 4])); // short avg(1,2)=1.5, long avg(1,2,3,4)=2.5 → short < long
    expect(result.signal).toBe('sell');
    expect(result.reason).toContain('Bearish crossover');
  });

  it('works with no constructor options', () => {
    const s = new SMAStrategy();
    const result = s.evaluate(makeSnaps([10, 10, 10, 10, 10]));
    expect(result.signal).toBe('hold');
    expect(result.reason).toContain('SMA');
  });
});

describe('SMAStrategy — EMA mode', () => {
  it('uses EMA when useEma: true — reason contains EMA', () => {
    const s = new SMAStrategy({ shortWindow: 2, longWindow: 4, useEma: true });
    const result = s.evaluate(makeSnaps([10, 10, 10, 10]));
    expect(result.signal).toBe('hold');
    expect(result.reason).toContain('EMA');
  });

  it('defaults to SMA when useEma not set — reason contains SMA not EMA', () => {
    const s = new SMAStrategy({ shortWindow: 2, longWindow: 4 });
    const result = s.evaluate(makeSnaps([10, 10, 10, 10]));
    expect(result.signal).toBe('hold');
    expect(result.reason).toContain('SMA');
    expect(result.reason).not.toContain('EMA');
  });
});
