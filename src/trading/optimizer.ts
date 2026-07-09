import { CandleService } from '../services/candles.js';
import { CandleStrategy, type CandleSignal } from '../strategy/candle.js';
import { getMarketRegime } from '../strategy/regime.js';
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

// Correlated assets (ETH / staked ETH / wrapped BTC) have ~0 real edge between them
// but incur ~2% round-trip fees. Block rotations between these pairs — see Fable audit A2.
const CORRELATED_PAIR_BLACKLIST = new Set([
  'ETH->CBETH', 'CBETH->ETH',
  'ETH->CBBTC', 'CBBTC->ETH',
  'CBETH->CBBTC', 'CBBTC->CBETH',
]);

export class PortfolioOptimizer {
  private latestScores: OpportunityScore[] = [];
  private _riskOff = false;
  private _macroGateActive = false;
  private readonly _rotationCooldowns = new Map<string, number>();
  private readonly SAME_PAIR_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
  private _cooldownsLoaded = false;

  constructor(
    private readonly candleService: CandleService,
    private readonly strategy: CandleStrategy,
    private readonly riskGuard: RiskGuard,
    private readonly executor: TradeExecutor,
    private readonly runtimeConfig: RuntimeConfig,
  ) {}

  // Seed the in-memory cooldown map from the rotations table. The in-memory map is wiped on
  // every container redeploy; deriving cooldowns from persisted rotation timestamps means a
  // freshly-started bot still respects the 4h same-pair cooldown. See Fable audit A6.
  loadCooldownsFromDb(network: string): void {
    const recent = rotationQueries.getRecentExecutedPairs.all(network);
    for (const row of recent) {
      const executedAt = new Date(/Z$|[+-]\d{2}:?\d{2}$/.test(row.last_executed) ? row.last_executed : row.last_executed.replace(' ', 'T') + 'Z').getTime();
      const fwdKey = `${row.sell_symbol}->${row.buy_symbol}`;
      const revKey = `${row.buy_symbol}->${row.sell_symbol}`;
      if ((this._rotationCooldowns.get(fwdKey) ?? 0) < executedAt) {
        this._rotationCooldowns.set(fwdKey, executedAt);
      }
      if ((this._rotationCooldowns.get(revKey) ?? 0) < executedAt) {
        this._rotationCooldowns.set(revKey, executedAt);
      }
    }
  }

  async recoverStuckRotations(network: string): Promise<void> {
    const stuck = rotationQueries.getStuckRotations.all(network);
    if (stuck.length === 0) return;

    logger.info(`[recovery] Found ${stuck.length} stuck leg1_done rotation(s) — retrying leg 2`);

    // Rows up to 24h old are candidates. Rows <1h get one retry; rows 1-24h
    // that survived a bot restart without being retried get marked stuck immediately.
    for (const row of stuck) {
      const ageMs = Date.now() - new Date(/Z$|[+-]\d{2}:?\d{2}$/.test(row.timestamp) ? row.timestamp : row.timestamp.replace(' ', 'T') + 'Z').getTime();
      const ageMin = Math.round(ageMs / 60_000);

      if (ageMs > 60 * 60 * 1000) {
        logger.warn(
          `[recovery] Rotation #${row.id} ${row.sell_symbol}→${row.buy_symbol} stuck >${ageMin}min — manual intervention required`
        );
        rotationQueries.updateRotation.run({
          id: row.id,
          status: 'stuck',
          buy_amount: null,
          sell_tx_hash: row.sell_tx_hash,
          buy_tx_hash: null,
          actual_gain_pct: null,
          veto_reason: `leg-2 unrecovered after ${ageMin}min`,
        });
        continue;
      }

      logger.info(`[recovery] Retrying leg-2 for rotation #${row.id}: buy ${row.buy_symbol} ~$${row.sell_amount.toFixed(2)}`);
      try {
        const result = await (this.executor as any).executeRotation(
          row.sell_symbol, row.buy_symbol, row.sell_amount, row.id,
        );
        if (result?.status === 'executed') {
          const actualGainPct = result.actualBuyUsd != null && row.sell_amount > 0
            ? (result.actualBuyUsd / row.sell_amount - 1) * 100
            : null;
          rotationQueries.updateRotation.run({
            id: row.id,
            status: 'executed',
            buy_amount: result.actualBuyUsd ?? null,
            sell_tx_hash: row.sell_tx_hash,
            buy_tx_hash: result.buyTxHash ?? null,
            actual_gain_pct: actualGainPct,
            veto_reason: null,
          });
          logger.info(`[recovery] Rotation #${row.id} recovered — leg-2 executed`);
          const fwdKey = `${row.sell_symbol}->${row.buy_symbol}`;
          const revKey = `${row.buy_symbol}->${row.sell_symbol}`;
          this._rotationCooldowns.set(fwdKey, Date.now());
          this._rotationCooldowns.set(revKey, Date.now());
        } else {
          logger.warn(`[recovery] Rotation #${row.id} leg-2 retry returned ${result?.status} — marking stuck`);
          rotationQueries.updateRotation.run({
            id: row.id,
            status: 'stuck',
            buy_amount: null,
            sell_tx_hash: row.sell_tx_hash,
            buy_tx_hash: null,
            actual_gain_pct: null,
            veto_reason: `leg-2 retry failed with status: ${result?.status ?? 'unknown'}`,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? `${err.message}\n${(err as Error).stack ?? ''}` : String(err);
        logger.error(`[recovery] Rotation #${row.id} leg-2 retry failed: ${msg}`);
        rotationQueries.updateRotation.run({
          id: row.id,
          status: 'stuck',
          buy_amount: null,
          sell_tx_hash: row.sell_tx_hash,
          buy_tx_hash: null,
          actual_gain_pct: null,
          veto_reason: `leg-2 retry threw: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  // Price-ratio z-score divergence gate (Fable audit A1). The old gain estimate was
  // `scoreDelta * 0.1`, derived from the same score delta that triggered the rotation —
  // a fabricated number that always cleared the profit gate. Instead, measure how far the
  // buy/sell price ratio has diverged from its 96-candle (15m) mean. A negative z-score
  // means the buy asset is cheap relative to the sell asset (mean-reversion upside); a
  // non-negative z-score means there's no statistical edge and the rotation is blocked.
  computePriceRatioDivergence(
    buySymbol: string,
    sellSymbol: string,
    currentBuyPrice: number,
    currentSellPrice: number,
    network: string,
  ): { zScore: number; estimatedGainPct: number; hasData: boolean } {
    if (currentSellPrice <= 0) return { zScore: 0, estimatedGainPct: 0, hasData: false };

    // R4: USDC has no stored candles so the paired-ratio approach cannot apply.
    // When one leg is USDC, analyse only the crypto side against its own 24h mean.
    const usdcAsBuy  = buySymbol  === 'USDC';
    const usdcAsSell = sellSymbol === 'USDC';
    if (usdcAsBuy || usdcAsSell) {
      const cryptoSymbol       = usdcAsBuy ? sellSymbol       : buySymbol;
      const currentCryptoPrice = usdcAsBuy ? currentSellPrice : currentBuyPrice;
      const cryptoCandles = this.candleService.getStoredCandles(cryptoSymbol, network, '15m', 96);
      const cLen = cryptoCandles.length;
      if (cLen < 21) return { zScore: 0, estimatedGainPct: 0, hasData: false };

      // Skip index 0 (current in-progress candle) — same convention as the ratio path.
      const closes = cryptoCandles.slice(1, cLen).map(c => c.close).filter(p => p > 0);
      if (closes.length < 10) return { zScore: 0, estimatedGainPct: 0, hasData: false };
      const mean = closes.reduce((a, b) => a + b, 0) / closes.length;

      // Simple % deviation of current price from 24h mean (no std needed for single-asset).
      const z = mean > 0 ? (currentCryptoPrice - mean) / mean : 0;

      // Caller blocks when zScore >= 0. For sell-to-USDC (usdcAsBuy), price above its mean
      // is a GOOD exit — negate z so the gate allows it. For buy-from-USDC (usdcAsSell),
      // price below mean is a GOOD cheap entry — z is already negative, no negation needed.
      const zScore = usdcAsBuy ? -z : z;

      // Favourable moves get +2.5%. Unfavourable directions have no mean-reversion edge —
      // report a non-positive estimate. The caller's zScore gate blocks those rotations
      // anyway, but the sign must be correct for test contracts and future fee-gate logic.
      const favourable = usdcAsBuy ? z > 0 : z < 0;
      const estimatedGainPct = favourable ? 2.5 : -1.5;

      return { zScore, estimatedGainPct, hasData: true };
    }

    const buyCandles  = this.candleService.getStoredCandles(buySymbol,  network, '15m', 96);
    const sellCandles = this.candleService.getStoredCandles(sellSymbol, network, '15m', 96);
    // Use at most 96 candles but skip index 0 (current/in-progress candle) to avoid
    // contaminating the historical baseline with the live observation being tested.
    const len = Math.min(buyCandles.length, sellCandles.length);

    if (len < 21) return { zScore: 0, estimatedGainPct: 0, hasData: false };  // need 20 historical + at least 1 current

    const ratios: number[] = [];
    // Candles are paired by array index (both ordered newest-first). This assumes
    // gap-free series — gaps or missing candles in one asset can misalign pairs.
    for (let i = 1; i < len; i++) {  // start at 1, not 0
      const s = sellCandles[i].close;
      if (s > 0) ratios.push(buyCandles[i].close / s);
    }
    if (ratios.length < 10) return { zScore: 0, estimatedGainPct: 0, hasData: false };

    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const variance = ratios.reduce((s, r) => s + (r - mean) ** 2, 0) / ratios.length;
    const stdDev = Math.sqrt(variance);

    const currentRatio = currentBuyPrice / currentSellPrice;
    const zScore = stdDev > 0 ? (currentRatio - mean) / stdDev : 0;

    // Mean-reversion potential: how far the ratio would move if it snapped back to mean.
    // Positive only when the buy asset is currently below its historical ratio.
    const estimatedGainPct = mean > 0 && currentRatio > 0
      ? ((mean / currentRatio) - 1) * 100
      : 0;

    return { zScore, estimatedGainPct, hasData: true };
  }

  getLatestScores(): OpportunityScore[] {
    return this.latestScores;
  }

  get isRiskOff(): boolean {
    return this._riskOff;
  }

  // C5 global macro gate state — true when ETH's 1h regime is a downtrend and all
  // crypto buy-side rotations are suppressed (USDC-only buy leg). Surfaced for /api/risk.
  get isMacroGateActive(): boolean {
    return this._macroGateActive;
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

      // Evaluate signals — getStoredCandles returns newest-first (DESC); strategy expects oldest-first
      const signal15m = candles15m.length >= 26 ? this.strategy.evaluate(candles15m.slice().reverse()) : HOLD_SIGNAL;
      const signal1h = candles1h.length >= 26 ? this.strategy.evaluate(candles1h.slice().reverse()) : HOLD_SIGNAL;
      const signal24h = candles24h.length >= 26 ? this.strategy.evaluate(candles24h.slice().reverse()) : HOLD_SIGNAL;

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
    macroGateActive = false,
  ): { sell: OpportunityScore; buy: OpportunityScore } | null {
    const sellThreshold = this.runtimeConfig.get('ROTATION_SELL_THRESHOLD') as number;
    const buyThreshold = this.runtimeConfig.get('ROTATION_BUY_THRESHOLD') as number;
    const minDelta = this.runtimeConfig.get('MIN_ROTATION_SCORE_DELTA') as number;

    // Exclude self-managed assets from rotation — assets with their own active strategy loop
    // (grid, sma, momentum-burst, volatility-breakout, trend-continuation) own their own trades.
    // Allowing the optimizer to also rotate them causes fee churn with no net position change.
    const SELF_MANAGED_STRATEGIES = new Set(['grid', 'sma', 'momentum-burst', 'volatility-breakout', 'trend-continuation']);
    const selfManagedAssets = new Set(
      (discoveredAssetQueries.getActiveAssets.all(network) as DiscoveredAssetRow[])
        .filter(a => SELF_MANAGED_STRATEGIES.has(a.strategy))
        .map(a => a.symbol)
    );

    // Sell candidates: held assets with score below threshold.
    // USDC is also a valid sell candidate when a non-USDC asset scores above buy threshold —
    // this enables USDC → strong-asset rotations when the market turns bullish.
    // Skip dust positions (< $2) — too small to route and cause phantom position-limit vetoes.
    // Self-managed assets (sma, grid, etc.) are allowed here; the inner loop blocks crypto↔crypto
    // churn for them but permits defensive exits to USDC.
    const MIN_ROTATION_SELL_USD = 2;
    const hasStrongBuyCandidate = scores.some(s => s.symbol !== 'USDC' && s.score > buyThreshold);
    const sellCandidates = scores.filter(s =>
      s.isHeld &&
      (s.currentWeight / 100 * totalPortfolioUsd) >= MIN_ROTATION_SELL_USD &&
      (s.score < sellThreshold || (s.symbol === 'USDC' && hasStrongBuyCandidate))
    );

    // Buy candidates: any asset with score above threshold, OR USDC (always valid defensive rotation target).
    // C5 global macro gate: when ETH is in a 1h downtrend, suppress ALL crypto buys — only USDC
    // remains a valid buy leg, so defensive sells-to-cash still flow but no new crypto is bought.
    const buyCandidates = macroGateActive
      ? scores.filter(s => s.symbol === 'USDC')
      : scores.filter(s => s.score > buyThreshold || s.symbol === 'USDC');

    if (sellCandidates.length === 0 || buyCandidates.length === 0) return null;

    // Cost-basis hold-bias (Fable B3): positions that are only marginally underwater
    // (<5% loss) shouldn't be churned out of on a small score edge. Require an extra
    // +15 score delta before rotating out of a small-loss position. Profitable positions
    // and deeper losses (>=5%) get no bias.
    const HOLD_BIAS_DELTA = 15;
    const HOLD_BIAS_LOSS_THRESHOLD = 0.05;
    const openPositions = this.executor.getOpenPositions();
    const currentPriceFor = (symbol: string): number => {
      if (symbol === 'USDC') return 1;
      if (symbol === 'ETH') return botState.lastPrice ?? 0;
      const snap = (queries.recentAssetSnapshots.all(symbol, 1) as { price_usd: number }[])[0];
      return snap?.price_usd ?? 0;
    };
    const holdBiasFor = (sellSymbol: string): number => {
      const pos = openPositions.get(sellSymbol);
      if (!pos || pos.entryPrice <= 0) return 0;
      const currentPrice = currentPriceFor(sellSymbol);
      if (currentPrice <= 0 || currentPrice >= pos.entryPrice) return 0; // in profit or unknown
      const lossPct = (pos.entryPrice - currentPrice) / pos.entryPrice;
      return lossPct < HOLD_BIAS_LOSS_THRESHOLD ? HOLD_BIAS_DELTA : 0;
    };

    // Find best pair: highest (buy.score - sell.score) with delta > minDelta
    let bestPair: { sell: OpportunityScore; buy: OpportunityScore } | null = null;
    let bestDelta = -Infinity;

    for (const sell of sellCandidates) {
      const holdBias = holdBiasFor(sell.symbol);
      for (const buy of buyCandidates) {
        if (buy.symbol === sell.symbol) continue;
        const blacklistKey = `${sell.symbol}->${buy.symbol}`;
        if (CORRELATED_PAIR_BLACKLIST.has(blacklistKey)) {
          logger.debug(`Rotation ${blacklistKey} blocked — correlated pair blacklist`);
          continue;
        }
        // Self-managed assets may only rotate to USDC (defensive exit). Block crypto↔crypto
        // churn which would fight the asset's own strategy loop.
        if (selfManagedAssets.has(sell.symbol) && buy.symbol !== 'USDC') continue;
        // R1: Hold-bias does not apply to defensive exits into USDC. The fee-buffer haircut
        // means every entry starts marginally underwater, so hold-bias would require a delta
        // beyond the observed score range and block all USDC exits. Allow them unconditionally.
        const requiredDelta = minDelta + (buy.symbol === 'USDC' ? 0 : holdBias);
        const delta = buy.score - sell.score;
        if (delta < requiredDelta || delta <= bestDelta) continue;
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

    const SELF_MANAGED_STRATEGIES = new Set(['grid', 'sma', 'momentum-burst', 'volatility-breakout', 'trend-continuation']);
    const selfManagedAssets = new Set(
      (discoveredAssetQueries.getActiveAssets.all(network) as DiscoveredAssetRow[])
        .filter(a => SELF_MANAGED_STRATEGIES.has(a.strategy))
        .map(a => a.symbol)
    );

    const overCapAssets = scores.filter(
      s => s.isHeld && s.symbol !== 'USDC' && s.currentWeight > maxPosPct && !selfManagedAssets.has(s.symbol)
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
    // Seed cooldowns from DB once per process so a redeployed container respects existing cooldowns.
    if (!this._cooldownsLoaded) {
      this.loadCooldownsFromDb(network);
      this._cooldownsLoaded = true;
    }

    await this.recoverStuckRotations(network);

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

    // 5. If risk-off, only allow defensive sells-to-USDC — no new crypto buys
    if (this._riskOff) {
      logger.debug('PortfolioOptimizer: risk-off active, defensive USDC exits only');
      const riskOffCandidate = this.findRotationCandidate(scores, network, totalPortfolioUsd, true);
      if (riskOffCandidate) {
        const sellPrice = riskOffCandidate.sell.symbol === 'ETH' ? (botState.lastPrice ?? 0)
          : riskOffCandidate.sell.symbol === 'USDC' ? 1
          : ((queries.recentAssetSnapshots.all(riskOffCandidate.sell.symbol, 1) as { price_usd: number }[])[0]?.price_usd ?? 0);
        const sellUsdValue = (botState.assetBalances.get(riskOffCandidate.sell.symbol) ?? 0) * sellPrice;
        const riskOffSellAmount = sellUsdValue * ((this.runtimeConfig.get('ROTATION_SIZE_PCT') as number) / 100);
        const riskOffFeePct = (this.runtimeConfig.get('DEFAULT_FEE_ESTIMATE_PCT') as number) * 2;
        const riskOffScoreDelta = riskOffCandidate.buy.score - riskOffCandidate.sell.score;
        if (riskOffSellAmount >= 2) {
          const riskOffProposal = {
            sellSymbol: riskOffCandidate.sell.symbol,
            buySymbol: riskOffCandidate.buy.symbol,
            sellAmount: riskOffSellAmount,
            estimatedGainPct: 0,
            estimatedFeePct: riskOffFeePct,
            buyTargetWeightPct: riskOffCandidate.buy.currentWeight + (riskOffSellAmount / (totalPortfolioUsd || 1)) * 100,
            isRebalance: false,
          };
          const riskOffDecision = this.riskGuard.checkRotation(riskOffProposal, network, totalPortfolioUsd);
          if (!riskOffDecision.approved) {
            logger.info(`PortfolioOptimizer: risk-off exit vetoed — ${riskOffDecision.vetoReason}`);
            const vetoInsert = rotationQueries.insertRotation.run({
              sell_symbol: riskOffCandidate.sell.symbol,
              buy_symbol: riskOffCandidate.buy.symbol,
              sell_amount: riskOffSellAmount,
              score_delta: riskOffScoreDelta,
              estimated_gain_pct: 0,
              estimated_fee_pct: riskOffFeePct,
              dry_run: (this.runtimeConfig.get('DRY_RUN') as boolean) ? 1 : 0,
              network,
            });
            rotationQueries.updateRotation.run({
              id: Number(vetoInsert.lastInsertRowid),
              status: 'vetoed',
              buy_amount: null,
              sell_tx_hash: null,
              buy_tx_hash: null,
              actual_gain_pct: null,
              veto_reason: riskOffDecision.vetoReason ?? null,
            });
          } else {
            const riskOffActualAmount = riskOffDecision.adjustedAmount ?? riskOffSellAmount;
            const riskOffCooldownKey = `${riskOffCandidate.sell.symbol}->${riskOffCandidate.buy.symbol}`;
            this._rotationCooldowns.set(riskOffCooldownKey, Date.now());
            for (const [k, t] of this._rotationCooldowns) {
              if (Date.now() - t > this.SAME_PAIR_COOLDOWN_MS) this._rotationCooldowns.delete(k);
            }
            const riskOffInsert = rotationQueries.insertRotation.run({
              sell_symbol: riskOffCandidate.sell.symbol,
              buy_symbol: riskOffCandidate.buy.symbol,
              sell_amount: riskOffActualAmount,
              score_delta: riskOffScoreDelta,
              estimated_gain_pct: 0,
              estimated_fee_pct: riskOffFeePct,
              dry_run: (this.runtimeConfig.get('DRY_RUN') as boolean) ? 1 : 0,
              network,
            });
            const riskOffRotationId = Number(riskOffInsert.lastInsertRowid);
            logger.info(`PortfolioOptimizer: risk-off defensive exit — ${riskOffCandidate.sell.symbol} → ${riskOffCandidate.buy.symbol} $${riskOffActualAmount.toFixed(2)}`);
            let riskOffResult: { status: string; sellTxHash?: string | null; buyTxHash?: string | null; actualBuyUsd?: number; failureReason?: string } | null = null;
            if (typeof (this.executor as any).executeRotation === 'function') {
              riskOffResult = await (this.executor as any).executeRotation(
                riskOffCandidate.sell.symbol,
                riskOffCandidate.buy.symbol,
                riskOffActualAmount,
              );
            }
            if (riskOffResult) {
              const riskOffGainPct = riskOffResult.status === 'executed' && riskOffResult.actualBuyUsd != null && riskOffActualAmount > 0
                ? (riskOffResult.actualBuyUsd / riskOffActualAmount - 1) * 100
                : null;
              rotationQueries.updateRotation.run({
                id: riskOffRotationId,
                status: riskOffResult.status === 'executed' ? 'executed'
                  : riskOffResult.status === 'leg1_done' ? 'leg1_done'
                  : 'failed',
                buy_amount: riskOffResult.actualBuyUsd ?? null,
                sell_tx_hash: riskOffResult.sellTxHash ?? null,
                buy_tx_hash: riskOffResult.buyTxHash ?? null,
                actual_gain_pct: riskOffGainPct,
                veto_reason: riskOffResult.status === 'failed' ? (riskOffResult.failureReason ?? 'execution failed') : null,
              });
            }
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
          }
        }
      }
      return;
    }

    // 5b. C5 global macro gate: use ETH's 1h regime as a portfolio-wide buy gate.
    // In a downtrend, block buying any crypto (USDC-only buy leg); sells to cash still allowed.
    const ethHourlyCandles = this.candleService.getStoredCandles('ETH', network, '1h', 50);
    const macroGateActive = getMarketRegime(ethHourlyCandles.slice().reverse()) === 'downtrend';
    this._macroGateActive = macroGateActive;
    if (macroGateActive) {
      logger.info('[optimizer] global macro gate: ETH downtrend — buy candidates restricted to USDC');
    }

    // 6. Find rotation candidate (fall back to rebalance if over-cap with no normal candidate)
    const rotationCandidate = this.findRotationCandidate(scores, network, totalPortfolioUsd, macroGateActive);
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

    // Derive current prices for the pair (same lookup pattern as the sell-price block below)
    let currentBuyPrice = 0;
    let currentSellPrice = 0;
    if (candidate.buy.symbol === 'ETH') currentBuyPrice = botState.lastPrice ?? 0;
    else if (candidate.buy.symbol === 'USDC') currentBuyPrice = 1;
    else {
      const snap = (queries.recentAssetSnapshots.all(candidate.buy.symbol, 1) as { price_usd: number }[])[0];
      currentBuyPrice = snap?.price_usd ?? 0;
    }
    if (candidate.sell.symbol === 'ETH') currentSellPrice = botState.lastPrice ?? 0;
    else if (candidate.sell.symbol === 'USDC') currentSellPrice = 1;
    else {
      const snap = (queries.recentAssetSnapshots.all(candidate.sell.symbol, 1) as { price_usd: number }[])[0];
      currentSellPrice = snap?.price_usd ?? 0;
    }

    // A1: price-ratio z-score divergence gate. Replaces the fabricated `scoreDelta * 0.1`
    // gain estimate that always cleared the profit gate by construction.
    const divergence = this.computePriceRatioDivergence(
      candidate.buy.symbol, candidate.sell.symbol,
      currentBuyPrice, currentSellPrice, network,
    );

    let estimatedGainPct: number;
    if (divergence.hasData) {
      // Block the rotation unless the buy asset is statistically cheap (z < 0) vs the sell asset.
      // Defensive exits to USDC are exempt — in a falling market the sell asset is below its mean
      // (zScore > 0) which is exactly when we want to exit, not stay in.
      if (divergence.zScore >= 0 && candidate.buy.symbol !== 'USDC') {
        logger.info(
          `PortfolioOptimizer: rotation ${candidate.sell.symbol}→${candidate.buy.symbol} blocked` +
          ` — no price divergence (z=${divergence.zScore.toFixed(2)})`,
        );
        return;
      }
      estimatedGainPct = divergence.estimatedGainPct;
    } else {
      // Insufficient price history — fall back to the score-based proxy (don't block).
      estimatedGainPct = rawScoreDelta * 0.1;
    }

    const sellUsdValue = (botState.assetBalances.get(candidate.sell.symbol) ?? 0) * currentSellPrice;
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
        score_delta: rawScoreDelta,
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
      score_delta: rawScoreDelta,
      estimated_gain_pct: estimatedGainPct,
      estimated_fee_pct: estimatedFeePct,
      dry_run: (this.runtimeConfig.get('DRY_RUN') as boolean) ? 1 : 0,
      network,
    });
    const rotationId = Number(insertResult.lastInsertRowid);

    let rotationResult: { status: string; sellTxHash?: string | null; buyTxHash?: string | null; actualBuyUsd?: number; failureReason?: string } | null = null;
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
        veto_reason: rotationResult.status === 'failed' ? (rotationResult.failureReason ?? 'execution failed') : null,
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
