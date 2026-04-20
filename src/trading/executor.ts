import { CoinbaseTools, type TokenSymbol } from '../wallet/tools.js';
import { botState } from '../core/state.js';
import { queries } from '../data/db.js';
import { logger } from '../core/logger.js';
import type { Signal } from '../strategy/base.js';
import type { RuntimeConfig } from '../core/runtime-config.js';

export class TradeExecutor {
  private readonly _assetCooldowns = new Map<string, Date>();
  // Tracks entry price and quantity for open positions (for realized P&L calculation)
  private readonly _openPositions = new Map<string, { entryPrice: number; qty: number }>();

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

    // Sanity check: reject trades exceeding 2x portfolio value (likely a parsing error)
    const portfolioUsd = (botState.lastBalance ?? 0) * (botState.lastPrice ?? 0) + (botState.lastUsdcBalance ?? 0);
    const tradeValueUsd = amount * (price || 0);
    if (portfolioUsd > 0 && tradeValueUsd > portfolioUsd * 2) {
      logger.error(`Trade sanity check BLOCKED: ${signal} value $${tradeValueUsd.toFixed(2)} > 2x portfolio $${portfolioUsd.toFixed(2)}`);
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
    this.recordTrade({ signal: signal as 'buy' | 'sell', amountEth, price, txHash, triggeredBy, status, dryRun, reason, symbol: isBuy ? toSymbol : fromSymbol });
    return true;
  }

  async executeForAsset(symbol: string, signal: Signal, reason: string, priority?: 'stop-loss' | 'normal'): Promise<void> {
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
    if (priority !== 'stop-loss' && last && (Date.now() - last.getTime()) < cooldownSecs * 1000) {
      logger.debug(`Cooldown active for ${symbol}, skipping`);
      return;
    }
    // Claim cooldown upfront to prevent concurrent calls bypassing the check
    this._assetCooldowns.set(symbol, new Date());

    // For BUY: we spend USDC, so check USDC balance
    // For SELL: we spend the token, so check token balance
    const tradeSymbol = signal === 'buy' ? 'USDC' : symbol;
    const balance = botState.assetBalances.get(tradeSymbol) ?? 0;
    if (balance <= 0) {
      logger.warn(`No ${tradeSymbol} balance for ${signal} ${symbol} trade`);
      return;
    }

    const MIN_TRADE_VALUE_USD = 2;
    let amount = balance * 0.1;

    const [fromSymbol, toSymbol] = signal === 'buy'
      ? ['USDC', symbol]
      : [symbol, 'USDC'];

    const price = botState.lastPrice ?? 0;

    // Sanity check: reject trades exceeding 2x portfolio value (likely a parsing error)
    const sanityPortfolioUsd = latestSnap?.portfolio_usd ?? 0;
    // For buy: amount is USDC (already USD-denominated). For sell: use asset's own price, not ETH price.
    const assetSnapForValue = signal === 'sell'
      ? (queries.recentAssetSnapshots.all(symbol, 1) as { price_usd: number; balance: number }[])[0]
      : undefined;
    let tradeValueUsdAsset = signal === 'buy'
      ? amount
      : amount * (assetSnapForValue?.price_usd ?? (price || 0));

    if (sanityPortfolioUsd > 0 && tradeValueUsdAsset > sanityPortfolioUsd * 2) {
      logger.error(`[${symbol}] Trade sanity check BLOCKED: ${signal} value $${tradeValueUsdAsset.toFixed(2)} > 2x portfolio $${sanityPortfolioUsd.toFixed(2)}`);
      return;
    }

    // Minimum trade value guard — floor up to minimum if balance allows, skip if too small
    if (tradeValueUsdAsset < MIN_TRADE_VALUE_USD) {
      const assetUsdPrice = signal === 'buy' ? 1 : (assetSnapForValue?.price_usd ?? (price || 1));
      const balanceUsd = balance * assetUsdPrice;
      if (balanceUsd >= MIN_TRADE_VALUE_USD * 2) {
        // Floor to minimum viable trade — never more than 50% of balance
        amount = Math.min(balance * 0.5, MIN_TRADE_VALUE_USD / (assetUsdPrice || 1));
        tradeValueUsdAsset = amount * assetUsdPrice;
        logger.info(`[${symbol}] Trade amount floored to $${tradeValueUsdAsset.toFixed(2)} (10% = $${(balance * 0.1 * assetUsdPrice).toFixed(2)} was below minimum)`);
      } else {
        logger.info(`[${symbol}] Trade skipped — $${balanceUsd.toFixed(2)} balance too small for $${MIN_TRADE_VALUE_USD} minimum trade`);
        return;
      }
    }

    // Resolve asset price for P&L tracking
    const assetPriceSnap = (queries.recentAssetSnapshots.all(symbol, 1) as { price_usd: number; balance: number }[])[0];
    const assetPrice = assetPriceSnap?.price_usd ?? price;

    // Compute realized P&L for sells (don't delete position yet — wait for swap confirmation)
    let entryPriceForRecord: number | undefined;
    let realizedPnl: number | undefined;
    if (signal === 'sell') {
      const pos = this._openPositions.get(symbol);
      if (pos && pos.entryPrice > 0) {
        realizedPnl = (assetPrice - pos.entryPrice) * Math.min(amount, pos.qty);
        entryPriceForRecord = pos.entryPrice;
      }
    }

    if (dryRun) {
      logger.info(`[DRY RUN] ${signal} ${symbol} amount=${amount}: ${reason}`);
      if (signal === 'buy') this._openPositions.set(symbol, { entryPrice: assetPrice, qty: amount });
      if (signal === 'sell') this._openPositions.delete(symbol);
      this.recordTrade({
        signal: signal as 'buy' | 'sell', amountEth: amount, price: assetPrice,
        triggeredBy: 'asset-strategy', status: 'dry_run', dryRun: true, reason,
        entryPrice: entryPriceForRecord, realizedPnl, symbol,
      });
      return;
    }

    logger.info(`Executing ${signal} ${symbol} amount=${amount}: ${reason}`);

    let txHash: string | undefined;
    let status = 'executed';

    try {
      const result = await this.tools.swap(fromSymbol, toSymbol, amount.toString());
      txHash = result.txHash;
    } catch (err) {
      logger.error(`[${symbol}] Swap failed for ${signal}`, err);
      status = 'failed';
    }

    if (status === 'executed') {
      if (signal === 'buy') {
        this._openPositions.set(symbol, { entryPrice: assetPrice, qty: amount });
      } else {
        this._openPositions.delete(symbol);
      }
    }

    this.recordTrade({
      signal: signal as 'buy' | 'sell', amountEth: amount, price: assetPrice, txHash,
      triggeredBy: 'asset-strategy', status, dryRun: false, reason,
      entryPrice: entryPriceForRecord, realizedPnl: status === 'executed' ? realizedPnl : undefined, symbol,
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

    this.recordTrade({ signal, amountEth, price, txHash, triggeredBy: 'manual', status: 'executed', dryRun, reason: 'manual', symbol: signal === 'sell' ? from : to });
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
        const result = await this.tools.swap(sellSymbol, 'USDC', sellAmount.toString());
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
          freshUsdcBalance = await this.tools.getErc20BalanceBySymbol('USDC');
        } catch {
          freshUsdcBalance = botState.lastUsdcBalance ?? 0;
        }
        const amount = Math.max(freshUsdcBalance * 0.95, 0); // leave 5% buffer
        if (amount <= 0) {
          logger.warn('Rotation leg 2 skipped: no USDC balance after sell');
          botState.recordTrade(new Date());
          return { status: 'leg1_done', sellTxHash };
        }
        const result = await this.tools.swap('USDC', buySymbol, amount.toString());
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
    entryPrice?: number; realizedPnl?: number; strategy?: string; symbol?: string;
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
      entry_price:  t.entryPrice ?? null,
      realized_pnl: t.realizedPnl ?? null,
      strategy:     t.strategy ?? null,
      symbol:       t.symbol ?? null,
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
