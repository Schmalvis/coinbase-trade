import type { Strategy, Snapshot, StrategyResult } from './base.js';
import { config } from '../config.js';

export class ThresholdStrategy implements Strategy {
  name = 'threshold';
  private entryPrice: number | null = null;
  private consecutiveBuys = 0;
  private readonly maxConsecutiveBuys = 3;

  constructor(private readonly opts?: { dropPct?: number; risePct?: number }) {}

  evaluate(snapshots: Snapshot[]): StrategyResult {
    if (snapshots.length < 2) return { signal: 'hold', reason: 'Not enough data' };

    const current = snapshots[0].eth_price;
    const recent = snapshots.slice(0, 10).map(s => s.eth_price);
    const rollingHigh = Math.max(...recent);

    if (this.entryPrice === null) {
      this.entryPrice = current;
      return { signal: 'hold', reason: 'Initialising entry price' };
    }

    const dropPct = ((rollingHigh - current) / rollingHigh) * 100;
    const gainPct = ((current - this.entryPrice) / this.entryPrice) * 100;

    const dropThreshold = this.opts?.dropPct ?? config.PRICE_DROP_THRESHOLD_PCT;
    const riseTarget    = this.opts?.risePct ?? config.PRICE_RISE_TARGET_PCT;

    if (dropPct >= dropThreshold) {
      if (this.consecutiveBuys >= this.maxConsecutiveBuys) {
        return { signal: 'hold', reason: `Consecutive buy limit (${this.maxConsecutiveBuys}) reached — waiting for reversal` };
      }
      this.entryPrice = current;
      this.consecutiveBuys++;
      return {
        signal: 'buy',
        reason: `Price dropped ${dropPct.toFixed(2)}% from recent high ($${rollingHigh.toFixed(2)} → $${current.toFixed(2)})`,
      };
    }

    if (gainPct >= riseTarget) {
      this.entryPrice = current;
      this.consecutiveBuys = 0;
      return {
        signal: 'sell',
        reason: `Price up ${gainPct.toFixed(2)}% from entry ($${this.entryPrice.toFixed(2)} → $${current.toFixed(2)})`,
      };
    }

    return { signal: 'hold', reason: `Drop: ${dropPct.toFixed(2)}%, Gain from entry: ${gainPct.toFixed(2)}%` };
  }
}
