import { describe, it, expect, beforeEach } from 'vitest';
import { SMAStrategy } from '../src/strategy/sma.js';
import type { Snapshot } from '../src/strategy/base.js';

/**
 * With shortWindow=2, longWindow=3, useEma=true:
 *   shortVal = ema(prices.slice(0,2), 2) = sma([p0,p1]) = (p0+p1)/2
 *   longVal  = ema(prices.slice(0,3), 3) = sma([p0,p1,p2]) = (p0+p1+p2)/3
 *
 * shortVal > longVal  ⟺  (p0+p1)/2 > (p0+p1+p2)/3
 *                     ⟺  p2 < (p0+p1)/2
 *
 * So to start with short > long (prev above): use p2 < avg(p0,p1)  e.g. [100, 100, 50]
 * To cross to short < long (bearish crossover): use p2 > avg(p0,p1) e.g. [100, 100, 200]
 * To start with short < long (prev below): use p2 > avg(p0,p1)       e.g. [100, 100, 200]
 * To cross to short > long (bullish crossover): use p2 < avg(p0,p1) e.g. [100, 100, 50]
 */
function snap(prices: number[]): Snapshot[] {
  return prices.map(p => ({
    eth_price: p,
    eth_balance: 1,
    usdc_balance: 100,
    timestamp: new Date().toISOString(),
  }));
}

const SHORT = 2;
const LONG  = 3;

describe('SMAStrategy — EMA magnitude filter', () => {
  describe('bullish crossover (short crosses above long)', () => {
    it('holds when EMA gap is < 0.1% of price', () => {
      const strategy = new SMAStrategy({ shortWindow: SHORT, longWindow: LONG, useEma: true });

      // Init: short < long  (p2 large → long pulled up)
      // prices=[1000, 1000, 2000]: short=(1000+1000)/2=1000, long=(1000+1000+2000)/3=1333  → short < long
      strategy.evaluate(snap([1000, 1000, 2000])); // initialise prevShortAboveLong = false

      // Bullish crossover with tiny gap:
      // We need short > long but gap < 0.1% of price (~1000)
      // short=(p0+p1)/2, long=(p0+p1+p2)/3
      // Use p0=1000.2, p1=1000.0, p2=999.8
      // short = (1000.2+1000.0)/2 = 1000.1
      // long  = (1000.2+1000.0+999.8)/3 = 1000.0
      // gap = 0.1, price=999.8, emaPct = 0.1/999.8 ≈ 0.0001 = 0.01% < 0.1% ✓
      const result = strategy.evaluate(snap([1000.2, 1000.0, 999.8]));

      expect(result.signal).toBe('hold');
      expect(result.reason).toContain('EMA gap too small');
    });

    it('produces buy signal when EMA gap is >= 0.1% of price', () => {
      const strategy = new SMAStrategy({ shortWindow: SHORT, longWindow: LONG, useEma: true });

      // Init: short < long
      strategy.evaluate(snap([100, 100, 200])); // short=100, long=133 → short < long

      // Strong bullish crossover:
      // p0=200, p1=200, p2=50 → short=(200+200)/2=200, long=(200+200+50)/3=150 → short > long
      // gap = 50, price = 50, emaPct = 50/50 = 100% >> 0.1% ✓
      const result = strategy.evaluate(snap([200, 200, 50]));

      expect(result.signal).toBe('buy');
    });
  });

  describe('bearish crossover (short crosses below long)', () => {
    it('holds when EMA gap is < 0.1% of price', () => {
      const strategy = new SMAStrategy({ shortWindow: SHORT, longWindow: LONG, useEma: true });

      // Init: short > long  (p2 small)
      // prices=[1000, 1000, 1]: short=1000, long≈667 → short > long
      strategy.evaluate(snap([1000, 1000, 1])); // prevShortAboveLong = true

      // Bearish crossover with tiny gap:
      // Use p0=999.8, p1=1000.0, p2=1000.2
      // short=(999.8+1000.0)/2=999.9
      // long=(999.8+1000.0+1000.2)/3=1000.0
      // gap=0.1, price=1000.2, emaPct=0.1/1000.2 ≈ 0.0001 < 0.1% ✓
      const result = strategy.evaluate(snap([999.8, 1000.0, 1000.2]));

      expect(result.signal).toBe('hold');
      expect(result.reason).toContain('EMA gap too small');
    });

    it('produces sell signal when EMA gap is >= 0.1% of price', () => {
      const strategy = new SMAStrategy({ shortWindow: SHORT, longWindow: LONG, useEma: true });

      // Init: short > long
      strategy.evaluate(snap([200, 200, 50])); // short=200, long=150 → short > long

      // Strong bearish crossover:
      // p0=100, p1=100, p2=200 → short=(100+100)/2=100, long=(100+100+200)/3=133 → short < long
      // gap=33, price=200, emaPct=33/200=16.5% >> 0.1% ✓
      const result = strategy.evaluate(snap([100, 100, 200]));

      expect(result.signal).toBe('sell');
    });
  });
});
