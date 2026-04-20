import type { Candle } from '../services/candles.js';

export type MarketRegime = 'uptrend' | 'downtrend' | 'neutral';

const SMA_PERIOD = 50;

/**
 * Detect market regime based on price relative to 50-period SMA on 1h candles.
 * Returns 'downtrend' if 7+ of last 10 candles are below SMA and current price < SMA.
 * Returns 'uptrend' if 7+ of last 10 candles are above SMA and current price > SMA.
 * Returns 'neutral' for mixed signals or insufficient data.
 */
export function getMarketRegime(candles: Candle[]): MarketRegime {
  if (candles.length < SMA_PERIOD) return 'neutral';

  const recent = candles.slice(-SMA_PERIOD);
  const closes = recent.map(c => c.close);
  const sma = closes.reduce((a, b) => a + b, 0) / closes.length;

  const currentPrice = closes[closes.length - 1];
  const last10 = closes.slice(-10);
  const belowCount = last10.filter(p => p < sma).length;
  const aboveCount = last10.filter(p => p > sma).length;

  if (belowCount >= 7 && currentPrice < sma) return 'downtrend';
  if (aboveCount >= 7 && currentPrice > sma) return 'uptrend';
  return 'neutral';
}

/**
 * In downtrend: reduce buy signal weight (0.5x), amplify sell signal weight (1.5x).
 * In uptrend/neutral: no adjustment.
 */
export function getRegimeMultipliers(regime: MarketRegime): {
  buyMultiplier: number;
  sellMultiplier: number;
} {
  switch (regime) {
    case 'downtrend':
      return { buyMultiplier: 0.5, sellMultiplier: 1.5 };
    case 'uptrend':
    case 'neutral':
    default:
      return { buyMultiplier: 1.0, sellMultiplier: 1.0 };
  }
}
