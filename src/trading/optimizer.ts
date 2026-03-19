import { CandleService } from '../services/candles.js';
import { CandleStrategy, type CandleSignal } from '../strategy/candle.js';
import { RiskGuard } from './risk-guard.js';
import type { TradeExecutor } from './executor.js';
import { botState } from '../core/state.js';
import { logger } from '../core/logger.js';
import type { RuntimeConfig } from '../core/runtime-config.js';
import { assetsForNetwork } from '../assets/registry.js';
import { rotationQueries, dailyPnlQueries, discoveredAssetQueries, watchlistQueries } from '../data/db.js';
import type { DiscoveredAssetRow } from '../data/db.js';

export interface OpportunityScore {
  symbol: string;
  score: number;           // -100 to +100
  confidence: number;      // 0-1
  signals: {
    candle15m: CandleSignal;
    candle1h: CandleSignal;
    candle24h: CandleSignal;
  };
  currentWeight: number;   // % of portfolio
  isHeld: boolean;
}

const HOLD_SIGNAL: CandleSignal = { signal: 'hold', strength: 0, reason: 'no data' };

export class PortfolioOptimizer {
  private latestScores: OpportunityScore[] = [];
  private _riskOff = false;

  constructor(
    private readonly candleService: CandleService,
    private readonly strategy: CandleStrategy,
    private readonly riskGuard: RiskGuard,
    private readonly executor: TradeExecutor,
    private readonly runtimeConfig: RuntimeConfig,
  ) {}

  getLatestScores(): OpportunityScore[] {
    return this.latestScores;
  }

  get isRiskOff(): boolean {
    return this._riskOff;
  }

  computeScores(network: string): OpportunityScore[] {
    // Collect all symbols to score
    const symbols = new Set<string>();

    // 1. Static registry assets
    for (const asset of assetsForNetwork(network)) {
      symbols.add(asset.symbol);
    }

    // 2. Discovered active assets
    const activeAssets = discoveredAssetQueries.getActiveAssets.all(network) as DiscoveredAssetRow[];
    for (const a of activeAssets) {
      symbols.add(a.symbol);
    }

    // 3. Watchlist
    const watchlist = watchlistQueries.getWatchlist.all(network);
    for (const w of watchlist) {
      symbols.add(w.symbol);
    }

    // Compute total portfolio USD for weight calculation
    let totalPortfolioUsd = 0;
    const assetUsdValues = new Map<string, number>();

    for (const sym of symbols) {
      const balance = botState.assetBalances.get(sym) ?? 0;
      // Use ETH price as proxy for asset price from botState, or look at asset snapshots
      // For a proper implementation we'd track per-asset prices; for now use balance * last known price
      // USDC is ~1:1, ETH uses lastPrice
      let priceEstimate = 0;
      if (sym === 'USDC') {
        priceEstimate = 1;
      } else if (sym === 'ETH') {
        priceEstimate = botState.lastPrice ?? 0;
      } else {
        // For other assets, look at the latest candle close price
        const candles = this.candleService.getStoredCandles(sym, network, '15m', 1);
        priceEstimate = candles.length > 0 ? candles[0].close : 0;
      }
      const usdValue = balance * priceEstimate;
      assetUsdValues.set(sym, usdValue);
      totalPortfolioUsd += usdValue;
    }

    const scores: OpportunityScore[] = [];

    for (const sym of symbols) {
      // Get candles for each timeframe
      const candles15m = this.candleService.getStoredCandles(sym, network, '15m', 50);
      const candles1h = this.candleService.getStoredCandles(sym, network, '1h', 50);
      const candles24h = this.candleService.getStoredCandles(sym, network, '24h', 50);

      // Evaluate signals
      const signal15m = candles15m.length >= 26 ? this.strategy.evaluate(candles15m) : HOLD_SIGNAL;
      const signal1h = candles1h.length >= 26 ? this.strategy.evaluate(candles1h) : HOLD_SIGNAL;
      const signal24h = candles24h.length >= 26 ? this.strategy.evaluate(candles24h) : HOLD_SIGNAL;

      // Compute signed component per timeframe
      const direction = (sig: CandleSignal) =>
        sig.signal === 'buy' ? 1 : sig.signal === 'sell' ? -1 : 0;

      const component15m = direction(signal15m) * signal15m.strength;
      const component1h = direction(signal1h) * signal1h.strength;
      const component24h = direction(signal24h) * signal24h.strength;

      const raw = component15m * 0.5 + component1h * 0.3 + component24h * 0.2;

      // Determine confidence from candle source
      let confidence = 0.4; // default: synthetic
      if (candles15m.length > 0) {
        const latestSource = candles15m[0].source;
        if (latestSource === 'coinbase') confidence = 1.0;
        else if (latestSource === 'dex') confidence = 0.7;
        else confidence = 0.4;
      }

      let score = raw * confidence;

      // Volume bonus: if latest 15m candle volume > 1.5x average of last 20
      if (candles15m.length > 0) {
        const latestVolume = candles15m[0].volume;
        const volWindow = candles15m.slice(0, 20);
        const avgVolume = volWindow.reduce((sum, c) => sum + c.volume, 0) / volWindow.length;
        if (avgVolume > 0 && latestVolume > 1.5 * avgVolume) {
          score += score >= 0 ? 10 : -10;
        }
      }

      // Clamp to [-100, 100]
      score = Math.max(-100, Math.min(100, score));

      const balance = botState.assetBalances.get(sym) ?? 0;
      const usdValue = assetUsdValues.get(sym) ?? 0;
      const currentWeight = totalPortfolioUsd > 0 ? (usdValue / totalPortfolioUsd) * 100 : 0;

      scores.push({
        symbol: sym,
        score,
        confidence,
        signals: {
          candle15m: signal15m,
          candle1h: signal1h,
          candle24h: signal24h,
        },
        currentWeight,
        isHeld: balance > 0,
      });
    }

    return scores;
  }

  findRotationCandidate(
    scores: OpportunityScore[],
    network: string,
  ): { sell: OpportunityScore; buy: OpportunityScore } | null {
    const sellThreshold = this.runtimeConfig.get('ROTATION_SELL_THRESHOLD') as number;
    const buyThreshold = this.runtimeConfig.get('ROTATION_BUY_THRESHOLD') as number;
    const minDelta = this.runtimeConfig.get('MIN_ROTATION_SCORE_DELTA') as number;

    // Exclude grid-strategy assets from rotation
    const gridAssets = new Set(
      (discoveredAssetQueries.getActiveAssets.all(network) as DiscoveredAssetRow[])
        .filter(a => a.strategy === 'grid')
        .map(a => a.symbol)
    );

    // Sell candidates: held assets with score below threshold (excluding grid assets)
    const sellCandidates = scores.filter(s => s.isHeld && s.score < sellThreshold && !gridAssets.has(s.symbol));

    // Buy candidates: any asset with score above threshold
    const buyCandidates = scores.filter(s => s.score > buyThreshold);

    if (sellCandidates.length === 0 || buyCandidates.length === 0) return null;

    // Find best pair: highest (buy.score - sell.score) with delta > minDelta
    let bestPair: { sell: OpportunityScore; buy: OpportunityScore } | null = null;
    let bestDelta = -Infinity;

    for (const sell of sellCandidates) {
      for (const buy of buyCandidates) {
        if (buy.symbol === sell.symbol) continue;
        const delta = buy.score - sell.score;
        if (delta > minDelta && delta > bestDelta) {
          bestDelta = delta;
          bestPair = { sell, buy };
        }
      }
    }

    return bestPair;
  }

  async tick(network: string): Promise<void> {
    // 1. Compute scores
    const scores = this.computeScores(network);
    this.latestScores = scores;

    // 2. Update daily PnL high water
    let totalPortfolioUsd = 0;
    for (const s of scores) {
      const balance = botState.assetBalances.get(s.symbol) ?? 0;
      let price = 0;
      if (s.symbol === 'USDC') price = 1;
      else if (s.symbol === 'ETH') price = botState.lastPrice ?? 0;
      else {
        const candles = this.candleService.getStoredCandles(s.symbol, network, '15m', 1);
        price = candles.length > 0 ? candles[0].close : 0;
      }
      totalPortfolioUsd += balance * price;
    }

    const today = new Date().toISOString().slice(0, 10);
    const countRow = rotationQueries.getTodayRotationCount.get(network) as { cnt: number } | undefined;
    const todayCount = countRow?.cnt ?? 0;

    dailyPnlQueries.upsertDailyPnl.run({
      date: today,
      network,
      high_water: totalPortfolioUsd,
      current_usd: totalPortfolioUsd,
      rotations: todayCount,
      realized_pnl: 0,
    });

    // 3. Risk-off check: all scores < RISK_OFF_THRESHOLD
    const riskOffThreshold = this.runtimeConfig.get('RISK_OFF_THRESHOLD') as number;
    const riskOnThreshold = this.runtimeConfig.get('RISK_ON_THRESHOLD') as number;

    const allBelowRiskOff = scores.length > 0 && scores.every(s => s.score < riskOffThreshold);
    const anyAboveRiskOn = scores.some(s => s.score > riskOnThreshold);

    if (allBelowRiskOff && !this._riskOff) {
      this._riskOff = true;
      logger.warn('PortfolioOptimizer: entering RISK-OFF mode — all scores below threshold');
      botState.emitAlert('RISK-OFF mode activated: all asset scores below threshold');
    }

    // 4. Risk-on check
    if (anyAboveRiskOn && this._riskOff) {
      this._riskOff = false;
      logger.info('PortfolioOptimizer: exiting RISK-OFF mode — score above threshold detected');
      botState.emitAlert('RISK-OFF mode deactivated: opportunity detected');
    }

    // 5. If risk-off, skip rotation logic
    if (this._riskOff) {
      logger.debug('PortfolioOptimizer: risk-off active, skipping rotation');
      return;
    }

    // 6. Find rotation candidate
    const candidate = this.findRotationCandidate(scores, network);
    if (!candidate) {
      logger.debug('PortfolioOptimizer: no rotation candidate found');
      return;
    }

    // 7. Estimate fees
    const estimatedFeePct = this.runtimeConfig.get('DEFAULT_FEE_ESTIMATE_PCT') as number;
    const estimatedGainPct = candidate.buy.score - candidate.sell.score;
    const sellUsdValue = (botState.assetBalances.get(candidate.sell.symbol) ?? 0) *
      (candidate.sell.symbol === 'USDC' ? 1 :
        candidate.sell.symbol === 'ETH' ? (botState.lastPrice ?? 0) : 0);
    const sellAmount = sellUsdValue * 0.1; // rotate 10% of held position

    // 8. Check RiskGuard
    const proposal = {
      sellSymbol: candidate.sell.symbol,
      buySymbol: candidate.buy.symbol,
      sellAmount,
      estimatedGainPct,
      estimatedFeePct,
      buyTargetWeightPct: candidate.buy.currentWeight + (sellAmount / (totalPortfolioUsd || 1)) * 100,
    };

    const decision = this.riskGuard.checkRotation(proposal, network, totalPortfolioUsd);

    if (!decision.approved) {
      logger.info(`PortfolioOptimizer: rotation vetoed — ${decision.vetoReason}`);
      rotationQueries.insertRotation.run({
        sell_symbol: candidate.sell.symbol,
        buy_symbol: candidate.buy.symbol,
        sell_amount: sellAmount,
        estimated_gain_pct: estimatedGainPct,
        estimated_fee_pct: estimatedFeePct,
        dry_run: (this.runtimeConfig.get('DRY_RUN') as boolean) ? 1 : 0,
        network,
      });
      return;
    }

    // 9. Execute rotation
    const actualAmount = decision.adjustedAmount ?? sellAmount;

    if (typeof (this.executor as any).executeRotation === 'function') {
      await (this.executor as any).executeRotation(
        candidate.sell.symbol,
        candidate.buy.symbol,
        actualAmount,
      );
    } else {
      logger.info(
        `PortfolioOptimizer: rotation ${candidate.sell.symbol} → ${candidate.buy.symbol} ` +
        `$${actualAmount.toFixed(2)} (executeRotation not yet implemented)`,
      );
    }

    // 10. Record rotation in DB
    rotationQueries.insertRotation.run({
      sell_symbol: candidate.sell.symbol,
      buy_symbol: candidate.buy.symbol,
      sell_amount: actualAmount,
      estimated_gain_pct: estimatedGainPct,
      estimated_fee_pct: estimatedFeePct,
      dry_run: (this.runtimeConfig.get('DRY_RUN') as boolean) ? 1 : 0,
      network,
    });

    logger.info(
      `PortfolioOptimizer: rotation recorded — sell ${candidate.sell.symbol} → buy ${candidate.buy.symbol} $${actualAmount.toFixed(2)}`,
    );
  }
}
