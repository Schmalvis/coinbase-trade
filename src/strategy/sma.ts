import type { Strategy, Snapshot, StrategyResult } from './base.js';
import { config } from '../config.js';

function sma(prices: number[]): number {
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

export class SMAStrategy implements Strategy {
  name = 'sma';
  private prevShortAboveLong: boolean | null = null;

  evaluate(snapshots: Snapshot[]): StrategyResult {
    const needed = config.SMA_LONG_WINDOW;
    if (snapshots.length < needed) {
      return { signal: 'hold', reason: `Need ${needed} snapshots, have ${snapshots.length}` };
    }

    // snapshots are newest-first
    const prices = snapshots.map(s => s.eth_price);
    const shortSMA = sma(prices.slice(0, config.SMA_SHORT_WINDOW));
    const longSMA  = sma(prices.slice(0, config.SMA_LONG_WINDOW));
    const shortAboveLong = shortSMA > longSMA;

    const reason = `SMA${config.SMA_SHORT_WINDOW}=$${shortSMA.toFixed(2)} SMA${config.SMA_LONG_WINDOW}=$${longSMA.toFixed(2)}`;

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
