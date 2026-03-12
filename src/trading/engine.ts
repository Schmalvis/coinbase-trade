import { queries } from '../data/db.js';
import { botState } from '../core/state.js';
import { logger } from '../core/logger.js';
import { config } from '../config.js';
import { ThresholdStrategy } from '../strategy/threshold.js';
import { SMAStrategy } from '../strategy/sma.js';
import type { Strategy } from '../strategy/base.js';
import type { TradeExecutor } from './executor.js';

export class TradingEngine {
  private strategy: Strategy;

  constructor(private executor: TradeExecutor) {
    this.strategy = config.STRATEGY === 'sma' ? new SMAStrategy() : new ThresholdStrategy();
    logger.info(`Trading engine using strategy: ${this.strategy.name}`);
  }

  start(): void {
    logger.info('Trading engine started');
    setInterval(() => this.tick(), config.TRADE_INTERVAL_SECONDS * 1000);
  }

  async tick(): Promise<void> {
    if (botState.isPaused) return;

    const snapshots = queries.recentSnapshots.all(config.SMA_LONG_WINDOW + 5) as {
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
