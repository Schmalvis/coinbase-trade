/**
 * Minimum candle counts required for strategies with significant warm-up periods.
 * Import from here rather than from the strategy file itself to avoid route
 * handlers depending on strategy internals.
 */

/** TrendContinuationStrategy requires 50 × 1h candles for stable EMA-50. */
export const TCP_MIN_1H_CANDLES = 50;
