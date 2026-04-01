/**
 * TrendContinuationStrategy (TCP) — buys 15m pullbacks to EMA-20 when the
 * 1h trend is aligned (EMA5 > EMA20 > EMA50). Takes profit at the prior 1h
 * swing high. Stops below 1h EMA-50.
 *
 * Cold-start guard: returns 'hold' until ≥ TCP_MIN_1H_CANDLES × 1h candles
 * are available. The API also enforces this — the strategy cannot be enabled
 * via the dashboard until the candle requirement is met.
 *
 * Known limitation: inPosition and swingHigh are in-memory and reset on
 * restart. On the next evaluation cycle after a restart, the strategy
 * re-evaluates from current market state. This matches ThresholdStrategy's
 * existing behaviour.
 */

import type { Strategy, Snapshot, StrategyResult } from './base.js';
import type { Candle } from './candle.js';
import { ema, computeRSI } from './candle.js';
import { TCP_MIN_1H_CANDLES } from './constants.js';

export class TrendContinuationStrategy implements Strategy {
  name = 'trend-continuation';

  private swingHigh: number | null = null;
  private inPosition = false;

  constructor(
    private readonly getCandles15m: (limit: number) => Candle[],
    private readonly getCandles1h: (limit: number) => Candle[],
  ) {}

  evaluate(snapshots: Snapshot[]): StrategyResult {
    if (snapshots.length < 2) return { signal: 'hold', reason: 'Not enough data' };

    // Hard cold-start guard: EMA-50 needs at least TCP_MIN_1H_CANDLES candles
    const candles1h = this.getCandles1h(65);
    if (candles1h.length < TCP_MIN_1H_CANDLES) {
      return {
        signal: 'hold',
        reason: `TCP cold start: need ${TCP_MIN_1H_CANDLES} × 1h candles (have ${candles1h.length})`,
      };
    }

    const candles15m = this.getCandles15m(30);
    if (candles15m.length < 26) {
      return {
        signal: 'hold',
        reason: `TCP: need 26 × 15m candles (have ${candles15m.length})`,
      };
    }

    // 1h EMA alignment
    const closes1h = candles1h.map(c => c.close);
    const ema5arr  = ema(closes1h, 5);
    const ema20arr = ema(closes1h, 20);
    const ema50arr = ema(closes1h, 50);
    const e5  = ema5arr[ema5arr.length - 1];
    const e20 = ema20arr[ema20arr.length - 1];
    const e50 = ema50arr[ema50arr.length - 1];
    const currentPrice1h = closes1h[closes1h.length - 1];
    const trendAligned = e5 > e20 && e20 > e50;

    // Exit: stop-loss — price drops below 1h EMA-50
    if (this.inPosition && currentPrice1h < e50) {
      this.inPosition = false;
      this.swingHigh = null;
      return {
        signal: 'sell',
        priority: 'stop-loss',
        reason: `TCP stop: 1h price ${currentPrice1h.toFixed(4)} < EMA-50 ${e50.toFixed(4)}`,
      };
    }

    // Exit: take-profit — price reaches swing high
    if (this.inPosition && this.swingHigh !== null && currentPrice1h >= this.swingHigh) {
      const target = this.swingHigh;
      this.inPosition = false;
      this.swingHigh = null;
      return {
        signal: 'sell',
        priority: 'stop-loss',
        reason: `TCP TP: price reached swing high ${target.toFixed(4)}`,
      };
    }

    if (!trendAligned) {
      return {
        signal: 'hold',
        reason: `TCP: trend not aligned — EMA5 ${e5.toFixed(2)}, EMA20 ${e20.toFixed(2)}, EMA50 ${e50.toFixed(2)}`,
      };
    }

    // 15m pullback to EMA-20 (tolerance widened to 0.8% for CBBTC compatibility)
    const closes15m = candles15m.map(c => c.close);
    const ema20_15m = ema(closes15m, 20);
    const currentPrice15m = closes15m[closes15m.length - 1];
    const currentEma20_15m = ema20_15m[ema20_15m.length - 1];
    const distancePct = Math.abs((currentPrice15m - currentEma20_15m) / currentEma20_15m) * 100;
    const atEma20 = distancePct <= 0.8;

    const rsi = computeRSI(closes15m);
    const rsiInZone = rsi >= 40 && rsi <= 55;

    const volumes = candles15m.map(c => c.volume);
    const avgVol = volumes.slice(0, 20).reduce((a, b) => a + b, 0) / Math.min(volumes.length, 20);
    const quietPullback = avgVol > 0 ? volumes[volumes.length - 1] < avgVol : true;

    // Entry: all conditions aligned
    if (!this.inPosition && atEma20 && rsiInZone && quietPullback) {
      // Use slice(-11, -1) to exclude the live candle from swing high calculation
      const candidateSwingHigh = Math.max(...candles1h.slice(-11, -1).map(c => c.high));

      // Minimum TP guard: skip entry if swing high is within 0.5% of entry (risk:reward below fee threshold)
      if (candidateSwingHigh <= currentPrice1h * 1.005) {
        return {
          signal: 'hold',
          reason: `TCP: trivial TP (swing high ${candidateSwingHigh.toFixed(4)} ≤ 0.5% above entry ${currentPrice1h.toFixed(4)}) — skipping`,
        };
      }

      this.swingHigh = candidateSwingHigh;
      this.inPosition = true;
      return {
        signal: 'buy',
        reason: `TCP entry: trend✓, pullback ${distancePct.toFixed(2)}% from EMA-20, RSI ${rsi.toFixed(1)}, quiet vol, TP ${this.swingHigh.toFixed(4)}`,
      };
    }

    return {
      signal: 'hold',
      reason: `TCP: trend${trendAligned ? '✓' : '✗'} pullback${atEma20 ? '✓' : `✗(${distancePct.toFixed(1)}%)`} RSI${rsiInZone ? '✓' : `✗(${rsi.toFixed(1)})`} vol${quietPullback ? '✓' : '✗'}`,
    };
  }
}
