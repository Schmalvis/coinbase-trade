import type { Strategy, Snapshot, StrategyResult } from './base.js';
import { config } from '../config.js';

function sma(prices: number[]): number {
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

/** Exponential moving average over `period` most-recent values. */
function ema(prices: number[], period: number): number {
  if (prices.length === 0) return 0;
  const k = 2 / (period + 1);
  // Seed with SMA of the first `period` values (or all if fewer)
  const seed = prices.slice(0, Math.min(period, prices.length));
  let value = sma(seed);
  // Walk forward from position `seed.length` applying the EMA formula
  for (let i = seed.length; i < prices.length; i++) {
    value = prices[i] * k + value * (1 - k);
  }
  return value;
}

export interface SMAStrategyOpts {
  shortWindow?: number;
  longWindow?: number;
  useEma?: boolean;
  getVolume?: () => { current: number; average: number } | null;
  getRsi?: () => number | null;
}

export class SMAStrategy implements Strategy {
  name = 'sma';
  private prevShortAboveLong: boolean | null = null;

  constructor(private readonly opts?: SMAStrategyOpts) {}

  evaluate(snapshots: Snapshot[]): StrategyResult {
    const shortW = this.opts?.shortWindow ?? config.SMA_SHORT_WINDOW;
    const longW  = this.opts?.longWindow  ?? config.SMA_LONG_WINDOW;
    const useEma = this.opts?.useEma ?? false;

    if (snapshots.length < longW) {
      return { signal: 'hold', reason: `Need ${longW} snapshots, have ${snapshots.length}` };
    }

    const prices = snapshots.map(s => s.eth_price);
    const label = useEma ? 'EMA' : 'SMA';

    const shortVal = useEma
      ? ema(prices.slice(0, shortW), shortW)
      : sma(prices.slice(0, shortW));
    const longVal = useEma
      ? ema(prices.slice(0, longW), longW)
      : sma(prices.slice(0, longW));

    const shortAboveLong = shortVal > longVal;

    const reason = `${label}${shortW}=$${shortVal.toFixed(2)} ${label}${longW}=$${longVal.toFixed(2)}`;

    if (this.prevShortAboveLong === null) {
      this.prevShortAboveLong = shortAboveLong;
      return { signal: 'hold', reason: `Initialising — ${reason}` };
    }

    if (!this.prevShortAboveLong && shortAboveLong) {
      this.prevShortAboveLong = true;

      // Volume confirmation filter
      const vol = this.opts?.getVolume?.();
      if (vol && vol.current / vol.average < 1.5) {
        return { signal: 'hold', reason: `Bullish crossover blocked — low volume (${vol.current}/${vol.average}) — ${reason}` };
      }

      // RSI filter — block buy when overbought
      const rsi = this.opts?.getRsi?.();
      if (rsi != null && rsi > 70) {
        return { signal: 'hold', reason: `Bullish crossover blocked — RSI overbought (${rsi}) — ${reason}` };
      }

      return { signal: 'buy', reason: `Bullish crossover — ${reason}` };
    }

    if (this.prevShortAboveLong && !shortAboveLong) {
      this.prevShortAboveLong = false;

      // Volume confirmation filter
      const vol = this.opts?.getVolume?.();
      if (vol && vol.current / vol.average < 1.5) {
        return { signal: 'hold', reason: `Bearish crossover blocked — low volume (${vol.current}/${vol.average}) — ${reason}` };
      }

      // RSI filter — block sell when oversold
      const rsi = this.opts?.getRsi?.();
      if (rsi != null && rsi < 30) {
        return { signal: 'hold', reason: `Bearish crossover blocked — RSI oversold (${rsi}) — ${reason}` };
      }

      return { signal: 'sell', reason: `Bearish crossover — ${reason}` };
    }

    this.prevShortAboveLong = shortAboveLong;
    return { signal: 'hold', reason };
  }
}
