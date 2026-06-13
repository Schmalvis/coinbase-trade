import type { CandleSignal } from '../strategy/candle.js';

export interface BacktestConfig {
  network: string;
  fromDate: string;           // 'YYYY-MM-DD'
  toDate: string;             // 'YYYY-MM-DD'
  dbPath: string;             // absolute path to trades.db
  symbols: string[];          // all assets to score, USDC must be included
  feePct: number;             // 0.01 = 1%
  rotationSizePct: number;    // fraction of held asset to sell, e.g. 0.25
  sellThreshold: number;      // score below which held asset is sell candidate, e.g. -20
  buyThreshold: number;       // score above which asset is buy candidate, e.g. 30
  minScoreDelta: number;      // min(buy.score - sell.score) to execute, e.g. 40
  maxDailyRotations: number;  // daily veto cap
  pairCooldownMs: number;     // same-pair cooldown, default 4h = 14_400_000
  // Populated by runner from asset_snapshots; may be pre-set for tests
  initialBalances: Map<string, number>;  // symbol → native units
  initialPrices: Map<string, number>;    // symbol → USD
}

export interface ScoredAsset {
  symbol: string;
  score: number;          // -100 to +100
  confidence: number;     // 0-1
  isHeld: boolean;        // USD value >= $2
  currentWeight: number;  // % of portfolio at this tick
  signals: {
    candle15m: CandleSignal;
    candle1h: CandleSignal;
    candle24h: CandleSignal;
  };
}

export interface SimulatedRotation {
  tick: string;             // ISO timestamp of triggering 15m candle
  sellSymbol: string;
  buySymbol: string;
  scoreDelta: number;
  sellScore: number;
  buyScore: number;
  sellAmountUsd: number;
  buyAmountUsd: number;   // after fee
  feePaidUsd: number;
  portfolioUsdBefore: number;
  portfolioUsdAfter: number;
}

export interface VetoRecord {
  tick: string;
  sellSymbol: string;
  buySymbol: string;
  scoreDelta: number;
  reason: string;
}

export interface BacktestResult {
  config: BacktestConfig;
  ticks: number;
  firstTick: string;
  lastTick: string;
  startPortfolioUsd: number;
  endPortfolioUsd: number;
  pnlUsd: number;
  pnlPct: number;
  hodlPortfolioUsd: number;  // PRIMARY benchmark: initial composition held at end prices
  hodlEthUsd: number;        // reference: all starting USD converted to ETH at start price
  hodlUsdcUsd: number;       // always = startPortfolioUsd
  rotations: SimulatedRotation[];
  vetoed: number;
  // NOTE: per-rotation win rate is omitted — portfolioUsdAfter is always < portfolioUsdBefore
  // by the fee amount at execution time. Forward-looking win rate requires marking positions
  // to market N candles later, which is not implemented.
  avgFeePct: number;
}
