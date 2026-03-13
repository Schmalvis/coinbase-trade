import { CoinbaseTools, type TokenSymbol } from '../mcp/tools.js';
import { botState } from '../core/state.js';
import { queries } from '../data/db.js';
import { logger } from '../core/logger.js';
import type { Signal } from '../strategy/base.js';
import type { RuntimeConfig } from '../core/runtime-config.js';

export class TradeExecutor {
  constructor(
    private readonly tools: CoinbaseTools,
    private readonly runtimeConfig: RuntimeConfig,
  ) {
    runtimeConfig.subscribeMany(
      ['DRY_RUN', 'MAX_TRADE_SIZE_ETH', 'MAX_TRADE_SIZE_USDC', 'TRADE_COOLDOWN_SECONDS'],
      () => { /* values are read live via get() — no state to update */ },
    );
  }

  async execute(signal: Signal, reason: string, triggeredBy = 'strategy'): Promise<boolean> {
    if (signal === 'hold') return false;
    if (botState.isPaused) {
      logger.info('Trade skipped — bot is paused');
      return false;
    }

    const cooldown = this.runtimeConfig.get('TRADE_COOLDOWN_SECONDS') as number;
    const lastTrade = botState.lastTradeAt;
    if (lastTrade) {
      const elapsed = (Date.now() - lastTrade.getTime()) / 1000;
      if (elapsed < cooldown) {
        logger.info(`Trade skipped — cooldown (${Math.round(cooldown - elapsed)}s remaining)`);
        return false;
      }
    }

    const dryRun = this.runtimeConfig.get('DRY_RUN') as boolean;
    const ethBalance = botState.lastBalance ?? 0;
    const usdcBalance = botState.lastUsdcBalance ?? 0;
    const price = botState.lastPrice ?? 0;

    const isBuy = signal === 'buy';
    const fromSymbol: TokenSymbol = isBuy ? 'USDC' : 'ETH';
    const toSymbol: TokenSymbol   = isBuy ? 'ETH'  : 'USDC';
    const available = isBuy ? usdcBalance : ethBalance;
    const maxSize   = isBuy
      ? this.runtimeConfig.get('MAX_TRADE_SIZE_USDC') as number
      : this.runtimeConfig.get('MAX_TRADE_SIZE_ETH') as number;
    const amount = Math.min(maxSize, available * 0.1);

    if (amount <= 0) {
      logger.warn(`Trade skipped — insufficient ${fromSymbol} balance (${available.toFixed(isBuy ? 2 : 6)})`);
      return false;
    }

    logger.info(`${dryRun ? '[DRY RUN] ' : ''}Executing ${signal.toUpperCase()} ${amount} ${fromSymbol} → ${toSymbol} — ${reason}`);

    let txHash: string | undefined;
    let status = 'executed';

    if (!dryRun) {
      try {
        const result = await this.tools.swap(fromSymbol, toSymbol, amount.toString());
        txHash = result.txHash;
      } catch (err) {
        logger.error('Swap failed', err);
        status = 'failed';
      }
    }

    const amountEth = isBuy ? amount / (price || 1) : amount;
    this.recordTrade({ signal: signal as 'buy' | 'sell', amountEth, price, txHash, triggeredBy, status, dryRun, reason });
    return true;
  }

  async executeEnso(
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
  ): Promise<{ txHash?: string; dryRun: boolean }> {
    const cooldown = this.runtimeConfig.get('TRADE_COOLDOWN_SECONDS') as number;
    const lastTrade = botState.lastTradeAt;
    if (lastTrade) {
      const elapsed = (Date.now() - lastTrade.getTime()) / 1000;
      if (elapsed < cooldown) {
        const remaining = Math.ceil(cooldown - elapsed);
        throw new Error(`Cooldown active, ${remaining} seconds remaining`);
      }
    }

    const dryRun = this.runtimeConfig.get('DRY_RUN') as boolean;
    const price = botState.lastPrice ?? 0;

    let txHash: string | undefined;

    if (!dryRun) {
      const result = await this.tools.ensoRoute(tokenIn, tokenOut, amountIn);
      txHash = result.txHash;
    }

    this.recordTrade({
      signal: 'sell', // token→token is directionally a sell for accounting
      amountEth: parseFloat(amountIn),
      price,
      txHash,
      triggeredBy: 'manual-enso',
      status: 'executed',
      dryRun,
      reason: `enso ${tokenIn.slice(0, 10)}→${tokenOut.slice(0, 10)}`,
    });
    return { txHash, dryRun };
  }

  async executeManual(
    from: TokenSymbol,
    to: TokenSymbol,
    fromAmount: string,
  ): Promise<{ txHash?: string; dryRun: boolean }> {
    const cooldown = this.runtimeConfig.get('TRADE_COOLDOWN_SECONDS') as number;
    const lastTrade = botState.lastTradeAt;
    if (lastTrade) {
      const elapsed = (Date.now() - lastTrade.getTime()) / 1000;
      if (elapsed < cooldown) {
        const remaining = Math.ceil(cooldown - elapsed);
        throw new Error(`Cooldown active, ${remaining} seconds remaining`);
      }
    }

    const dryRun = this.runtimeConfig.get('DRY_RUN') as boolean;
    const price = botState.lastPrice ?? 0;
    const signal: Signal = from === 'ETH' ? 'sell' : 'buy'; // ETH→USDC = sell ETH
    const amountEth = from === 'ETH' ? parseFloat(fromAmount) : parseFloat(fromAmount) / (price || 1);

    let txHash: string | undefined;

    if (!dryRun) {
      const result = await this.tools.swap(from, to, fromAmount);
      txHash = result.txHash;
    }

    this.recordTrade({ signal, amountEth, price, txHash, triggeredBy: 'manual', status: 'executed', dryRun, reason: 'manual' });
    return { txHash, dryRun };
  }

  private recordTrade(t: {
    signal: 'buy' | 'sell'; amountEth: number; price: number; txHash?: string;
    triggeredBy: string; status: string; dryRun: boolean; reason: string;
  }): void {
    queries.insertTrade.run({
      action:       t.signal,
      amount_eth:   t.amountEth,
      price_usd:    t.price,
      tx_hash:      t.txHash ?? null,
      triggered_by: t.triggeredBy,
      status:       t.status,
      dry_run:      t.dryRun ? 1 : 0,
      reason:       t.reason,
      network:      botState.activeNetwork,
    });

    const now = new Date();
    botState.recordTrade(now);
    botState.emitTrade({
      action:    t.signal,
      amountEth: t.amountEth,
      priceUsd:  t.price,
      txHash:    t.txHash,
      dryRun:    t.dryRun,
      reason:    t.reason,
      timestamp: now,
    });
  }
}
