import type { Strategy, Snapshot, StrategyResult } from './base.js';
import { config } from '../config.js';

export class ThresholdStrategy implements Strategy {
  name = 'threshold';
  private entryPrice: number | null = null;
  private consecutiveBuys = 0;
  private readonly maxConsecutiveBuys = 3;
  private trailingHigh: number | null = null;

  constructor(private readonly opts?: {
    dropPct?: number;
    risePct?: number;
    stopLossPct?: number;
    trailingStopPct?: number;
  }) {}

  evaluate(snapshots: Snapshot[]): StrategyResult {
    if (snapshots.length < 2) return { signal: 'hold', reason: 'Not enough data' };

    const current = snapshots[0].eth_price;
    const recent = snapshots.slice(0, 10).map(s => s.eth_price);
    const rollingHigh = Math.max(...recent);

    if (this.entryPrice === null) {
      this.entryPrice = current;
      this.trailingHigh = current;
      return { signal: 'hold', reason: 'Initialising entry price' };
    }

    // Update trailing high
    if (current > (this.trailingHigh ?? 0)) {
      this.trailingHigh = current;
    }

    const dropThreshold  = this.opts?.dropPct         ?? config.PRICE_DROP_THRESHOLD_PCT;
    const riseTarget     = this.opts?.risePct          ?? config.PRICE_RISE_TARGET_PCT;
    const stopLossPct    = this.opts?.stopLossPct      ?? config.STOP_LOSS_PCT;
    const trailingStopPct = this.opts?.trailingStopPct ?? config.TRAILING_STOP_PCT;

    const dropPct = ((rollingHigh - current) / rollingHigh) * 100;
    const gainPct = ((current - this.entryPrice) / this.entryPrice) * 100;

    // Hard stop-loss: sell if price drops stopLossPct% from entry
    if (gainPct <= -stopLossPct) {
      const prevEntry = this.entryPrice;
      this.entryPrice = current;
      this.trailingHigh = current;
      this.consecutiveBuys = 0;
      return {
        signal: 'sell',
        reason: `Stop-loss: ${gainPct.toFixed(2)}% from entry ($${prevEntry.toFixed(2)} → $${current.toFixed(2)})`,
      };
    }

    // Trailing stop: sell if price drops trailingStopPct% from trailing high (only when in profit)
    if (this.trailingHigh !== null && gainPct > 0) {
      const trailingDropPct = ((this.trailingHigh - current) / this.trailingHigh) * 100;
      if (trailingDropPct >= trailingStopPct) {
        const prevEntry = this.entryPrice;
        this.entryPrice = current;
        this.trailingHigh = current;
        this.consecutiveBuys = 0;
        return {
          signal: 'sell',
          reason: `Trailing stop: ${trailingDropPct.toFixed(2)}% drop from high $${this.trailingHigh.toFixed(2)} (entry $${prevEntry.toFixed(2)})`,
        };
      }
    }

    if (dropPct >= dropThreshold) {
      if (this.consecutiveBuys >= this.maxConsecutiveBuys) {
        return { signal: 'hold', reason: `Consecutive buy limit (${this.maxConsecutiveBuys}) reached — waiting for reversal` };
      }
      // Average down entry price instead of resetting to current — avoids death spiral
      this.entryPrice = (this.entryPrice + current) / 2;
      this.consecutiveBuys++;
      return {
        signal: 'buy',
        reason: `Price dropped ${dropPct.toFixed(2)}% from recent high ($${rollingHigh.toFixed(2)} → $${current.toFixed(2)})`,
      };
    }

    if (gainPct >= riseTarget) {
      const prevEntry = this.entryPrice;
      this.entryPrice = current;
      this.trailingHigh = current;
      this.consecutiveBuys = 0;
      return {
        signal: 'sell',
        reason: `Price up ${gainPct.toFixed(2)}% from entry ($${prevEntry.toFixed(2)} → $${current.toFixed(2)})`,
      };
    }

    return { signal: 'hold', reason: `Drop: ${dropPct.toFixed(2)}%, Gain from entry: ${gainPct.toFixed(2)}%` };
  }
}
