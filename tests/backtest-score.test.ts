import { describe, it, expect } from 'vitest';
import { scoreAssets } from '../src/backtest/score.js';
import type { Candle } from '../src/services/candles.js';

function makeCandle(
  close: number,
  volume = 1000,
  source: Candle['source'] = 'coinbase',
): Candle {
  return {
    symbol: 'ETH',
    network: 'test',
    interval: '15m',
    openTime: '',
    open: close,
    high: close * 1.005,
    low: close * 0.995,
    close,
    volume,
    source,
  };
}

// 30 DESC candles: index 0 = most recent (highest price in a rising trend)
const rising30: Candle[] = Array.from({ length: 30 }, (_, i) => makeCandle(3000 - i * 5));
const noCandles: Candle[] = [];

describe('scoreAssets', () => {
  it('returns score=0, confidence=0.4 when no candles available', () => {
    const scores = scoreAssets(
      ['ETH'],
      () => noCandles,
      new Map([['ETH', 1], ['USDC', 200]]),
      new Map([['ETH', 3000], ['USDC', 1]]),
    );
    expect(scores[0].score).toBe(0);
    expect(scores[0].confidence).toBe(0.4);
    expect(scores[0].signals.candle15m.signal).toBe('hold');
  });

  it('sets isHeld=true when asset USD value >= $2', () => {
    const scores = scoreAssets(
      ['ETH'],
      () => noCandles,
      new Map([['ETH', 0.001]]),  // 0.001 * 3000 = $3
      new Map([['ETH', 3000]]),
    );
    expect(scores[0].isHeld).toBe(true);
  });

  it('sets isHeld=false when asset USD value < $2', () => {
    const scores = scoreAssets(
      ['ETH'],
      () => noCandles,
      new Map([['ETH', 0.0006]]),  // 0.0006 * 3000 = $1.80 < $2
      new Map([['ETH', 3000]]),
    );
    expect(scores[0].isHeld).toBe(false);
  });

  it('assigns confidence=1.0 for coinbase source', () => {
    const scores = scoreAssets(
      ['ETH'],
      () => rising30,
      new Map([['ETH', 0.1]]),
      new Map([['ETH', 3000]]),
    );
    expect(scores[0].confidence).toBe(1.0);
  });

  it('assigns confidence=0.4 for synthetic source', () => {
    const synth: Candle[] = Array.from({ length: 30 }, (_, i) =>
      makeCandle(3000 - i * 5, 1000, 'synthetic')
    );
    const scores = scoreAssets(
      ['ETH'],
      () => synth,
      new Map([['ETH', 0.1]]),
      new Map([['ETH', 3000]]),
    );
    expect(scores[0].confidence).toBe(0.4);
  });

  it('clamps score to [-100, 100]', () => {
    const scores = scoreAssets(
      ['ETH'],
      () => rising30,
      new Map([['ETH', 0.1]]),
      new Map([['ETH', 3000]]),
    );
    expect(scores[0].score).toBeGreaterThanOrEqual(-100);
    expect(scores[0].score).toBeLessThanOrEqual(100);
  });

  it('scores multiple symbols independently', () => {
    const scores = scoreAssets(
      ['ETH', 'CBBTC'],
      (sym) => sym === 'ETH' ? rising30 : noCandles,
      new Map([['ETH', 0.1], ['CBBTC', 0.001]]),
      new Map([['ETH', 3000], ['CBBTC', 90000]]),
    );
    expect(scores).toHaveLength(2);
    expect(scores.find(s => s.symbol === 'ETH')).toBeDefined();
    expect(scores.find(s => s.symbol === 'CBBTC')).toBeDefined();
  });

  it('currentWeight sums to 100 across symbols', () => {
    const scores = scoreAssets(
      ['ETH', 'USDC'],
      () => noCandles,
      new Map([['ETH', 0.05], ['USDC', 50]]),  // $150 ETH + $50 USDC = $200
      new Map([['ETH', 3000], ['USDC', 1]]),
    );
    const total = scores.reduce((s, a) => s + a.currentWeight, 0);
    expect(total).toBeCloseTo(100, 1);
  });
});
