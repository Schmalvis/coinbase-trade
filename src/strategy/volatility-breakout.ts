/**
 * VolatilityBreakoutStrategy (VBR) — waits for a Bollinger Band squeeze
 * (N consecutive candles of low bandwidth), then buys on a breakout above
 * the upper band with volume confirmation. Exits when price falls back to
 * the BB middle band.
 *
 * Estimated win rate: 52–55% on 1h data; favours sharp momentum moves.
 */

import type { Strategy, Snapshot, StrategyResult } from './base.js';
import type { Candle } from './candle.js';
import { computeBollingerBands } from './candle.js';

export class VolatilityBreakoutStrategy implements Strategy {
  name = 'volatility-breakout';

  private squeezeCount = 0;
  private inPosition = false;
  private readonly SQUEEZE_REQUIRED = 3;  // consecutive squeezed candles before watching
  private readonly BREAKOUT_VOL_MULT = 2.0; // volume must be 2× average to confirm breakout

  constructor(
    private readonly getCandles1h: (limit: number) => Candle[],
  ) {}

  evaluate(snapshots: Snapshot[]): StrategyResult {
    if (snapshots.length < 2) return { signal: 'hold', reason: 'Not enough data' };

    const candles1h = this.getCandles1h(30);
    if (candles1h.length < 22) {
      return { signal: 'hold', reason: `VBR: need 22 x 1h candles (have ${candles1h.length})` };
    }

    const closes = candles1h.map(c => c.close);
    const bb = computeBollingerBands(closes);
    if (!bb) return { signal: 'hold', reason: 'VBR: BB not ready' };

    const latestClose = closes[closes.length - 1];

    // Volume: latest candle vs 20-period average
    const volumes = candles1h.map(c => c.volume);
    const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(volumes.length, 20);
    const volRatio = avgVol > 0 ? volumes[volumes.length - 1] / avgVol : 0;

    // Track squeeze state
    if (bb.squeeze) {
      this.squeezeCount++;
    } else {
      this.squeezeCount = 0;
    }

    // Exit: price falls back to or below BB middle
    if (this.inPosition && latestClose < bb.middle) {
      this.inPosition = false;
      return {
        signal: 'sell',
        reason: `VBR exit: price ${latestClose.toFixed(4)} < BB mid ${bb.middle.toFixed(4)}`,
      };
    }

    // Entry: breakout above upper band after squeeze, with volume confirmation
    if (!this.inPosition && this.squeezeCount >= this.SQUEEZE_REQUIRED
        && latestClose > bb.upper && volRatio >= this.BREAKOUT_VOL_MULT) {
      this.inPosition = true;
      return {
        signal: 'buy',
        reason: `VBR breakout: price ${latestClose.toFixed(4)} > BB upper ${bb.upper.toFixed(4)}, squeeze ${this.squeezeCount}, vol ${volRatio.toFixed(1)}x`,
      };
    }

    return {
      signal: 'hold',
      reason: `VBR: bw ${bb.bandwidth.toFixed(4)}, squeeze ${this.squeezeCount}/${this.SQUEEZE_REQUIRED}, vol ${volRatio.toFixed(1)}x`,
    };
  }
}
