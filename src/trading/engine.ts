import { queries, discoveredAssetQueries } from '../data/db.js';
import type { DiscoveredAssetRow } from '../data/db.js';
import { botState } from '../core/state.js';
import { logger } from '../core/logger.js';
import { ThresholdStrategy } from '../strategy/threshold.js';
import { SMAStrategy } from '../strategy/sma.js';
import { GridStrategy } from '../strategy/grid.js';
import type { Strategy } from '../strategy/base.js';
import type { TradeExecutor } from './executor.js';
import type { RuntimeConfig } from '../core/runtime-config.js';
import type { PortfolioOptimizer } from './optimizer.js';

interface AssetStrategyParams {
  strategyType: 'threshold' | 'sma' | 'grid';
  dropPct: number;
  risePct: number;
  smaShort: number;
  smaLong: number;
  gridLevels?: number;
  gridUpperBound?: number;
  gridLowerBound?: number;
}

const STRATEGY_KEYS = [
  'STRATEGY', 'TRADE_INTERVAL_SECONDS',
  'PRICE_DROP_THRESHOLD_PCT', 'PRICE_RISE_TARGET_PCT',
  'SMA_SHORT_WINDOW', 'SMA_LONG_WINDOW',
] as const;

export class TradingEngine {
  private strategy!: Strategy;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly _assetLoops = new Map<string, NodeJS.Timeout>();
  private readonly _assetStrategies = new Map<string, ThresholdStrategy | SMAStrategy | GridStrategy>();
  private optimizer: PortfolioOptimizer | null = null;
  private optimizerIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly executor: TradeExecutor,
    private readonly runtimeConfig: RuntimeConfig,
  ) {
    this.strategy = this.buildStrategy();
    runtimeConfig.subscribeMany([...STRATEGY_KEYS], () => this.restart());
    runtimeConfig.subscribe('OPTIMIZER_INTERVAL_SECONDS', () => {
      if (this.optimizerIntervalId) {
        this.disableOptimizer();
        this.enableOptimizer();
        logger.info('Optimizer interval restarted due to config change');
      }
    });
    logger.info(`Trading engine using strategy: ${this.strategy.name}`);

    const activeAssets = discoveredAssetQueries.getActiveAssets.all(botState.activeNetwork) as DiscoveredAssetRow[];
    for (const row of activeAssets) {
      this.startAssetLoop(row.address, row.symbol, {
        strategyType: row.strategy as 'threshold' | 'sma' | 'grid',
        dropPct: row.drop_pct,
        risePct: row.rise_pct,
        smaShort: row.sma_short,
        smaLong: row.sma_long,
        gridLevels: (row as any).grid_levels,
        gridUpperBound: (row as any).grid_upper_bound ?? undefined,
        gridLowerBound: (row as any).grid_lower_bound ?? undefined,
      });
    }
  }

  private buildStrategy(): Strategy {
    const s = this.runtimeConfig.get('STRATEGY') as string;
    return s === 'sma' ? new SMAStrategy() : new ThresholdStrategy();
  }

  start(): void {
    this.strategy = this.buildStrategy();
    const intervalMs = (this.runtimeConfig.get('TRADE_INTERVAL_SECONDS') as number) * 1000;
    this.intervalId = setInterval(() => this.tick(), intervalMs);
    logger.info(`Trading engine started (interval: ${intervalMs}ms, strategy: ${this.strategy.name})`);
  }

  private restart(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.start();
    logger.info('Trading engine restarted due to config change');
  }

  async tick(): Promise<void> {
    if (botState.isPaused) return;

    const longWindow = this.runtimeConfig.get('SMA_LONG_WINDOW') as number;
    const snapshots = queries.recentSnapshots.all(longWindow + 5) as {
      eth_price: number;
      eth_balance: number;
      portfolio_usd: number;
      timestamp: string;
    }[];

    if (snapshots.length === 0) return;

    const result = this.strategy.evaluate(snapshots);
    logger.debug(`Strategy signal: ${result.signal} — ${result.reason}`);

    if (result.signal !== 'hold') {
      await this.executor.execute(result.signal, result.reason);
    }
  }

  async manualTrade(action: 'buy' | 'sell'): Promise<void> {
    await this.executor.execute(action, 'Manual override via Telegram/CLI', 'manual');
  }

  startAssetLoop(address: string, symbol: string, params: AssetStrategyParams): void {
    this.stopAssetLoop(symbol);
    const ms = (this.runtimeConfig.get('TRADE_INTERVAL_SECONDS') as number) * 1000;
    const id = setInterval(() => void this.tickAsset(symbol, params), ms);
    this._assetLoops.set(symbol, id);
    logger.info(`Asset loop started: ${symbol} every ${ms}ms`);
  }

  stopAssetLoop(symbol: string): void {
    const id = this._assetLoops.get(symbol);
    if (id !== undefined) {
      clearInterval(id);
      this._assetLoops.delete(symbol);
      logger.info(`Asset loop stopped: ${symbol}`);
    }
    this._assetStrategies.delete(symbol);
  }

  reloadAssetConfig(address: string, symbol: string, params: AssetStrategyParams): void {
    this.stopAssetLoop(symbol);
    this.startAssetLoop(address, symbol, params);
  }

  private async tickAsset(symbol: string, params: AssetStrategyParams): Promise<void> {
    if (botState.isPaused) return;

    const limit = params.strategyType === 'grid' ? 5 : params.smaLong + 5;
    const raw = queries.recentAssetSnapshots.all(symbol, limit) as {
      price_usd: number; balance: number; timestamp: string;
    }[];
    if (raw.length === 0) return;

    const snapshots = raw.map(r => ({
      eth_price:     r.price_usd,
      eth_balance:   0,
      portfolio_usd: 0,
      timestamp:     r.timestamp,
    }));

    // Strategy instance is bound to the params at first tick for this symbol.
    // To apply new params, call stopAssetLoop(symbol) first (reloadAssetConfig does this).
    // Get or create strategy instance for this symbol (preserves state across ticks)
    let strategy = this._assetStrategies.get(symbol);
    if (!strategy) {
      if (params.strategyType === 'grid') {
        strategy = new GridStrategy({
          symbol,
          network: botState.activeNetwork,
          gridLevels: params.gridLevels,
          upperBound: params.gridUpperBound,
          lowerBound: params.gridLowerBound,
          getCandleHigh24h: () => null,
          getCandleLow24h: () => null,
          feeEstimatePct: (this.runtimeConfig.get('DEFAULT_FEE_ESTIMATE_PCT') as number) ?? 1.0,
        });
      } else if (params.strategyType === 'sma') {
        strategy = new SMAStrategy({ shortWindow: params.smaShort, longWindow: params.smaLong });
      } else {
        strategy = new ThresholdStrategy({ dropPct: params.dropPct, risePct: params.risePct });
      }
      this._assetStrategies.set(symbol, strategy);
    }

    const result = strategy.evaluate(snapshots);

    logger.debug(`[${symbol}] Strategy signal: ${result.signal} — ${result.reason}`);
    await this.executor.executeForAsset(symbol, result.signal, 'auto');
  }

  setOptimizer(optimizer: PortfolioOptimizer): void {
    this.optimizer = optimizer;
  }

  enableOptimizer(): void {
    if (!this.optimizer) {
      logger.warn('Cannot enable optimizer — not set');
      return;
    }
    if (this.optimizerIntervalId) return; // already running
    const intervalMs = (this.runtimeConfig.get('OPTIMIZER_INTERVAL_SECONDS') as number) * 1000;
    this.optimizerIntervalId = setInterval(() => {
      this.optimizer!.tick(botState.activeNetwork).catch((err) =>
        logger.error('Optimizer tick failed', err),
      );
    }, intervalMs);
    logger.info(`Portfolio optimizer enabled (interval: ${intervalMs / 1000}s)`);
  }

  disableOptimizer(): void {
    if (this.optimizerIntervalId) {
      clearInterval(this.optimizerIntervalId);
      this.optimizerIntervalId = null;
      logger.info('Portfolio optimizer disabled');
    }
  }

  get optimizerEnabled(): boolean {
    return this.optimizerIntervalId !== null;
  }
}
