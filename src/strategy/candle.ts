/**
 * CandleStrategy — technical-analysis strategy using RSI, MACD, volume, and
 * candle-body heuristics to produce buy / sell / hold signals with a strength
 * score (0-100).
 */

// TODO: once src/services/candles.ts lands, switch to:
//   import type { Candle } from '../services/candles.js';
export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleSignal {
  signal: 'buy' | 'sell' | 'hold';
  strength: number; // 0-100
  reason: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Exponential moving average — returns one EMA value per input value. */
export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  RSI (Wilder's smoothing)                                           */
/* ------------------------------------------------------------------ */

export function computeRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;

  // Initial simple averages over the first `period` changes
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) gainSum += delta;
    else lossSum += -delta;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  // Wilder smoothing for the remaining data points
  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/* ------------------------------------------------------------------ */
/*  MACD                                                               */
/* ------------------------------------------------------------------ */

export function computeMACD(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): { macd: number; signal: number; histogram: number } {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);

  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = ema(macdLine, signalPeriod);

  const last = macdLine.length - 1;
  const macd = macdLine[last];
  const signal = signalLine[last];
  return { macd, signal, histogram: macd - signal };
}

/* ------------------------------------------------------------------ */
/*  Bollinger Bands                                                    */
/* ------------------------------------------------------------------ */

export interface BollingerResult {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;
  squeeze: boolean;
}

export function computeBollingerBands(
  closes: number[],
  period = 20,
  stdDevMultiplier = 2.0,
): BollingerResult | null {
  if (closes.length < period) return null;

  const window = closes.slice(-period);
  const sma = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((sum, v) => sum + (v - sma) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = sma + stdDevMultiplier * stdDev;
  const lower = sma - stdDevMultiplier * stdDev;
  const bandwidth = sma > 0 ? (upper - lower) / sma : 0;

  let squeeze = false;
  if (closes.length >= period * 2) {
    let bwSum = 0;
    let bwCount = 0;
    for (let end = closes.length - period; end <= closes.length; end++) {
      const w = closes.slice(end - period, end);
      const m = w.reduce((a, b) => a + b, 0) / period;
      if (m <= 0) continue;
      const v = w.reduce((s, x) => s + (x - m) ** 2, 0) / period;
      bwSum += (2 * stdDevMultiplier * Math.sqrt(v)) / m;
      bwCount++;
    }
    const avgBw = bwCount > 0 ? bwSum / bwCount : 0;
    squeeze = avgBw > 0 && bandwidth < avgBw * 0.5;
  }

  return { upper, middle: sma, lower, bandwidth, squeeze };
}

/* ------------------------------------------------------------------ */
/*  CandleStrategy                                                     */
/* ------------------------------------------------------------------ */

export class CandleStrategy {
  evaluate(candles: Candle[]): CandleSignal {
    if (candles.length < 26) {
      return { signal: 'hold', strength: 0, reason: 'Need at least 26 candles' };
    }

    const closes = candles.map((c) => c.close);

    // --- Indicators ---
    const rsi = computeRSI(closes);
    const { histogram } = computeMACD(closes);

    // Volume ratio: latest vs 20-period average
    const volumes = candles.map((c) => c.volume);
    const volWindow = volumes.slice(-20);
    const avgVol = volWindow.reduce((a, b) => a + b, 0) / volWindow.length;
    const volRatio = avgVol > 0 ? volumes[volumes.length - 1] / avgVol : 1;

    // Candle body analysis (latest candle)
    const last = candles[candles.length - 1];
    const range = last.high - last.low;

    let lowerWickRatio = 0;
    let upperWickRatio = 0;
    if (range > 0) {
      const bodyLow = Math.min(last.open, last.close);
      const bodyHigh = Math.max(last.open, last.close);
      lowerWickRatio = (bodyLow - last.low) / range;
      upperWickRatio = (last.high - bodyHigh) / range;
    }

    // --- Scoring ---
    let buyScore = 0;
    let sellScore = 0;
    const reasons: string[] = [];

    // RSI
    if (rsi < 30) {
      buyScore += 40;
      reasons.push(`RSI ${rsi.toFixed(1)} (oversold)`);
    } else if (rsi < 40) {
      buyScore += 15;
      reasons.push(`RSI ${rsi.toFixed(1)} (low)`);
    } else if (rsi > 70) {
      sellScore += 40;
      reasons.push(`RSI ${rsi.toFixed(1)} (overbought)`);
    } else if (rsi > 60) {
      sellScore += 15;
      reasons.push(`RSI ${rsi.toFixed(1)} (high)`);
    } else {
      reasons.push(`RSI ${rsi.toFixed(1)}`);
    }

    // MACD histogram
    if (histogram > 0) {
      buyScore += 25;
      reasons.push('MACD histogram positive');
    } else {
      sellScore += 25;
      reasons.push('MACD histogram negative');
    }

    // Candle wicks
    if (lowerWickRatio > 0.5) {
      buyScore += 15;
      reasons.push('Long lower wick');
    }
    if (upperWickRatio > 0.5) {
      sellScore += 15;
      reasons.push('Long upper wick');
    }

    // Volume bonus
    const volBonus = volRatio > 1.5 ? 10 : 0;
    if (volBonus) reasons.push(`High volume (${volRatio.toFixed(1)}x avg)`);

    // Bollinger Bands
    const bb = computeBollingerBands(closes);
    if (bb) {
      const lastClose = closes[closes.length - 1];
      const squeezeMult = bb.squeeze ? 1.5 : 1.0;
      if (lastClose < bb.lower) {
        const distance = (bb.lower - lastClose) / (bb.upper - bb.lower || 1);
        const pts = Math.round((15 + Math.min(distance, 1) * 10) * squeezeMult);
        buyScore += pts;
        reasons.push(`BB below lower (${pts}pts${bb.squeeze ? ', squeeze' : ''})`);
      } else if (lastClose > bb.upper) {
        const distance = (lastClose - bb.upper) / (bb.upper - bb.lower || 1);
        const pts = Math.round((15 + Math.min(distance, 1) * 10) * squeezeMult);
        sellScore += pts;
        reasons.push(`BB above upper (${pts}pts${bb.squeeze ? ', squeeze' : ''})`);
      }
    }

    // --- Decision ---
    const net = buyScore - sellScore;

    if (net > 20) {
      return {
        signal: 'buy',
        strength: Math.min(100, net + volBonus),
        reason: reasons.join('; '),
      };
    }
    if (net < -20) {
      return {
        signal: 'sell',
        strength: Math.min(100, -net + volBonus),
        reason: reasons.join('; '),
      };
    }
    return {
      signal: 'hold',
      strength: Math.abs(net),
      reason: reasons.join('; '),
    };
  }
}
