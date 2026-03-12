import { queries } from '../data/db.js';
import { botState } from '../core/state.js';
import { logger } from '../core/logger.js';
import { ThresholdStrategy } from '../strategy/threshold.js';
import { SMAStrategy } from '../strategy/sma.js';
import type { Strategy } from '../strategy/base.js';
import type { TradeExecutor } from './executor.js';
import type { RuntimeConfig } from '../core/runtime-config.js';

const STRATEGY_KEYS = [
  'STRATEGY', 'TRADE_INTERVAL_SECONDS',
  'PRICE_DROP_THRESHOLD_PCT', 'PRICE_RISE_TARGET_PCT',
  'SMA_SHORT_WINDOW', 'SMA_LONG_WINDOW',
] as const;

export class TradingEngine {
  private strategy!: Strategy;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly executor: TradeExecutor,
    private readonly runtimeConfig: RuntimeConfig,
  ) {
    this.strategy = this.buildStrategy();
    runtimeConfig.subscribeMany([...STRATEGY_KEYS], () => this.restart());
    logger.info(`Trading engine using strategy: ${this.strategy.name}`);
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
}
