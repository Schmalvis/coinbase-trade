import type { Strategy, Snapshot, StrategyResult } from './base.js';
import { config } from '../config.js';

function sma(prices: number[]): number {
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

export class SMAStrategy implements Strategy {
  name = 'sma';
  private prevShortAboveLong: boolean | null = null;

  constructor(private readonly opts?: { shortWindow?: number; longWindow?: number }) {}

  evaluate(snapshots: Snapshot[]): StrategyResult {
    const shortW = this.opts?.shortWindow ?? config.SMA_SHORT_WINDOW;
    const longW  = this.opts?.longWindow  ?? config.SMA_LONG_WINDOW;

    if (snapshots.length < longW) {
      return { signal: 'hold', reason: `Need ${longW} snapshots, have ${snapshots.length}` };
    }

    const prices = snapshots.map(s => s.eth_price);
    const shortSMA = sma(prices.slice(0, shortW));
    const longSMA  = sma(prices.slice(0, longW));
    const shortAboveLong = shortSMA > longSMA;

    const reason = `SMA${shortW}=$${shortSMA.toFixed(2)} SMA${longW}=$${longSMA.toFixed(2)}`;

    if (this.prevShortAboveLong === null) {
      this.prevShortAboveLong = shortAboveLong;
      return { signal: 'hold', reason: `Initialising — ${reason}` };
    }

    if (!this.prevShortAboveLong && shortAboveLong) {
      this.prevShortAboveLong = true;
      return { signal: 'buy', reason: `Bullish crossover — ${reason}` };
    }

    if (this.prevShortAboveLong && !shortAboveLong) {
      this.prevShortAboveLong = false;
      return { signal: 'sell', reason: `Bearish crossover — ${reason}` };
    }

    this.prevShortAboveLong = shortAboveLong;
    return { signal: 'hold', reason };
  }
}
