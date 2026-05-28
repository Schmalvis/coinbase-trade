import { CandleService } from '../services/candles.js';
import { CandleStrategy, type CandleSignal } from '../strategy/candle.js';
import { RiskGuard } from './risk-guard.js';
import type { TradeExecutor } from './executor.js';
import { botState } from '../core/state.js';
import { logger } from '../core/logger.js';
import type { RuntimeConfig } from '../core/runtime-config.js';
import { assetsForNetwork } from '../assets/registry.js';
import { queries, rotationQueries, dailyPnlQueries, discoveredAssetQueries, watchlistQueries, runTransaction } from '../data/db.js';
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

export interface ScoreInputs {
  symbols: Iterable<string>;
  balances: Map<string, number>;
  prices: Map<string, number>;
}

const HOLD_SIGNAL: CandleSignal = { signal: 'hold', strength: 0, reason: 'no data' };

export class PortfolioOptimizer {
  private latestScores: OpportunityScore[] = [];
  private _riskOff = false;
  private readonly _rotationCooldowns = new Map<string, number>();
  private readonly SAME_PAIR_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

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

  private fetchScoreInputs(network: string): ScoreInputs {
    const symbolSet = new Set<string>();

    // 1. Static registry assets
    for (const asset of assetsForNetwork(network)) {
      symbolSet.add(asset.symbol);
    }

    // 2. Discovered active assets
    const activeAssets = discoveredAssetQueries.getActiveAssets.all(network) as DiscoveredAssetRow[];
    for (const a of activeAssets) { symbolSet.add(a.symbol); }

    // 3. Watchlist
    const watchlist = watchlistQueries.getWatchlist.all(network);
    for (const w of watchlist) { symbolSet.add(w.symbol); }

    const balances = new Map<string, number>();
    const prices   = new Map<string, number>();

    for (const sym of symbolSet) {
      balances.set(sym, botState.assetBalances.get(sym) ?? 0);
      let price = 0;
      if (sym === 'USDC') {
        price = 1;
      } else if (sym === 'ETH') {
        price = botState.lastPrice ?? 0;
      } else {
        const candles = this.candleService.getStoredCandles(sym, network, '15m', 1);
        price = candles.length > 0 ? candles[0].close : 0;
      }
      prices.set(sym, price);
    }

    return { symbols: symbolSet, balances, prices };
  }

  computeScores(network: string, inputs?: ScoreInputs): OpportunityScore[] {
    const { symbols, balances, prices } = inputs ?? this.fetchScoreInputs(network);

    // Compute total portfolio USD for weight calculation
    let totalPortfolioUsd = 0;
    const assetUsdValues = new Map<string, number>();

    for (const sym of symbols) {
      const usdValue = (balances.get(sym) ?? 0) * (prices.get(sym) ?? 0);
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

      const raw =
        direction(signal15m) * signal15m.strength * 0.5 +
        direction(signal1h)  * signal1h.strength  * 0.3 +
        direction(signal24h) * signal24h.strength * 0.2;

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
        const avgVolume = volWindow.reduce((s, c) => s + c.volume, 0) / volWindow.length;
        if (avgVolume > 0 && latestVolume > 1.5 * avgVolume) {
          score += score >= 0 ? 10 : -10;
        }
      }

      // Clamp to [-100, 100]
      score = Math.max(-100, Math.min(100, score));

      const usdValue = assetUsdValues.get(sym) ?? 0;
      const currentWeight = totalPortfolioUsd > 0 ? (usdValue / totalPortfolioUsd) * 100 : 0;
      // Require >$2 USD value to be considered "held" — avoids dust triggering sell candidates
      const isHeld = usdValue >= 2;

      logger.debug(
        `[optimizer] ${sym}: score=${score.toFixed(1)} confidence=${confidence.toFixed(2)} ` +
        `candles=15m:${candles15m.length}/1h:${candles1h.length}/24h:${candles24h.length} ` +
        `signals=${signal15m.signal}(${signal15m.strength})/` +
        `${signal1h.signal}(${signal1h.strength})/` +
        `${signal24h.signal}(${signal24h.strength})`,
      );

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
        isHeld,
      });
    }

    return scores;
  }

  findRotationCandidate(
    scores: OpportunityScore[],
    network: string,
    totalPortfolioUsd: number,
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

    // Sell candidates: held assets with score below threshold (excluding grid assets).
    // USDC is also a valid sell candidate when a non-USDC asset scores above buy threshold —
    // this enables USDC → strong-asset rotations when the market turns bullish.
    // Skip dust positions (< $2) — too small to route and cause phantom position-limit vetoes.
    const MIN_ROTATION_SELL_USD = 2;
    const hasStrongBuyCandidate = scores.some(s => s.symbol !== 'USDC' && s.score > buyThreshold);
    const sellCandidates = scores.filter(s =>
      s.isHeld &&
      !gridAssets.has(s.symbol) &&
      (s.currentWeight / 100 * totalPortfolioUsd) >= MIN_ROTATION_SELL_USD &&
      (s.score < sellThreshold || (s.symbol === 'USDC' && hasStrongBuyCandidate))
    );

    // Buy candidates: any asset with score above threshold, OR USDC (always valid defensive rotation target)
    const buyCandidates = scores.filter(s => s.score > buyThreshold || s.symbol === 'USDC');

    if (sellCandidates.length === 0 || buyCandidates.length === 0) return null;

    // Find best pair: highest (buy.score - sell.score) with delta > minDelta
    let bestPair: { sell: OpportunityScore; buy: OpportunityScore } | null = null;
    let bestDelta = -Infinity;

    for (const sell of sellCandidates) {
      for (const buy of buyCandidates) {
        if (buy.symbol === sell.symbol) continue;
        const delta = buy.score - sell.score;
        if (delta <= minDelta || delta <= bestDelta) continue;
        // Same-pair cooldown: skip if this pair (or its reverse) was rotated recently
        const pairKey = `${sell.symbol}->${buy.symbol}`;
        const revKey = `${buy.symbol}->${sell.symbol}`;
        const lastPair = this._rotationCooldowns.get(pairKey) ?? 0;
        const lastRev = this._rotationCooldowns.get(revKey) ?? 0;
        if (Date.now() - Math.max(lastPair, lastRev) < this.SAME_PAIR_COOLDOWN_MS) continue;
        bestDelta = delta;
        bestPair = { sell, buy };
      }
    }

    return bestPair;
  }

  findRebalanceCandidate(
    scores: OpportunityScore[],
    network: string,
  ): { sell: OpportunityScore; buy: OpportunityScore } | null {
    const maxPosPct = this.runtimeConfig.get('MAX_POSITION_PCT') as number;

    const gridAssets = new Set(
      (discoveredAssetQueries.getActiveAssets.all(network) as DiscoveredAssetRow[])
        .filter(a => a.strategy === 'grid')
        .map(a => a.symbol)
    );

    const overCapAssets = scores.filter(
      s => s.isHeld && s.symbol !== 'USDC' && s.currentWeight > maxPosPct && !gridAssets.has(s.symbol)
    );

    if (overCapAssets.length === 0) return null;

    const usdcScore = scores.find(s => s.symbol === 'USDC');
    if (!usdcScore) return null;

    // Pick the most over-cap asset
    const worstOverCap = [...overCapAssets].sort((a, b) => b.currentWeight - a.currentWeight)[0];

    logger.info(
      `[optimizer] Rebalance: ${worstOverCap.symbol} at ${worstOverCap.currentWeight.toFixed(1)}% ` +
      `> ${maxPosPct}% limit — rotating excess to USDC`
    );
    return { sell: worstOverCap, buy: usdcScore };
  }

  async tick(network: string): Promise<void> {
    // 1. Compute scores
    const scores = this.computeScores(network);
    this.latestScores = scores;

    // 2. Update daily PnL high water — use authoritative portfolio_snapshot value
    const latestSnap = (queries.recentPortfolioSnapshots.all(1) as { portfolio_usd: number }[])[0];
    const totalPortfolioUsd = latestSnap?.portfolio_usd ?? 0;

    const realizedRow = queries.todayRealizedPnl.get(network) as { total: number } | undefined;
    const todayRealized = realizedRow?.total ?? 0;

    const today = new Date().toISOString().slice(0, 10);
    const countRow = rotationQueries.getTodayRotationCount.get(network) as { cnt: number } | undefined;
    const todayCount = countRow?.cnt ?? 0;

    dailyPnlQueries.upsertDailyPnl.run({
      date: today,
      network,
      high_water: totalPortfolioUsd,
      current_usd: totalPortfolioUsd,
      rotations: todayCount,
      realized_pnl: todayRealized,
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

    // 6. Find rotation candidate (fall back to rebalance if over-cap with no normal candidate)
    const rotationCandidate = this.findRotationCandidate(scores, network, totalPortfolioUsd);
    const rebalanceCandidate = rotationCandidate ? null : this.findRebalanceCandidate(scores, network);
    const candidate = rotationCandidate ?? rebalanceCandidate;
    const isRebalance = !rotationCandidate && rebalanceCandidate !== null;

    if (!candidate) {
      const sellThreshold = this.runtimeConfig.get('ROTATION_SELL_THRESHOLD') as number;
      const buyThreshold = this.runtimeConfig.get('ROTATION_BUY_THRESHOLD') as number;
      const minDelta = this.runtimeConfig.get('MIN_ROTATION_SCORE_DELTA') as number;
      const topScores = scores
        .map(s => `${s.symbol}:${s.score.toFixed(0)}${s.isHeld ? '*' : ''}`)
        .join(' ');
      logger.info(`[optimizer] no candidate — scores: [${topScores}] (need sell<${sellThreshold} buy>${buyThreshold} Δ>${minDelta})`);
      return;
    }

    // 7. Estimate fees — multiply by 2 to cover both rotation legs (sell + buy)
    const estimatedFeePct = (this.runtimeConfig.get('DEFAULT_FEE_ESTIMATE_PCT') as number) * 2;
    const rawScoreDelta = candidate.buy.score - candidate.sell.score;
    // Estimate gain from buy candidate's recent price momentum (last 5 x 15m candles)
    const buyCandles5 = this.candleService.getStoredCandles(candidate.buy.symbol, network, '15m', 6);
    // Gross gain proxy: each score point ≈ 0.1% expected edge (no fee subtraction — fees are
    // checked separately by the profit gate and fee-ratio check in RiskGuard).
    let estimatedGainPct = rawScoreDelta * 0.1;
    if (buyCandles5.length >= 2) {
      const newest = buyCandles5[0].close;
      const oldest = buyCandles5[buyCandles5.length - 1].close;
      if (oldest > 0) {
        // Blend with capped momentum (30% weight) — avoids extrapolating recent runs
        const momentumPct = ((newest - oldest) / oldest) * 100;
        estimatedGainPct = Math.max(estimatedGainPct, estimatedGainPct * 0.7 + momentumPct * 0.3);
      }
    }
    let sellPrice = 0;
    if (candidate.sell.symbol === 'USDC') sellPrice = 1;
    else if (candidate.sell.symbol === 'ETH') sellPrice = botState.lastPrice ?? 0;
    else {
      const snap = (queries.recentAssetSnapshots.all(candidate.sell.symbol, 1) as any[])[0];
      sellPrice = snap?.price_usd ?? 0;
    }
    const sellUsdValue = (botState.assetBalances.get(candidate.sell.symbol) ?? 0) * sellPrice;
    const maxPosPctForSizing = this.runtimeConfig.get('MAX_POSITION_PCT') as number;
    const sellAmount = isRebalance
      ? Math.max(0, (candidate.sell.currentWeight - maxPosPctForSizing) / 100 * totalPortfolioUsd)
      : sellUsdValue * ((this.runtimeConfig.get('ROTATION_SIZE_PCT') as number) / 100);

    // Rebalance excess too small to clear the executor's $2 min-trade floor — skip silently
    if (isRebalance && sellAmount < 2) {
      logger.debug(`[optimizer] Rebalance too small ($${sellAmount.toFixed(2)}) — excess below $2 min, waiting`);
      return;
    }

    // 8. Check RiskGuard
    const proposal = {
      sellSymbol: candidate.sell.symbol,
      buySymbol: candidate.buy.symbol,
      sellAmount,
      estimatedGainPct,
      estimatedFeePct,
      buyTargetWeightPct: candidate.buy.currentWeight + (sellAmount / (totalPortfolioUsd || 1)) * 100,
      isRebalance,
    };

    const decision = this.riskGuard.checkRotation(proposal, network, totalPortfolioUsd);

    if (!decision.approved) {
      logger.info(`PortfolioOptimizer: rotation vetoed — ${decision.vetoReason}`);
      const vetoResult = rotationQueries.insertRotation.run({
        sell_symbol: candidate.sell.symbol,
        buy_symbol: candidate.buy.symbol,
        sell_amount: sellAmount,
        estimated_gain_pct: estimatedGainPct,
        estimated_fee_pct: estimatedFeePct,
        dry_run: (this.runtimeConfig.get('DRY_RUN') as boolean) ? 1 : 0,
        network,
      });
      rotationQueries.updateRotation.run({
        id: Number(vetoResult.lastInsertRowid),
        status: 'vetoed',
        buy_amount: null,
        sell_tx_hash: null,
        buy_tx_hash: null,
        actual_gain_pct: null,
        veto_reason: decision.vetoReason ?? null,
      });
      return;
    }

    // 9. Execute rotation
    const actualAmount = decision.adjustedAmount ?? sellAmount;

    // Record cooldown for this pair before executing (prevents double-fire if tick overlaps)
    const cooldownKey = `${candidate.sell.symbol}->${candidate.buy.symbol}`;
    this._rotationCooldowns.set(cooldownKey, Date.now());
    // Prune expired cooldowns
    for (const [k, t] of this._rotationCooldowns) {
      if (Date.now() - t > this.SAME_PAIR_COOLDOWN_MS) this._rotationCooldowns.delete(k);
    }

    // 10. Insert rotation record before executing (so we have an ID to update)
    const insertResult = rotationQueries.insertRotation.run({
      sell_symbol: candidate.sell.symbol,
      buy_symbol: candidate.buy.symbol,
      sell_amount: actualAmount,
      estimated_gain_pct: estimatedGainPct,
      estimated_fee_pct: estimatedFeePct,
      dry_run: (this.runtimeConfig.get('DRY_RUN') as boolean) ? 1 : 0,
      network,
    });
    const rotationId = Number(insertResult.lastInsertRowid);

    let rotationResult: { status: string; sellTxHash?: string | null; buyTxHash?: string | null; actualBuyUsd?: number } | null = null;
    if (typeof (this.executor as any).executeRotation === 'function') {
      rotationResult = await (this.executor as any).executeRotation(
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

    // Update rotation status based on execution result
    if (rotationResult) {
      const actualGainPct = rotationResult.status === 'executed' && rotationResult.actualBuyUsd != null && actualAmount > 0
        ? (rotationResult.actualBuyUsd / actualAmount - 1) * 100
        : null;
      rotationQueries.updateRotation.run({
        id: rotationId,
        status: rotationResult.status === 'executed' ? 'executed'
          : rotationResult.status === 'leg1_done' ? 'leg1_done'
          : 'failed',
        buy_amount: rotationResult.actualBuyUsd ?? null,
        sell_tx_hash: rotationResult.sellTxHash ?? null,
        buy_tx_hash: rotationResult.buyTxHash ?? null,
        actual_gain_pct: actualGainPct,
        veto_reason: null,
      });
    }

    // Update daily PnL atomically
    runTransaction(() => {
      dailyPnlQueries.upsertDailyPnl.run({
        date: today,
        network,
        high_water: totalPortfolioUsd,
        current_usd: totalPortfolioUsd,
        rotations: todayCount + 1,
        realized_pnl: todayRealized,
      });
    });

    logger.info(
      `PortfolioOptimizer: rotation recorded — sell ${candidate.sell.symbol} → buy ${candidate.buy.symbol} $${actualAmount.toFixed(2)}`,
    );
  }
}
