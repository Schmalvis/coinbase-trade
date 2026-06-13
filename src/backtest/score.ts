import { CandleStrategy, type CandleSignal } from '../strategy/candle.js';
import type { Candle } from '../services/candles.js';
import type { ScoredAsset } from './types.js';

const HOLD_SIGNAL: CandleSignal = { signal: 'hold', strength: 0, reason: 'no data' };
// CandleStrategy is stateless — one instance is fine
const strategy = new CandleStrategy();

/**
 * Pure port of PortfolioOptimizer.computeScores() (optimizer.ts:253–340).
 * Candle arrays must be in DESC order (newest first), matching the ordering
 * returned by candleQueries.getCandles — same as production.
 */
export function scoreAssets(
  symbols: string[],
  getCandles: (symbol: string, interval: '15m' | '1h' | '24h') => Candle[],
  balances: Map<string, number>,
  prices: Map<string, number>,
): ScoredAsset[] {
  let totalUsd = 0;
  const assetUsd = new Map<string, number>();
  for (const sym of symbols) {
    const usd = (balances.get(sym) ?? 0) * (prices.get(sym) ?? 0);
    assetUsd.set(sym, usd);
    totalUsd += usd;
  }

  return symbols.map(sym => {
    const c15m = getCandles(sym, '15m');
    const c1h  = getCandles(sym, '1h');
    const c24h = getCandles(sym, '24h');

    // Pass 1h candles as second arg to enable regime multipliers — matches production
    // (optimizer.ts:275-277). Known divergences from live: macro gate (ETH downtrend
    // blocks crypto buys), hold-bias (+15Δ for marginally-underwater positions), and
    // correlated-pair blacklist are NOT replicated. Backtest scores will be slightly
    // more optimistic than live in downtrend conditions.
    const hourly = c1h.length >= 26 ? c1h : undefined;
    const s15m = c15m.length >= 26 ? strategy.evaluate(c15m, hourly) : HOLD_SIGNAL;
    const s1h  = c1h.length  >= 26 ? strategy.evaluate(c1h)          : HOLD_SIGNAL;
    const s24h = c24h.length >= 26 ? strategy.evaluate(c24h)         : HOLD_SIGNAL;

    const dir = (s: CandleSignal) => s.signal === 'buy' ? 1 : s.signal === 'sell' ? -1 : 0;

    // Exact weights from optimizer.ts:283–286
    const raw =
      dir(s15m) * s15m.strength * 0.5 +
      dir(s1h)  * s1h.strength  * 0.3 +
      dir(s24h) * s24h.strength * 0.2;

    // Confidence from candle source (optimizer.ts:289–295)
    let confidence = 0.4;
    if (c15m.length > 0) {
      const src = c15m[0].source; // c15m[0] is most recent (DESC order)
      confidence = src === 'coinbase' ? 1.0 : src === 'dex' ? 0.7 : 0.4;
    }

    let score = raw * confidence;

    // Volume bonus (optimizer.ts:300–307)
    if (c15m.length > 0) {
      const latestVol = c15m[0].volume;
      const window = c15m.slice(0, 20);
      const avgVol = window.reduce((s, c) => s + c.volume, 0) / window.length;
      if (avgVol > 0 && latestVol > 1.5 * avgVol) score += score >= 0 ? 10 : -10;
    }

    score = Math.max(-100, Math.min(100, score));

    const usdValue = assetUsd.get(sym) ?? 0;
    return {
      symbol: sym,
      score,
      confidence,
      isHeld: usdValue >= 2,
      currentWeight: totalUsd > 0 ? (usdValue / totalUsd) * 100 : 0,
      signals: { candle15m: s15m, candle1h: s1h, candle24h: s24h },
    };
  });
}
