import { CoinbaseTools } from '../mcp/tools.js';
import { botState } from '../core/state.js';
import { queries } from '../data/db.js';
import { logger } from '../core/logger.js';
import { config } from '../config.js';
import type { Signal } from '../strategy/base.js';

export class TradeExecutor {
  constructor(private tools: CoinbaseTools) {}

  async execute(signal: Signal, reason: string, triggeredBy = 'strategy'): Promise<boolean> {
    if (signal === 'hold') return false;
    if (botState.isPaused) {
      logger.info('Trade skipped — bot is paused');
      return false;
    }

    // Cooldown check
    const lastTrade = botState.lastTradeAt;
    if (lastTrade) {
      const elapsed = (Date.now() - lastTrade.getTime()) / 1000;
      if (elapsed < config.TRADE_COOLDOWN_SECONDS) {
        logger.info(`Trade skipped — cooldown (${Math.round(config.TRADE_COOLDOWN_SECONDS - elapsed)}s remaining)`);
        return false;
      }
    }

    const ethBalance = botState.lastBalance ?? 0;
    const usdcBalance = botState.lastUsdcBalance ?? 0;
    const price = botState.lastPrice ?? 0;

    // Buy: spend USDC to get ETH. Sell: spend ETH to get USDC.
    const isBuy = signal === 'buy';
    const fromSymbol = isBuy ? 'USDC' : 'ETH';
    const toSymbol   = isBuy ? 'ETH'  : 'USDC';
    const available  = isBuy ? usdcBalance : ethBalance;
    const maxSize    = isBuy ? config.MAX_TRADE_SIZE_USDC : config.MAX_TRADE_SIZE_ETH;
    const amount     = Math.min(maxSize, available * 0.1);

    if (amount <= 0) {
      logger.warn(`Trade skipped — insufficient ${fromSymbol} balance (${available.toFixed(isBuy ? 2 : 6)})`);
      return false;
    }

    logger.info(`${config.DRY_RUN ? '[DRY RUN] ' : ''}Executing ${signal.toUpperCase()} ${amount} ${fromSymbol} → ${toSymbol} — ${reason}`);

    let txHash: string | undefined;
    let status = 'executed';

    if (!config.DRY_RUN) {
      try {
        const result = await this.tools.swap(fromSymbol, toSymbol, amount.toString());
        txHash = result.txHash;
      } catch (err) {
        logger.error('Swap failed', err);
        status = 'failed';
      }
    }

    queries.insertTrade.run({
      action: signal,
      amount_eth: isBuy ? amount / (price || 1) : amount,
      price_usd: price,
      tx_hash: txHash ?? null,
      triggered_by: triggeredBy,
      status,
      dry_run: config.DRY_RUN ? 1 : 0,
      reason,
    });

    const now = new Date();
    botState.recordTrade(now);
    botState.emitTrade({
      action: signal,
      amountEth: isBuy ? amount / (price || 1) : amount,
      priceUsd: price,
      txHash,
      dryRun: config.DRY_RUN,
      reason,
      timestamp: now,
    });

    return true;
  }
}
