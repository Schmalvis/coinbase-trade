import { CoinbaseTools, type TokenSymbol } from '../mcp/tools.js';
import { botState } from '../core/state.js';
import { queries } from '../data/db.js';
import { logger } from '../core/logger.js';
import type { Signal } from '../strategy/base.js';
import type { RuntimeConfig } from '../core/runtime-config.js';

export class TradeExecutor {
  private readonly _assetCooldowns = new Map<string, Date>();

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

  async executeForAsset(symbol: string, signal: Signal, reason: string): Promise<void> {
    if (signal === 'hold') return;

    // Safety: respect pause state (C3)
    if (botState.isPaused) {
      logger.info(`[${symbol}] Trade skipped — bot is paused`);
      return;
    }

    // Safety: portfolio floor check (C3)
    const floorUsd = this.runtimeConfig.get('PORTFOLIO_FLOOR_USD') as number;
    const latestSnap = (queries.recentPortfolioSnapshots.all(1) as { portfolio_usd: number }[])[0];
    if (latestSnap && latestSnap.portfolio_usd < floorUsd) {
      logger.warn(`[${symbol}] Trade blocked — portfolio $${latestSnap.portfolio_usd.toFixed(2)} below floor $${floorUsd}`);
      return;
    }

    // Safety: position limit check for buys (C3)
    if (signal === 'buy') {
      const maxPosPct = this.runtimeConfig.get('MAX_POSITION_PCT') as number;
      const portfolioUsd = latestSnap?.portfolio_usd ?? 0;
      if (portfolioUsd > 0) {
        const assetSnap = (queries.recentAssetSnapshots.all(symbol, 1) as { price_usd: number; balance: number }[])[0];
        if (assetSnap) {
          const positionUsd = assetSnap.price_usd * assetSnap.balance;
          const positionPct = (positionUsd / portfolioUsd) * 100;
          if (positionPct >= maxPosPct) {
            logger.warn(`[${symbol}] Buy blocked — position ${positionPct.toFixed(1)}% >= limit ${maxPosPct}%`);
            return;
          }
        }
      }
    }

    const dryRun = this.runtimeConfig.get('DRY_RUN') as boolean;

    const cooldownSecs = this.runtimeConfig.get('TRADE_COOLDOWN_SECONDS') as number;
    const last = this._assetCooldowns.get(symbol);
    if (last && (Date.now() - last.getTime()) < cooldownSecs * 1000) {
      logger.debug(`Cooldown active for ${symbol}, skipping`);
      return;
    }

    // For BUY: we spend USDC, so check USDC balance
    // For SELL: we spend the token, so check token balance
    const tradeSymbol = signal === 'buy' ? 'USDC' : symbol;
    const balance = botState.assetBalances.get(tradeSymbol) ?? 0;
    if (balance <= 0) {
      logger.warn(`No ${tradeSymbol} balance for ${signal} ${symbol} trade`);
      return;
    }

    const amount = balance * 0.1;

    const [fromSymbol, toSymbol] = signal === 'buy'
      ? ['USDC', symbol]
      : [symbol, 'USDC'];

    const price = botState.lastPrice ?? 0;

    if (dryRun) {
      logger.info(`[DRY RUN] ${signal} ${symbol} amount=${amount}: ${reason}`);
      this.recordTrade({
        signal: signal as 'buy' | 'sell', amountEth: amount, price,
        triggeredBy: 'asset-strategy', status: 'dry_run', dryRun: true, reason,
      });
      return;
    }

    logger.info(`Executing ${signal} ${symbol} amount=${amount}: ${reason}`);

    let txHash: string | undefined;
    let status = 'executed';

    try {
      const result = await this.tools.swap(fromSymbol as any, toSymbol as any, amount.toString());
      txHash = result.txHash;
    } catch (err) {
      logger.error(`[${symbol}] Swap failed for ${signal}`, err);
      status = 'failed';
    }

    this._assetCooldowns.set(symbol, new Date());
    this.recordTrade({
      signal: signal as 'buy' | 'sell', amountEth: amount, price, txHash,
      triggeredBy: 'asset-strategy', status, dryRun: false, reason,
    });
    logger.info(`executeForAsset complete: ${signal} ${symbol} (${status})`);
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

  async executeRotation(
    sellSymbol: string,
    buySymbol: string,
    sellAmount: number,
    rotationId?: number,
  ): Promise<{ status: 'executed' | 'leg1_done' | 'failed'; sellTxHash?: string; buyTxHash?: string }> {
    const dryRun = this.runtimeConfig.get('DRY_RUN') as boolean;

    // Leg 1: Sell → USDC (bypass cooldown between legs)
    let sellTxHash: string | undefined;
    if (!dryRun) {
      try {
        const result = await this.tools.swap(sellSymbol as any, 'USDC' as any, sellAmount.toString());
        sellTxHash = result.txHash;
      } catch (err) {
        logger.error(`Rotation leg 1 failed (sell ${sellSymbol})`, err);
        return { status: 'failed' };
      }
    } else {
      logger.info(`[DRY RUN] Rotation leg 1: sell ${sellAmount} ${sellSymbol} → USDC`);
    }

    // Leg 2: USDC → Buy target
    let buyTxHash: string | undefined;
    if (!dryRun) {
      try {
        // Fetch fresh USDC balance after leg 1 (H1 — stale balance fix)
        let freshUsdcBalance: number;
        try {
          const usdcAddr = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base
          freshUsdcBalance = await this.tools.getErc20Balance(usdcAddr);
        } catch {
          freshUsdcBalance = botState.lastUsdcBalance ?? 0;
        }
        const amount = Math.max(freshUsdcBalance * 0.95, 0); // leave 5% buffer
        if (amount <= 0) {
          logger.warn('Rotation leg 2 skipped: no USDC balance after sell');
          botState.recordTrade(new Date());
          return { status: 'leg1_done', sellTxHash };
        }
        const result = await this.tools.swap('USDC' as any, buySymbol as any, amount.toString());
        buyTxHash = result.txHash;
      } catch (err) {
        logger.error(`Rotation leg 2 failed (buy ${buySymbol})`, err);
        botState.recordTrade(new Date());
        return { status: 'leg1_done', sellTxHash };
      }
    } else {
      logger.info(`[DRY RUN] Rotation leg 2: buy ${buySymbol} with USDC`);
    }

    botState.recordTrade(new Date()); // set cooldown after full rotation
    return { status: 'executed', sellTxHash, buyTxHash };
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
