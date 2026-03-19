import { gridStateQueries, type GridStateRow } from '../data/db.js';
import type { Strategy, Snapshot, StrategyResult } from './base.js';

export interface GridStrategyOpts {
  symbol: string;
  network: string;
  gridLevels?: number;
  amountPct?: number;
  upperBound?: number;
  lowerBound?: number;
  recalcHours?: number;
  getCandleHigh24h: () => number | null;
  getCandleLow24h: () => number | null;
  feeEstimatePct: number;
}

export class GridStrategy implements Strategy {
  readonly name = 'grid';

  private readonly symbol: string;
  private readonly network: string;
  private readonly gridLevelCount: number;
  private readonly recalcHours: number;
  private readonly getCandleHigh24h: () => number | null;
  private readonly getCandleLow24h: () => number | null;
  private readonly feeEstimatePct: number;

  private upperBound: number | undefined;
  private lowerBound: number | undefined;
  private manualBounds: boolean;
  private lastRecalc = 0;
  private initialized = false;

  constructor(opts: GridStrategyOpts) {
    this.symbol = opts.symbol;
    this.network = opts.network;
    this.gridLevelCount = opts.gridLevels ?? 10;
    this.recalcHours = opts.recalcHours ?? 6;
    this.getCandleHigh24h = opts.getCandleHigh24h;
    this.getCandleLow24h = opts.getCandleLow24h;
    this.feeEstimatePct = opts.feeEstimatePct;

    if (opts.upperBound != null && opts.lowerBound != null) {
      this.upperBound = opts.upperBound;
      this.lowerBound = opts.lowerBound;
      this.manualBounds = true;
    } else {
      this.manualBounds = false;
    }
  }

  evaluate(snapshots: Snapshot[]): StrategyResult {
    if (snapshots.length === 0) return { signal: 'hold', reason: 'No snapshots' };

    const currentPrice = snapshots[snapshots.length - 1].eth_price;
    const prevPrice = snapshots.length > 1
      ? snapshots[snapshots.length - 2].eth_price
      : currentPrice;

    if (!this.manualBounds) {
      const now = Date.now();
      if (!this.initialized || now - this.lastRecalc > this.recalcHours * 3_600_000) {
        this.recalculateBounds(currentPrice);
      }
    }

    if (!this.initialized) {
      if (this.upperBound == null || this.lowerBound == null) {
        return { signal: 'hold', reason: 'Grid bounds not available' };
      }
      this.initializeLevels(currentPrice);
      this.initialized = true;
      return { signal: 'hold', reason: 'Grid initialized' };
    }

    const levels = gridStateQueries.getGridLevels.all(
      this.symbol, this.network,
    ) as GridStateRow[];

    for (const level of levels) {
      if (level.state === 'pending_buy'
        && currentPrice <= level.level_price
        && prevPrice > level.level_price) {
        gridStateQueries.upsertGridLevel.run({
          symbol: this.symbol, network: this.network,
          level_price: level.level_price, state: 'pending_sell',
        });
        return {
          signal: 'buy',
          reason: `Grid buy at ${level.level_price.toFixed(2)}`,
        };
      }

      if (level.state === 'pending_sell'
        && currentPrice >= level.level_price
        && prevPrice < level.level_price) {
        gridStateQueries.upsertGridLevel.run({
          symbol: this.symbol, network: this.network,
          level_price: level.level_price, state: 'pending_buy',
        });
        return {
          signal: 'sell',
          reason: `Grid sell at ${level.level_price.toFixed(2)}`,
        };
      }
    }

    return { signal: 'hold', reason: 'No grid level crossed' };
  }

  private recalculateBounds(currentPrice: number): void {
    const high = this.getCandleHigh24h();
    const low = this.getCandleLow24h();
    if (high != null && low != null && high > low) {
      this.upperBound = high * 1.02;
      this.lowerBound = low * 0.98;
    } else {
      this.upperBound = currentPrice * 1.05;
      this.lowerBound = currentPrice * 0.95;
    }
    this.lastRecalc = Date.now();
  }

  private initializeLevels(currentPrice: number): void {
    gridStateQueries.clearGridLevels.run(this.symbol, this.network);

    const upper = this.upperBound!;
    const lower = this.lowerBound!;
    const step = (upper - lower) / (this.gridLevelCount + 1);
    const minStep = currentPrice * (this.feeEstimatePct / 100) * 2;
    const effectiveStep = Math.max(step, minStep);
    const count = Math.min(
      this.gridLevelCount,
      Math.floor((upper - lower) / effectiveStep),
    );

    for (let i = 1; i <= count; i++) {
      const price = lower + i * effectiveStep;
      gridStateQueries.upsertGridLevel.run({
        symbol: this.symbol, network: this.network,
        level_price: Math.round(price * 100) / 100,
        state: price < currentPrice ? 'pending_buy' : 'pending_sell',
      });
    }
  }
}
