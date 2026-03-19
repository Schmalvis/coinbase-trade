import { describe, it, expect } from 'vitest';
import {
  computeRSI,
  computeMACD,
  computeBollingerBands,
  CandleStrategy,
  type Candle,
} from '../src/strategy/candle.js';

/* ------------------------------------------------------------------ */
/*  Helper                                                             */
/* ------------------------------------------------------------------ */

function makeCandles(
  closes: number[],
  opts?: {
    volumes?: number[];
    highs?: number[];
    lows?: number[];
    opens?: number[];
  },
): Candle[] {
  return closes.map((close, i) => ({
    open: opts?.opens?.[i] ?? close,
    high: opts?.highs?.[i] ?? close + 1,
    low: opts?.lows?.[i] ?? close - 1,
    close,
    volume: opts?.volumes?.[i] ?? 100,
  }));
}

/* ------------------------------------------------------------------ */
/*  computeBollingerBands                                              */
/* ------------------------------------------------------------------ */

describe('computeBollingerBands', () => {
  it('returns middle as SMA of closes', () => {
    const closes = Array.from({ length: 20 }, () => 100);
    const bb = computeBollingerBands(closes, 20, 2);
    expect(bb).not.toBeNull();
    expect(bb!.middle).toBeCloseTo(100, 5);
    expect(bb!.upper).toBeCloseTo(100, 5);
    expect(bb!.lower).toBeCloseTo(100, 5);
  });

  it('bands widen with volatile prices', () => {
    const closes = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 90 : 110));
    const bb = computeBollingerBands(closes, 20, 2);
    expect(bb!.middle).toBeCloseTo(100, 1);
    expect(bb!.upper).toBeGreaterThan(110);
    expect(bb!.lower).toBeLessThan(90);
  });

  it('returns null when not enough data', () => {
    expect(computeBollingerBands([100, 101], 20, 2)).toBeNull();
  });

  it('detects squeeze when bandwidth is narrow', () => {
    const volatile = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 80 : 120));
    const flat = Array.from({ length: 20 }, () => 100);
    const bb = computeBollingerBands([...volatile, ...flat], 20, 2);
    expect(bb).not.toBeNull();
    expect(bb!.squeeze).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  computeRSI                                                         */
/* ------------------------------------------------------------------ */

describe('computeRSI', () => {
  it('returns ~50 for alternating up/down prices', () => {
    // 20 values alternating between 100 and 102
    const closes = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 100 : 102));
    const rsi = computeRSI(closes);
    expect(rsi).toBeGreaterThanOrEqual(40);
    expect(rsi).toBeLessThanOrEqual(60);
  });

  it('returns > 70 for consistently rising prices', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i * 2);
    const rsi = computeRSI(closes);
    expect(rsi).toBeGreaterThan(70);
  });

  it('returns < 30 for consistently falling prices', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i * 2);
    const rsi = computeRSI(closes);
    expect(rsi).toBeLessThan(30);
  });

  it('returns 50 when not enough data', () => {
    expect(computeRSI([100, 101])).toBe(50);
  });
});

/* ------------------------------------------------------------------ */
/*  computeMACD                                                        */
/* ------------------------------------------------------------------ */

describe('computeMACD', () => {
  it('returns positive histogram for rising prices', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
    const { histogram } = computeMACD(closes);
    expect(histogram).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/*  CandleStrategy.evaluate                                            */
/* ------------------------------------------------------------------ */

describe('CandleStrategy.evaluate', () => {
  const strategy = new CandleStrategy();

  it('returns hold with "Need" in reason when < 26 candles', () => {
    const candles = makeCandles(Array.from({ length: 10 }, () => 100));
    const result = strategy.evaluate(candles);
    expect(result.signal).toBe('hold');
    expect(result.reason).toContain('Need');
  });

  it('returns buy for strongly falling prices', () => {
    // Flat then sharp drop → RSI oversold (+40 buy).
    // Add a long lower wick on last candle (+15 buy) to push net above 20.
    const flat = Array.from({ length: 20 }, () => 200);
    const drop = Array.from({ length: 20 }, (_, i) => 200 - (i + 1) * 5);
    const closes = [...flat, ...drop];
    // Build candles with long lower wick on the last candle
    const candles = closes.map((close, i) => {
      const isLast = i === closes.length - 1;
      return {
        open: close,
        high: close + 1,
        // Last candle: low is far below close → long lower wick > 50% of range
        low: isLast ? close - 10 : close - 1,
        close,
        volume: 100,
      };
    });
    const result = strategy.evaluate(candles);
    expect(result.signal).toBe('buy');
  });

  it('returns sell for strongly rising prices', () => {
    // Flat then sharp rise → RSI overbought (+40 sell).
    // Add a long upper wick on last candle (+15 sell) to push net below -20.
    const flat = Array.from({ length: 20 }, () => 100);
    const rise = Array.from({ length: 20 }, (_, i) => 100 + (i + 1) * 5);
    const closes = [...flat, ...rise];
    // Build candles with long upper wick on the last candle
    const candles = closes.map((close, i) => {
      const isLast = i === closes.length - 1;
      return {
        open: close,
        // Last candle: high is far above close → long upper wick > 50% of range
        high: isLast ? close + 10 : close + 1,
        low: close - 1,
        close,
        volume: 100,
      };
    });
    const result = strategy.evaluate(candles);
    expect(result.signal).toBe('sell');
  });

  it('produces higher strength when volume is high on last candle', () => {
    // Use same flat-then-drop pattern that produces a buy signal
    const flat = Array.from({ length: 20 }, () => 200);
    const drop = Array.from({ length: 20 }, (_, i) => 200 - (i + 1) * 5);
    const closes = [...flat, ...drop];

    const makeCandlesWithWick = (volumes?: number[]) =>
      closes.map((close, i) => ({
        open: close,
        high: close + 1,
        low: i === closes.length - 1 ? close - 10 : close - 1,
        close,
        volume: volumes?.[i] ?? 100,
      }));

    // Low volume version
    const lowResult = strategy.evaluate(makeCandlesWithWick());

    // High volume version — last candle has 5x average
    const highVolumes = Array.from({ length: closes.length }, (_, i) =>
      i === closes.length - 1 ? 500 : 100,
    );
    const highResult = strategy.evaluate(makeCandlesWithWick(highVolumes));

    expect(highResult.strength).toBeGreaterThanOrEqual(lowResult.strength);
  });
});
