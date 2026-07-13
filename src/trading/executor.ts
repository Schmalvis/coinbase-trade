import { CoinbaseTools, type TokenSymbol } from '../wallet/tools.js';
import { botState } from '../core/state.js';
import { queries, discoveredAssetQueries, dailyPnlQueries } from '../data/db.js';
import { logger } from '../core/logger.js';
import type { Signal } from '../strategy/base.js';
import type { RuntimeConfig } from '../core/runtime-config.js';
import { SlippageCache } from './slippage-cache.js';
import { ASSET_REGISTRY } from '../assets/registry.js';
import { getMemecoincapVeto } from './risk-guard.js';

const MAX_SHADOW_PERIOD_MS = 48 * 60 * 60 * 1000; // sanity cap — stale/corrupt values beyond 48h are ignored

// C3 — auto-disable on losing streak
const LOSING_STREAK_THRESHOLD = 3;              // consecutive realized losses before auto-pause
const LOSING_STREAK_SHADOW_MS = 7 * 24 * 60 * 60 * 1000; // pause the asset for 7 days

// C1 — stale-price freshness window. Shared by the BUY guard below and (Nit1) the rotation
// leg-2 slippage spot read in checkSlippage(): a snapshot older than this is treated as
// unavailable rather than trusted.
const MAX_PRICE_AGE_MS = 30 * 60 * 1000;

// Nit2 — reserve a small ETH buffer for gas when a rotation clamps a native-ETH sell leg to
// the fresh on-chain balance (C9). Base gas is cheap; this is comfortably above a typical
// swap's gas cost while staying negligible relative to any real position size.
const GAS_RESERVE_ETH = 0.0002;

export function isShadowPeriod(shadowUntil: number | null | undefined): boolean {
  if (!shadowUntil) return false;
  if (shadowUntil > Date.now() + MAX_SHADOW_PERIOD_MS) return false; // value is stale or was set incorrectly
  return Date.now() < shadowUntil;
}

/**
 * Parses a SQLite `datetime('now')`-style timestamp ('YYYY-MM-DD HH:MM:SS', UTC, no timezone
 * suffix) and returns its age in ms relative to now. Returns `Infinity` for a missing/undefined
 * timestamp so callers' `age > MAX_PRICE_AGE_MS` freshness checks fail closed.
 */
function snapshotAgeMs(ts: string | null | undefined): number {
  if (!ts) return Infinity;
  const iso = /Z$|[+-]\d{2}:?\d{2}$/.test(ts) ? ts : ts.replace(' ', 'T') + 'Z';
  return Date.now() - new Date(iso).getTime();
}

export class TradeExecutor {
  private readonly _assetCooldowns = new Map<string, Date>();
  // Tracks entry price and quantity for open positions (for realized P&L calculation)
  private readonly _openPositions = new Map<string, { entryPrice: number; qty: number }>();
  private readonly slippageCache = new SlippageCache();

  private isRegistryAsset(symbol: string): boolean {
    return ASSET_REGISTRY.some(a => a.symbol === symbol);
  }

  /**
   * Expose open positions (entry price + qty per symbol) for read-only consumers
   * such as the PortfolioOptimizer cost-basis hold-bias (Fable B3). Returns a copy
   * so callers can't mutate the executor's internal accounting.
   */
  getOpenPositions(): Map<string, { entryPrice: number; qty: number }> {
    return new Map(this._openPositions);
  }

  /**
   * C3 — Auto-disable on losing streak. After a SELL realizes P&L, check whether the
   * last LOSING_STREAK_THRESHOLD realized sells on this asset were all losses. If so,
   * shadow the asset (effectively pausing live trades) for a week and fire a Telegram alert.
   * Skips registry assets, assets with too few realized trades, and already-shadowed assets.
   */
  private checkLosingStreak(symbol: string): void {
    if (this.isRegistryAsset(symbol)) return;

    const network = botState.activeNetwork;
    const row = discoveredAssetQueries.getAssetBySymbol.get(symbol, network) as
      { shadow_until: number | null } | undefined;
    if (!row) return;
    if (isShadowPeriod(row.shadow_until)) return; // already shadowed — don't double-trigger

    const recent = discoveredAssetQueries.getRecentRealizedTrades.all(
      symbol, network, LOSING_STREAK_THRESHOLD,
    ) as { realized_pnl: number }[];

    // Only apply once we have at least the threshold number of realized sells
    if (recent.length < LOSING_STREAK_THRESHOLD) return;
    if (!recent.every(t => t.realized_pnl < 0)) return;

    const shadowUntil = Date.now() + LOSING_STREAK_SHADOW_MS;
    discoveredAssetQueries.setShadowUntil.run({ shadow_until: shadowUntil, symbol, network });

    const msg = `🛑 ${symbol} auto-paused after ${LOSING_STREAK_THRESHOLD} consecutive realized losses — shadowed for 7 days`;
    logger.warn(`[${symbol}] ${msg}`);
    queries.insertEvent.run('losing_streak_pause', `${symbol}: ${LOSING_STREAK_THRESHOLD} consecutive losses`);
    botState.emitAlert(msg);
  }

  private async checkSlippage(symbol: string, address: string, amountUsd: number): Promise<boolean> {
    if (this.isRegistryAsset(symbol)) return true; // registry assets skip check

    const cached = this.slippageCache.get(symbol);
    if (cached !== null) {
      if (cached > 1.5) {
        logger.warn(`[${symbol}] Slippage ${cached.toFixed(2)}% > 1.5% (cached) — trade vetoed`);
        return false;
      }
      return true;
    }

    try {
      // S1: impact is derived from a CDP-SDK quote (getQuoteImpactPct) compared against the
      // latest known spot price for this asset — no 0x key required/used. If we have no recent
      // priced snapshot, spotPriceUsd is 0 and getQuoteImpactPct returns null (fail-closed).
      // Nit1: this is shared by the single-asset BUY pre-check and the rotation leg-2 buy
      // check — the BUY path is separately protected by C1's 30-min freshness guard on its own
      // read, but that guard never covered this spot read. An inflated STALE snapshot here could
      // mask real impact on the rotation path, so apply the same freshness window directly: a
      // missing or >30min-old snapshot is treated as unavailable (spotPriceUsd=0), which routes
      // through the existing fail-closed impact===null branch below.
      const spotRow = queries.getLatestAssetSnapshot.get(symbol) as { price_usd: number; timestamp: string } | undefined;
      const spotAgeMs = snapshotAgeMs(spotRow?.timestamp);
      const spotPriceUsd = (spotRow && spotRow.price_usd > 0 && spotAgeMs <= MAX_PRICE_AGE_MS) ? spotRow.price_usd : 0;
      const impact = await this.tools.getQuoteImpactPct(address, amountUsd, spotPriceUsd);
      // C4: fail-CLOSED for non-registry assets. A null impact means we could not obtain a
      // reliable slippage reading (no liquidity, no spot price, or the quote failed). We must
      // not trade blind into an illiquid token, so block rather than assume 0% impact.
      if (impact === null) {
        logger.warn(`[${symbol}] Slippage unknown (no reliable quote) — trade vetoed (fail-closed)`);
        return false;
      }
      this.slippageCache.set(symbol, impact);
      if (impact > 1.5) {
        logger.warn(`[${symbol}] Slippage ${impact.toFixed(2)}% > 1.5% — trade vetoed`);
        return false;
      }
      return true;
    } catch (err) {
      logger.warn(`[${symbol}] Slippage check failed: ${err} — trade vetoed (fail-closed)`);
      return false; // fail-closed: never trade a non-registry asset we cannot price-check
    }
  }

  constructor(
    private readonly tools: CoinbaseTools,
    private readonly runtimeConfig: RuntimeConfig,
  ) {
    runtimeConfig.subscribeMany(
      ['DRY_RUN', 'MAX_TRADE_SIZE_ETH', 'MAX_TRADE_SIZE_USDC', 'TRADE_COOLDOWN_SECONDS'],
      () => { /* values are read live via get() — no state to update */ },
    );
  }

  seedOpenPositions(network: string): void {
    try {
      const registrySymbols = ASSET_REGISTRY.map(a => a.symbol);
      const discoveredSymbols = (discoveredAssetQueries.getActiveAssets.all(network) as { symbol: string }[]).map(r => r.symbol);
      const allSymbols = Array.from(new Set([...registrySymbols, ...discoveredSymbols]));

      let n = 0;
      const seededSymbols: string[] = [];

      for (const symbol of allSymbols) {
        if (symbol === 'USDC') continue;

        const snapshot = queries.getLatestAssetSnapshot.get(symbol) as { balance: number; price_usd: number } | undefined;
        if (!snapshot) continue;
        if (snapshot.balance <= 0) continue;
        if (snapshot.balance * snapshot.price_usd < 0.01) continue; // dust

        const row = queries.lastTradeForSymbol.get(symbol, network) as
          { action: string; price_usd: number; amount_eth: number; entry_price: number | null } | undefined;

        let entryPrice: number;
        let qty: number;

        if (row && row.action === 'buy' && row.price_usd > 0) {
          // Rule 1: last trade was a buy → use its price as cost basis
          entryPrice = row.price_usd;
          qty = Math.min(row.amount_eth, snapshot.balance);
        } else if (row && row.action === 'sell' && row.entry_price != null && row.entry_price > 0) {
          // Rule 2: last trade was a sell with entry_price recorded — carry it forward
          entryPrice = row.entry_price;
          qty = snapshot.balance;
        } else {
          // Rule 3: no usable trade history — seed at current price
          entryPrice = snapshot.price_usd;
          qty = snapshot.balance;
          logger.info(`[${symbol}] No trade history — seeding at current price ${entryPrice.toFixed(4)} (rule 3)`);
        }

        if (entryPrice <= 0) continue;

        this._openPositions.set(symbol, { entryPrice, qty });
        n++;
        seededSymbols.push(symbol);
      }

      if (n > 0) {
        logger.info(`Seeded ${n} open positions from DB: ${seededSymbols.join(', ')}`);
      }
    } catch (err) {
      logger.error('seedOpenPositions failed', err);
      return;
    }
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
        // C8-followup: swap() now settles on-chain before returning. A reverted tx comes back
        // as status:'failed' WITHOUT throwing — must not be recorded as an executed trade.
        if (result.status === 'failed') status = 'failed';
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

    // Safety: daily-loss limit (C6). The optimizer path enforces MAX_DAILY_LOSS_PCT via
    // RiskGuard, but per-asset trades bypassed it entirely — a day of per-asset bleed with
    // no rotation candidate never halted. Mirror RiskGuard's close-based metric here
    // (baseline = day's opening value, falling back to high_water for legacy rows).
    const maxDailyLossPct = this.runtimeConfig.get('MAX_DAILY_LOSS_PCT') as number;
    const todayPnlRow = dailyPnlQueries.getTodayPnl.get(botState.activeNetwork) as
      { open_usd: number | null; high_water: number | null } | undefined;
    const lossBaseline = (todayPnlRow?.open_usd && todayPnlRow.open_usd > 0
      ? todayPnlRow.open_usd
      : todayPnlRow?.high_water) ?? 0;
    const currentPortfolioUsd = latestSnap?.portfolio_usd ?? 0;
    if (lossBaseline > 0 && currentPortfolioUsd > 0) {
      const lossPct = ((lossBaseline - currentPortfolioUsd) / lossBaseline) * 100;
      if (lossPct > maxDailyLossPct) {
        logger.warn(`[${symbol}] Trade blocked — daily loss ${lossPct.toFixed(1)}% > ${maxDailyLossPct}%`);
        if (!botState.isPaused) {
          botState.setStatus('paused');
          botState.emitAlert(`Daily loss limit hit (${lossPct.toFixed(1)}%). Trading paused.`);
        }
        return;
      }
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

    // Slippage pre-check for non-registry assets (buy only)
    if (signal === 'buy' && !this.isRegistryAsset(symbol)) {
      const assetRow = discoveredAssetQueries.getAddressBySymbol.get(symbol, botState.activeNetwork) as { address: string } | undefined;
      if (assetRow) {
        const portfolioUsd = latestSnap?.portfolio_usd ?? 0;
        const tradeUsd = portfolioUsd * 0.1; // pre-check at 10% of portfolio
        const ok = await this.checkSlippage(symbol, assetRow.address, tradeUsd);
        if (!ok) {
          queries.insertEvent.run('slippage_veto', `${symbol}: slippage > 1.5%`);
          return;
        }
      }
    }

    // Shadow period: newly-promoted tokens dry-run for 24h before live trades
    if (!this.isRegistryAsset(symbol)) {
      const row = discoveredAssetQueries.getAssetBySymbol.get(symbol, botState.activeNetwork) as { shadow_until: number | null } | undefined;
      if (isShadowPeriod(row?.shadow_until)) {
        logger.info(`[${symbol}] Shadow period active — logging dry-run trade`);
        queries.insertTrade.run({
          action: signal,
          amount_eth: 0, // placeholder since this is a shadow record
          price_usd: 0,
          tx_hash: null,
          triggered_by: 'shadow-period',
          status: 'dry_run',
          dry_run: 1,
          reason: 'shadow-period',
          network: botState.activeNetwork,
          entry_price: null,
          realized_pnl: null,
          strategy: 'shadow',
          symbol,
        });
        return;
      }
    }

    const dryRun = this.runtimeConfig.get('DRY_RUN') as boolean;

    // Fetch memecoin flag once — shared by cooldown and cap checks below
    const memeRow2 = !this.isRegistryAsset(symbol)
      ? discoveredAssetQueries.getMemecoinflagBySymbol.get(symbol)
      : undefined;

    const baseCooldownSecs = this.runtimeConfig.get('TRADE_COOLDOWN_SECONDS') as number;
    const memeMultiplier = memeRow2?.is_memecoin ? 2 : 1;
    const cooldownSecs = baseCooldownSecs * memeMultiplier;
    const last = this._assetCooldowns.get(symbol);
    if (priority !== 'stop-loss' && last && (Date.now() - last.getTime()) < cooldownSecs * 1000) {
      logger.debug(`Cooldown active for ${symbol}, skipping`);
      return;
    }
    // Claim cooldown upfront to prevent concurrent calls bypassing the check
    this._assetCooldowns.set(symbol, new Date());

    // Memecoin combined cap — per-asset buy path
    if (signal === 'buy' && memeRow2?.is_memecoin) {
      const portfolioUsd = latestSnap?.portfolio_usd ?? 0;
      const memeCapPct = (this.runtimeConfig.get('MEMECOIN_CAP_PCT') as number | undefined) ?? 20;
      const memes = discoveredAssetQueries.getActiveMemecoins.all();
      const memePositions: Record<string, number> = {};
      for (const { symbol: ms } of memes) {
        const balance = botState.assetBalances.get(ms) ?? 0;
        const snap = queries.getLatestAssetSnapshot.get(ms) as { price_usd: number } | undefined;
        memePositions[ms] = balance * (snap?.price_usd ?? 0);
      }
      const tradeUsd = (botState.assetBalances.get('USDC') ?? 0) * 0.1;
      const veto = getMemecoincapVeto(symbol, tradeUsd, memePositions, portfolioUsd, memeCapPct);
      if (veto) {
        logger.warn(`[${symbol}] ${veto}`);
        queries.insertEvent.run('memecoin_cap_veto', veto);
        return;
      }
    }

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

    // C1: reject a BUY of a non-registry asset that has no fresh, positive price.
    // Illiquid/spam tokens frequently price at $0 (feed dropout or genuinely worthless);
    // buying them spends real USDC on effectively-worthless fills. Registry assets
    // (ETH/CBBTC/CBETH/USDC) are exempt — they price via Pyth/fixed and keep their flow.
    if (signal === 'buy' && !this.isRegistryAsset(symbol)) {
      const buySnap = (queries.recentAssetSnapshots.all(symbol, 1) as { price_usd: number; timestamp: string }[])[0];
      const buyPriceAgeMs = snapshotAgeMs(buySnap?.timestamp);
      if (!buySnap || !(buySnap.price_usd > 0) || buyPriceAgeMs > MAX_PRICE_AGE_MS) {
        logger.warn(`[${symbol}] BUY rejected — no fresh price (price=$${buySnap?.price_usd ?? 'none'}, age=${Number.isFinite(buyPriceAgeMs) ? Math.round(buyPriceAgeMs / 1000) + 's' : 'n/a'})`);
        queries.insertEvent.run('buy_no_price_veto', `${symbol}: price=${buySnap?.price_usd ?? 'none'}`);
        return;
      }
    }

    // For buy: amount is USDC (already USD-denominated). For sell: use asset's own price, not ETH price.
    const assetSnapForValue = signal === 'sell'
      ? (queries.recentAssetSnapshots.all(symbol, 1) as { price_usd: number; balance: number }[])[0]
      : undefined;

    // C11: for a non-registry SELL, never fall back to the ETH `price` when there's no valid
    // asset snapshot — that would value a spam token at ETH's price (~$3000/token) and
    // corrupt the sanity check, floor, and P&L math below. Treat it as unpriceable and skip.
    if (signal === 'sell' && !this.isRegistryAsset(symbol) && !(assetSnapForValue && assetSnapForValue.price_usd > 0)) {
      logger.warn(`[${symbol}] SELL rejected — no valid price for value/P&L math (price=${assetSnapForValue?.price_usd ?? 'none'})`);
      queries.insertEvent.run('sell_no_price_veto', `${symbol}: price=${assetSnapForValue?.price_usd ?? 'none'}`);
      return;
    }

    // Sanity check: reject trades exceeding 2x portfolio value (likely a parsing error)
    const sanityPortfolioUsd = latestSnap?.portfolio_usd ?? 0;
    let tradeValueUsdAsset = signal === 'buy'
      ? amount
      : amount * (assetSnapForValue?.price_usd ?? (price || 0));

    if (sanityPortfolioUsd > 0 && tradeValueUsdAsset > sanityPortfolioUsd * 2) {
      logger.error(`[${symbol}] Trade sanity check BLOCKED: ${signal} value $${tradeValueUsdAsset.toFixed(2)} > 2x portfolio $${sanityPortfolioUsd.toFixed(2)}`);
      return;
    }

    // Minimum trade value guard — floor up to minimum if balance allows, skip if too small
    if (tradeValueUsdAsset < MIN_TRADE_VALUE_USD) {
      // C1: never FORCE a floored $2 trade on a non-registry (discovered/spam) asset.
      // Forcing $2 into an illiquid token buys near-worthless fills and pays fees that
      // exceed the trade. Registry assets keep the floor behaviour for dust consolidation.
      if (!this.isRegistryAsset(symbol)) {
        logger.info(`[${symbol}] Trade skipped — $${tradeValueUsdAsset.toFixed(2)} below $${MIN_TRADE_VALUE_USD} min (no floor for non-registry assets)`);
        return;
      }
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

    // Resolve asset price for P&L tracking.
    // C11: registry assets keep the ETH-price fallback (unchanged behavior); non-registry
    // assets never fall back to it — the SELL guard above and C1's BUY guard already ensure
    // a valid snapshot exists in normal operation, but this closes the path defensively too
    // (assetPrice=0 short-circuits the position-record checks below rather than mispricing).
    const assetPriceSnap = (queries.recentAssetSnapshots.all(symbol, 1) as { price_usd: number; balance: number }[])[0];
    const assetPrice = assetPriceSnap?.price_usd ?? (this.isRegistryAsset(symbol) ? price : 0);

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
      // C1: only record a position when we have a real entry price. entryPrice=0 corrupts
      // realized-P&L accounting (a later sell can't compute gain from a 0 basis).
      if (signal === 'buy' && assetPrice > 0) this._openPositions.set(symbol, { entryPrice: assetPrice, qty: amount / assetPrice });
      if (signal === 'sell') {
        const posKey = symbol;
        const existingPos = this._openPositions.get(posKey);
        if (existingPos) {
          existingPos.qty -= amount;
          if (existingPos.qty <= 1e-9) this._openPositions.delete(posKey);
        }
      }
      this.recordTrade({
        signal: signal as 'buy' | 'sell', amountEth: signal === 'buy' ? amount / (assetPrice || 1) : amount, price: assetPrice,
        triggeredBy: 'asset-strategy', status: 'dry_run', dryRun: true, reason,
        entryPrice: entryPriceForRecord, realizedPnl, symbol,
      });
      return;
    }

    logger.info(`Executing ${signal} ${symbol} amount=${amount}: ${reason}`);

    let txHash: string | undefined;
    let status = 'executed';

    try {
      // Resolve contract address for discovered tokens — registry/ETH/USDC resolve via getTokenAddress()
      const tokenAddr = !this.isRegistryAsset(symbol)
        ? (discoveredAssetQueries.getAddressBySymbol.get(symbol, botState.activeNetwork) as { address: string } | undefined)?.address
        : undefined;
      const result = await this.tools.swap(
        fromSymbol, toSymbol, amount.toString(),
        signal === 'sell' ? tokenAddr : undefined,
        signal === 'buy'  ? tokenAddr : undefined,
      );
      txHash = result.txHash;
      // C8-followup: swap() now settles on-chain before returning. A reverted tx comes back
      // as status:'failed' WITHOUT throwing — must not be recorded as an executed trade or
      // open a phantom position below.
      if (result.status === 'failed') {
        logger.error(`[${symbol}] Swap reverted on-chain for ${signal} txHash=${txHash}`);
        status = 'failed';
      }
    } catch (err) {
      logger.error(`[${symbol}] Swap failed for ${signal}`, err);
      status = 'failed';
    }

    if (status === 'executed') {
      if (signal === 'buy') {
        // C1: skip recording a position without a real entry price (would corrupt P&L).
        if (assetPrice > 0) {
          this._openPositions.set(symbol, { entryPrice: assetPrice, qty: amount / assetPrice });
        } else {
          logger.warn(`[${symbol}] Position not recorded — asset price is 0`);
        }
      } else {
        const posKey = symbol;
        const existingPos = this._openPositions.get(posKey);
        if (existingPos) {
          existingPos.qty -= amount;
          if (existingPos.qty <= 1e-9) this._openPositions.delete(posKey);
        }
      }
    }

    this.recordTrade({
      signal: signal as 'buy' | 'sell', amountEth: signal === 'buy' ? amount / (assetPrice || 1) : amount, price: assetPrice, txHash,
      triggeredBy: 'asset-strategy', status, dryRun: false, reason,
      entryPrice: entryPriceForRecord, realizedPnl: status === 'executed' ? realizedPnl : undefined, symbol,
    });
    // C3: after a realized sell, check for a losing streak and auto-pause if found
    if (signal === 'sell' && status === 'executed') this.checkLosingStreak(symbol);
    logger.info(`executeForAsset complete: ${signal} ${symbol} (${status})`);
  }

  async executeEnso(
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
  ): Promise<{ txHash?: string; dryRun: boolean; status: string }> {
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
    let status = 'executed';

    if (!dryRun) {
      const result = await this.tools.ensoRoute(tokenIn, tokenOut, amountIn);
      txHash = result.txHash;
      // C8-followup: swap() now settles on-chain before returning. A reverted tx comes back
      // as status:'failed' WITHOUT throwing — must not be recorded as an executed trade.
      if (result.status === 'failed') {
        logger.error(`Enso trade reverted on-chain (${tokenIn.slice(0, 10)}→${tokenOut.slice(0, 10)}) txHash=${txHash}`);
        status = 'failed';
      }
    }

    this.recordTrade({
      signal: 'sell', // token→token is directionally a sell for accounting
      amountEth: parseFloat(amountIn),
      price,
      txHash,
      triggeredBy: 'manual-enso',
      status,
      dryRun,
      reason: `enso ${tokenIn.slice(0, 10)}→${tokenOut.slice(0, 10)}`,
    });
    return { txHash, dryRun, status };
  }

  async executeManual(
    from: TokenSymbol,
    to: TokenSymbol,
    fromAmount: string,
  ): Promise<{ txHash?: string; dryRun: boolean; status: string }> {
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
    let status = 'executed';

    if (!dryRun) {
      const result = await this.tools.swap(from, to, fromAmount);
      txHash = result.txHash;
      // C8-followup: swap() now settles on-chain before returning. A reverted tx comes back
      // as status:'failed' WITHOUT throwing — must not be recorded as an executed trade.
      if (result.status === 'failed') {
        logger.error(`Manual trade reverted on-chain (${from}→${to}) txHash=${txHash}`);
        status = 'failed';
      }
    }

    this.recordTrade({ signal, amountEth, price, txHash, triggeredBy: 'manual', status, dryRun, reason: 'manual', symbol: signal === 'sell' ? from : to });
    return { txHash, dryRun, status };
  }

  async executeRotation(
    sellSymbol: string,
    buySymbol: string,
    sellAmountUsd: number,  // USD value — converted to token units internally
    rotationId?: number,
    skipLeg1 = false,       // C5: recovery of a leg1_done rotation — leg 1 already sold, do leg 2 only
  ): Promise<{ status: 'executed' | 'leg1_done' | 'failed'; sellTxHash?: string; buyTxHash?: string; actualBuyUsd?: number; failureReason?: string }> {
    const dryRun = this.runtimeConfig.get('DRY_RUN') as boolean;

    // Convert USD sell amount to native token units for leg 1.
    // Previously this passed USD directly to tools.swap which expects token units,
    // causing swaps 100-1000x larger than intended (e.g. "8.87 ETH" instead of "$8.87 of ETH").
    let sellTokenAmount = 0;
    let price = 0;
    if (skipLeg1) {
      // Recovery: proceeds from the original leg 1 are already in USDC. We only need a
      // reference price for bookkeeping — never re-sell, so no price>0 gate is required.
      price = sellSymbol === 'USDC' ? 1
        : sellSymbol === 'ETH' ? (botState.lastPrice ?? 0)
        : ((queries.recentAssetSnapshots.all(sellSymbol, 1) as { price_usd: number }[])[0]?.price_usd ?? 0);
    } else if (sellSymbol === 'USDC') {
      sellTokenAmount = sellAmountUsd;
      price = 1;
    } else {
      if (sellSymbol === 'ETH') {
        price = botState.lastPrice ?? 0;
      } else {
        const snap = (queries.recentAssetSnapshots.all(sellSymbol, 1) as { price_usd: number }[])[0];
        price = snap?.price_usd ?? 0;
      }
      if (price <= 0) {
        logger.error(`executeRotation: no price for ${sellSymbol}, cannot convert sell amount`);
        return { status: 'failed' };
      }
      sellTokenAmount = sellAmountUsd / price;
    }

    // Resolve contract addresses for discovered tokens upfront
    const sellAddr = !this.isRegistryAsset(sellSymbol)
      ? (discoveredAssetQueries.getAddressBySymbol.get(sellSymbol, botState.activeNetwork) as { address: string } | undefined)?.address
      : undefined;
    const buyAddr = !this.isRegistryAsset(buySymbol)
      ? (discoveredAssetQueries.getAddressBySymbol.get(buySymbol, botState.activeNetwork) as { address: string } | undefined)?.address
      : undefined;

    // Leg 1: Sell → USDC (skip when sell side is already USDC — avoids USDC→USDC swap error)
    let sellTxHash: string | undefined;
    let leg1Status = 'executed';
    // C8: real USDC proceeds measured from a before/after balance delta around the leg-1
    // swap. Only set when leg 1 actually executes live in THIS call — used below to size
    // leg 2 from reality instead of the (possibly stale-priced) intended sellAmountUsd.
    let leg1ProceedsUsd: number | undefined;

    if (skipLeg1) {
      // C5: leg 1 already executed on the original rotation. Re-running it here would
      // sell a SECOND tranche of the asset (double-sell). Skip straight to leg 2.
      logger.info(`[recovery] Skipping leg 1 for ${sellSymbol}→${buySymbol} — proceeds already in USDC`);
    } else if (sellSymbol === 'USDC') {
      logger.info(`Rotation: sell side is USDC — skipping leg 1, spending $${sellAmountUsd.toFixed(2)} directly`);
    } else if (!dryRun) {
      try {
        // C9: clamp the leg-1 sell amount to the real on-chain balance. sellTokenAmount was
        // derived from a (possibly stale) snapshot price — an overstated amount makes the
        // swap fail; an understated one sells too little. Abort cleanly on ~0 balance rather
        // than attempting a dust swap.
        const freshSellAddr = sellAddr ?? this.tools.getTokenAddress(sellSymbol);
        const freshSellBalance = await this.tools.getErc20Balance(freshSellAddr);
        if (freshSellBalance <= 1e-9) {
          logger.warn(`Rotation leg 1 aborted — fresh on-chain balance of ${sellSymbol} is ~0`);
          return { status: 'failed', failureReason: `leg1: ${sellSymbol} on-chain balance is ~0` };
        }
        // Nit2: for a native-ETH sell only, reserve a small gas buffer. C9's clamp above (to
        // the full fresh balance) could otherwise sell every wei of ETH, leaving nothing to pay
        // for the swap tx's own gas. ERC20 sells (CBBTC/CBETH/discovered tokens) pay gas from a
        // separate ETH balance and are unaffected.
        const availableSellBalance = sellSymbol === 'ETH'
          ? Math.max(0, freshSellBalance - GAS_RESERVE_ETH)
          : freshSellBalance;
        if (sellSymbol === 'ETH' && availableSellBalance <= 1e-9) {
          logger.warn(`Rotation leg 1 aborted — ETH balance ${freshSellBalance.toFixed(8)} leaves ~0 after reserving ${GAS_RESERVE_ETH} for gas`);
          return { status: 'failed', failureReason: `leg1: ETH balance too small after ${GAS_RESERVE_ETH} gas reserve` };
        }
        if (availableSellBalance < sellTokenAmount) {
          logger.info(`Rotation leg 1: clamping ${sellSymbol} sell amount ${sellTokenAmount.toFixed(8)} → available ${availableSellBalance.toFixed(8)}${sellSymbol === 'ETH' ? ` (reserved ${GAS_RESERVE_ETH} ETH for gas)` : ''}`);
          sellTokenAmount = availableSellBalance;
        }

        // C8: measure USDC balance immediately before/after the swap to know the real proceeds.
        let usdcBefore: number | undefined;
        try {
          usdcBefore = await this.tools.getErc20BalanceBySymbol('USDC');
        } catch {
          usdcBefore = undefined;
        }

        const result = await this.tools.swap(sellSymbol, 'USDC', sellTokenAmount.toString(), sellAddr);
        sellTxHash = result.txHash;

        // C8-followup: swap() now waits for on-chain settlement before returning. A reverted
        // tx comes back as status:'failed' WITHOUT throwing — must abort the rotation here
        // (not proceed to leg 2, not record a phantom sell) rather than falling through as if
        // leg 1 succeeded.
        if (result.status === 'failed') {
          logger.error(`Rotation leg 1 reverted on-chain (sell ${sellSymbol}) txHash=${sellTxHash}`);
          return { status: 'failed', sellTxHash, failureReason: `leg1: swap reverted on-chain (txHash=${sellTxHash})` };
        }

        if (usdcBefore != null) {
          try {
            const usdcAfter = await this.tools.getErc20BalanceBySymbol('USDC');
            const measured = usdcAfter - usdcBefore;
            if (measured > 0) leg1ProceedsUsd = measured;
          } catch (err) {
            logger.warn(`Rotation leg 1: could not measure post-swap USDC balance — leg 2 will size from intended amount`, err);
          }
        }
      } catch (err) {
        logger.error(`Rotation leg 1 failed (sell ${sellSymbol})`, err);
        return { status: 'failed', failureReason: `leg1: ${err instanceof Error ? err.message : String(err)}` };
      }
    } else {
      logger.info(`[DRY RUN] Rotation leg 1: sell ${sellTokenAmount.toFixed(8)} ${sellSymbol} (~$${sellAmountUsd.toFixed(2)}) → USDC`);
      leg1Status = 'dry_run';
    }

    // Record leg 1 sell trade (only when actually selling a non-USDC asset).
    // C5: on recovery (skipLeg1) the original sell was already recorded — don't duplicate it.
    if (!skipLeg1 && sellSymbol !== 'USDC') {
      const sellPos = this._openPositions.get(sellSymbol);
      const sellRealizedPnl = sellPos && price > 0
        ? (price - sellPos.entryPrice) * Math.min(sellTokenAmount, sellPos.qty)
        : undefined;
      if (sellPos) {
        sellPos.qty -= sellTokenAmount;
        if (sellPos.qty <= 1e-9) this._openPositions.delete(sellSymbol);
      }
      this.recordTrade({
        signal: 'sell', amountEth: sellTokenAmount, price, txHash: sellTxHash,
        triggeredBy: 'rotation', status: leg1Status, dryRun,
        reason: `rotation → ${buySymbol}`,
        entryPrice: sellPos?.entryPrice,
        realizedPnl: sellRealizedPnl, symbol: sellSymbol,
      });
      // C3: rotation leg-1 is a realized sell — check for a losing streak on the sold asset
      if (leg1Status === 'executed') this.checkLosingStreak(sellSymbol);
    }

    // Defensive rotation to USDC: leg 1 IS the full rotation — no leg 2 needed
    if (buySymbol === 'USDC') {
      // Claim per-asset cooldown so the sma loop cannot immediately rebuy the sold asset
      // and undo the defensive exit within the same cooldown window.
      if (leg1Status === 'executed') this._assetCooldowns.set(sellSymbol, new Date());
      botState.recordTrade(new Date());
      // C8: report the measured leg-1 proceeds when available (live exit) — falls back to
      // the intended amount for skipLeg1 recovery / dry-run, where nothing was measured.
      return { status: 'executed', sellTxHash, actualBuyUsd: leg1ProceedsUsd ?? sellAmountUsd };
    }

    // Leg 2: USDC → Buy target. Spend only the proceeds from leg 1, not all USDC.
    // C8: when leg 1 executed live in THIS call and its real proceeds were measured, size
    // leg 2 from those measured proceeds. skipLeg1 recovery (leg 1 ran in a prior process —
    // no delta measurable here), a USDC-sourced sell (no leg-1 swap at all), and dry-run
    // (nothing actually moved on-chain) all fall back to the existing sellAmountUsd-based
    // sizing — the pre-existing safe "spend only proceeds, not all USDC" behavior.
    const leg2UsdcAmount = (leg1ProceedsUsd ?? sellAmountUsd) * 0.98; // 2% buffer for fees
    let buyTxHash: string | undefined;
    let actualLeg2Spent: number | undefined;

    // C4: slippage-check the buy leg for non-registry targets (fail-closed). Rotations
    // previously bought discovered tokens with no slippage screening at all. If the check
    // vetoes, leg 1 already executed, so we stop at leg1_done holding USDC (safe).
    if (!dryRun && !this.isRegistryAsset(buySymbol) && buyAddr) {
      const ok = await this.checkSlippage(buySymbol, buyAddr, leg2UsdcAmount);
      if (!ok) {
        logger.warn(`Rotation leg 2 vetoed — slippage/liquidity check failed for ${buySymbol}`);
        queries.insertEvent.run('slippage_veto', `${buySymbol}: rotation leg-2`);
        botState.recordTrade(new Date());
        return { status: 'leg1_done', sellTxHash };
      }
    }

    if (!dryRun) {
      try {
        let freshUsdcBalance: number;
        try {
          freshUsdcBalance = await this.tools.getErc20BalanceBySymbol('USDC');
        } catch {
          freshUsdcBalance = botState.lastUsdcBalance ?? 0;
        }
        if (freshUsdcBalance < leg2UsdcAmount * 0.5) {
          logger.warn(`Rotation leg 2 skipped: USDC $${freshUsdcBalance.toFixed(2)} insufficient for $${leg2UsdcAmount.toFixed(2)}`);
          botState.recordTrade(new Date());
          return { status: 'leg1_done', sellTxHash };
        }
        const actualLeg2 = Math.min(leg2UsdcAmount, freshUsdcBalance * 0.99);
        actualLeg2Spent = actualLeg2;
        const result = await this.tools.swap('USDC', buySymbol, actualLeg2.toString(), undefined, buyAddr);
        buyTxHash = result.txHash;

        // C8-followup: swap() now waits for on-chain settlement before returning. A reverted
        // tx comes back as status:'failed' WITHOUT throwing — leg 1's proceeds are already in
        // USDC, so the rotation stays leg1_done (not 'failed') rather than recording a
        // phantom buy fill/position below.
        if (result.status === 'failed') {
          logger.error(`Rotation leg 2 reverted on-chain (buy ${buySymbol}) txHash=${buyTxHash}`);
          botState.recordTrade(new Date());
          return { status: 'leg1_done', sellTxHash, buyTxHash };
        }
      } catch (err) {
        logger.error(`Rotation leg 2 failed (buy ${buySymbol})`, err);
        botState.recordTrade(new Date());
        return { status: 'leg1_done', sellTxHash };
      }
    } else {
      logger.info(`[DRY RUN] Rotation leg 2: buy ${buySymbol} with $${leg2UsdcAmount.toFixed(2)} USDC`);
    }

    // Record leg 2 buy trade. C8: use the actually-spent amount when known (live — clamped to
    // real fresh USDC balance above), else the intended/simulated amount (dry-run), so the
    // recorded position/trade and the returned actualBuyUsd agree on the same real number.
    const leg2SpentForRecord = actualLeg2Spent ?? leg2UsdcAmount;
    const buySnapPrice = buySymbol === 'ETH' ? (botState.lastPrice ?? 0)
      : (queries.recentAssetSnapshots.all(buySymbol, 1) as { price_usd: number }[])[0]?.price_usd ?? 0;
    const buyTokenAmount = buySnapPrice > 0 ? leg2SpentForRecord / buySnapPrice : 0;
    this._openPositions.set(buySymbol, { entryPrice: buySnapPrice, qty: buyTokenAmount });
    this.recordTrade({
      signal: 'buy', amountEth: buyTokenAmount, price: buySnapPrice, txHash: buyTxHash,
      triggeredBy: 'rotation', status: dryRun ? 'dry_run' : 'executed', dryRun,
      reason: `rotation from ${sellSymbol}`, symbol: buySymbol,
    });

    botState.recordTrade(new Date());
    return { status: 'executed', sellTxHash, buyTxHash, actualBuyUsd: leg2SpentForRecord };
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
