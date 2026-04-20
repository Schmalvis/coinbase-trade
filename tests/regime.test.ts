import { describe, it, expect } from 'vitest';
import { getMarketRegime } from '../src/strategy/regime.js';
import type { Candle } from '../src/services/candles.js';

function makeCandles(closes: number[]): Candle[] {
  return closes.map(close => ({
    symbol: 'ETH',
    network: 'base-mainnet',
    interval: '1h' as const,
    openTime: new Date().toISOString(),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    source: 'coinbase' as const,
  }));
}

/** Build 50 candles where last 10 are clearly above or below the SMA. */
function candlesWithTrend(direction: 'up' | 'down'): Candle[] {
  // First 40 candles at price 100 → SMA will be near 100
  const base = Array(40).fill(100);
  // Last 10 candles clearly above or below
  const tail = direction === 'up'
    ? Array(10).fill(200)   // well above SMA
    : Array(10).fill(1);    // well below SMA
  return makeCandles([...base, ...tail]);
}

describe('getMarketRegime', () => {
  it('returns neutral when fewer than 50 candles provided', () => {
    const candles = makeCandles(Array(49).fill(100));
    expect(getMarketRegime(candles)).toBe('neutral');
  });

  it('returns uptrend when 7+ of last 10 candles are above 50-period SMA and current > SMA', () => {
    const candles = candlesWithTrend('up');
    expect(getMarketRegime(candles)).toBe('uptrend');
  });

  it('returns downtrend when 7+ of last 10 candles are below 50-period SMA and current < SMA', () => {
    const candles = candlesWithTrend('down');
    expect(getMarketRegime(candles)).toBe('downtrend');
  });

  it('returns neutral for mixed signals (roughly half above, half below SMA)', () => {
    // All 50 candles at same price → SMA == current price → mixed signals
    const candles = makeCandles(Array(50).fill(100));
    // current price equals SMA → neither condition fires
    const result = getMarketRegime(candles);
    expect(result).toBe('neutral');
  });

  it('handles exactly 50 candles without throwing', () => {
    const candles = makeCandles(Array(50).fill(100));
    expect(() => getMarketRegime(candles)).not.toThrow();
  });
});
