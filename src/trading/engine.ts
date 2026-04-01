import { queries, discoveredAssetQueries, candleQueries } from '../data/db.js';
import type { DiscoveredAssetRow } from '../data/db.js';
import { botState } from '../core/state.js';
import { logger } from '../core/logger.js';
import { ThresholdStrategy } from '../strategy/threshold.js';
import { SMAStrategy } from '../strategy/sma.js';
import { GridStrategy } from '../strategy/grid.js';
import { MomentumBurstStrategy } from '../strategy/momentum-burst.js';
import { VolatilityBreakoutStrategy } from '../strategy/volatility-breakout.js';
import type { TradeExecutor } from './executor.js';
import type { RuntimeConfig } from '../core/runtime-config.js';
import type { PortfolioOptimizer } from './optimizer.js';

interface AssetStrategyParams {
  strategyType: 'threshold' | 'sma' | 'grid' | 'momentum-burst' | 'volatility-breakout';
  dropPct: number;
  risePct: number;
  smaShort: number;
  smaLong: number;
  gridLevels?: number;
  gridUpperBound?: number;
  gridLowerBound?: number;
  smaUseEma?: boolean;
  smaVolumeFilter?: boolean;
  smaRsiFilter?: boolean;
}

const STRATEGY_KEYS = [
  'STRATEGY', 'TRADE_INTERVAL_SECONDS',
  'PRICE_DROP_THRESHOLD_PCT', 'PRICE_RISE_TARGET_PCT',
  'SMA_SHORT_WINDOW', 'SMA_LONG_WINDOW',
] as const;

export class TradingEngine {
  private readonly _assetLoops = new Map<string, NodeJS.Timeout>();
  private readonly _assetStrategies = new Map<string, ThresholdStrategy | SMAStrategy | GridStrategy | MomentumBurstStrategy | VolatilityBreakoutStrategy>();
  private optimizer: PortfolioOptimizer | null = null;
  private optimizerIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly executor: TradeExecutor,
    private readonly runtimeConfig: RuntimeConfig,
  ) {
    runtimeConfig.subscribeMany([...STRATEGY_KEYS], () => {
      const activeAssets = discoveredAssetQueries.getActiveAssets.all(botState.activeNetwork) as DiscoveredAssetRow[];
      for (const row of activeAssets) {
        this.reloadAssetConfig(row.address, row.symbol, {
          strategyType: row.strategy as 'threshold' | 'sma' | 'grid',
          dropPct: row.drop_pct, risePct: row.rise_pct,
          smaShort: row.sma_short, smaLong: row.sma_long,
          gridLevels: row.grid_levels,
          gridUpperBound: row.grid_upper_bound ?? undefined,
          gridLowerBound: row.grid_lower_bound ?? undefined,
          smaUseEma: !!row.sma_use_ema,
          smaVolumeFilter: !!row.sma_volume_filter,
          smaRsiFilter: !!row.sma_rsi_filter,
        });
      }
      logger.info('All asset loops reloaded due to config change');
    });
    runtimeConfig.subscribe('OPTIMIZER_INTERVAL_SECONDS', () => {
      if (this.optimizerIntervalId) {
        this.disableOptimizer();
        this.enableOptimizer();
        logger.info('Optimizer interval restarted due to config change');
      }
    });
  }

  startAllAssetLoops(): void {
    const activeAssets = discoveredAssetQueries.getActiveAssets.all(botState.activeNetwork) as DiscoveredAssetRow[];
    // Deduplicate by symbol — first occurrence wins (registry-seeded assets are inserted first)
    const seen = new Set<string>();
    for (const row of activeAssets) {
      if (seen.has(row.symbol)) {
        logger.debug(`Skipping duplicate asset loop for ${row.symbol} (${row.address})`);
        continue;
      }
      seen.add(row.symbol);
      this.startAssetLoop(row.address, row.symbol, {
        strategyType: row.strategy as 'threshold' | 'sma' | 'grid',
        dropPct: row.drop_pct, risePct: row.rise_pct,
        smaShort: row.sma_short, smaLong: row.sma_long,
        gridLevels: row.grid_levels,
        gridUpperBound: row.grid_upper_bound ?? undefined,
        gridLowerBound: row.grid_lower_bound ?? undefined,
        smaUseEma: !!row.sma_use_ema,
        smaVolumeFilter: !!row.sma_volume_filter,
        smaRsiFilter: !!row.sma_rsi_filter,
      });
    }
    logger.info(`Started ${activeAssets.length} asset loops`);
  }

  stopAllAssetLoops(): void {
    for (const symbol of this._assetLoops.keys()) {
      this.stopAssetLoop(symbol);
    }
  }

  get activeAssetCount(): number {
    return this._assetLoops.size;
  }

  async manualTrade(action: 'buy' | 'sell', symbol?: string): Promise<void> {
    if (symbol) {
      await this.executor.executeForAsset(symbol, action, 'manual');
    } else {
      await this.executor.execute(action, 'Manual override via Telegram/CLI', 'manual');
    }
  }

  startAssetLoop(address: string, symbol: string, params: AssetStrategyParams): void {
    this.stopAssetLoop(symbol);
    const ms = (this.runtimeConfig.get('TRADE_INTERVAL_SECONDS') as number) * 1000;
    const id = setInterval(() => {
      this.tickAsset(symbol, params).catch(err => logger.error(`Asset loop error for ${symbol}`, err));
    }, ms);
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
          getCandleHigh24h: () => {
            const candles = candleQueries.getCandles.all(symbol, botState.activeNetwork, '24h', 1) as any[];
            return candles.length > 0 ? candles[0].high : null;
          },
          getCandleLow24h: () => {
            const candles = candleQueries.getCandles.all(symbol, botState.activeNetwork, '24h', 1) as any[];
            return candles.length > 0 ? candles[0].low : null;
          },
          feeEstimatePct: (this.runtimeConfig.get('DEFAULT_FEE_ESTIMATE_PCT') as number) ?? 1.0,
        });
      } else if (params.strategyType === 'sma') {
        strategy = new SMAStrategy({
          shortWindow: params.smaShort,
          longWindow: params.smaLong,
          useEma: !!params.smaUseEma,
          getVolume: params.smaVolumeFilter !== false ? () => {
            const candles = candleQueries.getCandles.all(symbol, botState.activeNetwork, '15m', 21) as any[];
            if (candles.length < 2) return null;
            const current = candles[0].volume ?? 0;
            const avg = candles.slice(0, 20).reduce((s: number, c: any) => s + (c.volume ?? 0), 0) / Math.min(candles.length, 20);
            return avg > 0 ? { current, average: avg } : null;
          } : undefined,
          getRsi: params.smaRsiFilter !== false ? () => {
            const candles = candleQueries.getCandles.all(symbol, botState.activeNetwork, '15m', 15) as any[];
            if (candles.length < 14) return null;
            const closes = candles.map((c: any) => c.close).reverse();
            let gains = 0, losses = 0;
            for (let i = 1; i < closes.length; i++) {
              const diff = closes[i] - closes[i - 1];
              if (diff > 0) gains += diff; else losses -= diff;
            }
            const period = closes.length - 1;
            const avgGain = gains / period;
            const avgLoss = losses / period;
            if (avgLoss === 0) return 100;
            const rs = avgGain / avgLoss;
            return 100 - (100 / (1 + rs));
          } : undefined,
        });
      } else if (params.strategyType === 'momentum-burst') {
        strategy = new MomentumBurstStrategy(
          (limit) => candleQueries.getCandles.all(symbol, botState.activeNetwork, '15m', limit) as any[],
          (limit) => candleQueries.getCandles.all(symbol, botState.activeNetwork, '1h', limit) as any[],
        );
      } else if (params.strategyType === 'volatility-breakout') {
        strategy = new VolatilityBreakoutStrategy(
          (limit) => candleQueries.getCandles.all(symbol, botState.activeNetwork, '1h', limit) as any[],
        );
      } else {
        strategy = new ThresholdStrategy({ dropPct: params.dropPct, risePct: params.risePct });
      }
      this._assetStrategies.set(symbol, strategy);
    }

    const result = strategy.evaluate(snapshots);

    logger.debug(`[${symbol}] Strategy signal: ${result.signal} — ${result.reason}`);
    await this.executor.executeForAsset(symbol, result.signal, result.reason, result.priority);
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
