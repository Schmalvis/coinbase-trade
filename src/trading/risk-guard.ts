import { db, queries, dailyPnlQueries, rotationQueries } from '../data/db.js';
import { botState } from '../core/state.js';
import { logger } from '../core/logger.js';
import type { RuntimeConfig } from '../core/runtime-config.js';

/**
 * Returns a veto reason string if buying `buySymbol` for `buyAmountUsd`
 * would breach the combined memecoin cap, otherwise null.
 *
 * @param buySymbol - symbol being bought
 * @param buyAmountUsd - USD value of the intended buy
 * @param memePositions - map of memecoin symbol → current USD holding
 * @param portfolioUsd - total portfolio USD
 * @param capPct - combined memecoin cap (e.g. 20 for 20%)
 */
export function getMemecoincapVeto(
  buySymbol: string,
  buyAmountUsd: number,
  memePositions: Record<string, number>,
  portfolioUsd: number,
  capPct: number,
): string | null {
  const isMeme = Object.prototype.hasOwnProperty.call(memePositions, buySymbol);
  if (!isMeme) return null;
  if (portfolioUsd <= 0) return null;

  const currentMemeUsd = Object.values(memePositions).reduce((s, v) => s + v, 0);
  const afterBuyUsd = currentMemeUsd + buyAmountUsd;
  const afterBuyPct = (afterBuyUsd / portfolioUsd) * 100;

  if (afterBuyPct > capPct) {
    return `Memecoin cap breach: ${afterBuyPct.toFixed(1)}% > ${capPct}% (current: $${currentMemeUsd.toFixed(2)}, buying: $${buyAmountUsd.toFixed(2)})`;
  }
  return null;
}

export interface RotationProposal {
  sellSymbol: string;
  buySymbol: string;
  sellAmount: number;       // USD value
  estimatedGainPct: number;
  estimatedFeePct: number;
  buyTargetWeightPct: number; // what % of portfolio the buy asset would be after
  isRebalance?: boolean;    // true = risk-management trim, skip profit/fee gates
}

export interface RiskDecision {
  approved: boolean;
  adjustedAmount?: number;
  vetoReason?: string;
}

export class RiskGuard {
  constructor(private readonly runtimeConfig: RuntimeConfig) {}

  checkRotation(proposal: RotationProposal, network: string, portfolioUsd: number): RiskDecision {
    const detail = JSON.stringify({ ...proposal, network, portfolioUsd });

    // Only alert on the running → paused transition. checkRotation is called every
    // optimizer/asset tick, so emitting on every breach spams Telegram with identical
    // "trading paused" messages until the condition clears. The owner wants one alert
    // per state change, not a reminder every tick.
    const alreadyPaused = botState.isPaused;

    // 1. Portfolio floor
    const floor = this.runtimeConfig.get('PORTFOLIO_FLOOR_USD') as number;
    if (portfolioUsd < floor) {
      this.logDecision('risk_halt', `Portfolio floor breached: $${portfolioUsd} < $${floor}`);
      botState.setStatus('paused');
      if (!alreadyPaused) {
        botState.emitAlert(`PORTFOLIO FLOOR BREACHED ($${portfolioUsd.toFixed(2)} < $${floor}). ALL TRADING HALTED.`);
      }
      return { approved: false, vetoReason: `Portfolio floor breached ($${portfolioUsd} < $${floor})` };
    }

    // 2. Daily loss limit — measured against the day's OPENING value ("am I down
    // today?"), not the intraday peak. Peak-based drawdown fires on ordinary
    // volatility even when flat/up on the day; close-based matches intent and
    // messaging. Falls back to high_water for legacy rows with no open_usd.
    const maxLossPct = this.runtimeConfig.get('MAX_DAILY_LOSS_PCT') as number;
    const todayPnl = dailyPnlQueries.getTodayPnl.get(network) as any;
    const lossBaseline = (todayPnl?.open_usd > 0 ? todayPnl.open_usd : todayPnl?.high_water) ?? 0;
    if (lossBaseline > 0) {
      const lossPct = ((lossBaseline - portfolioUsd) / lossBaseline) * 100;
      if (lossPct > maxLossPct) {
        this.logDecision('risk_halt', `Daily loss: ${lossPct.toFixed(1)}% > ${maxLossPct}%`);
        botState.setStatus('paused');
        if (!alreadyPaused) {
          botState.emitAlert(`Daily loss limit hit (${lossPct.toFixed(1)}%). Trading paused.`);
        }
        return { approved: false, vetoReason: `Daily loss ${lossPct.toFixed(1)}% exceeds ${maxLossPct}%` };
      }
    }

    // 3. Daily rotation count
    const maxRotations = this.runtimeConfig.get('MAX_DAILY_ROTATIONS') as number;
    const countRow = rotationQueries.getTodayRotationCount.get(network) as any;
    const todayCount = countRow?.cnt ?? 0;
    if (todayCount >= maxRotations) {
      this.logDecision('risk_veto', `Rotation cap: ${todayCount} >= ${maxRotations}`);
      return { approved: false, vetoReason: `Daily rotation cap (${todayCount}/${maxRotations})` };
    }

    // 4. Position size limit (skip for rebalances and USDC buys — USDC is the safe haven, not subject to cap)
    const maxPosPct = this.runtimeConfig.get('MAX_POSITION_PCT') as number;
    let adjustedAmount = proposal.sellAmount;
    if (!proposal.isRebalance && proposal.buySymbol !== 'USDC' && proposal.buyTargetWeightPct > maxPosPct) {
      const currentBuyWeightPct = proposal.buyTargetWeightPct - (proposal.sellAmount / portfolioUsd) * 100;
      const maxAllowedBuyUsd = Math.max(0, (maxPosPct - currentBuyWeightPct) / 100 * portfolioUsd);
      adjustedAmount = Math.min(proposal.sellAmount, maxAllowedBuyUsd);
      if (adjustedAmount < portfolioUsd * 0.01) {
        this.logDecision('risk_veto', `Position limit: reduced amount too small`);
        return { approved: false, vetoReason: 'Position limit reduces rotation below minimum' };
      }
    }

    // 5. Single rotation size cap (skip for rebalances — must clear full excess in one pass)
    const maxRotPct = this.runtimeConfig.get('MAX_ROTATION_PCT') as number;
    if (!proposal.isRebalance) {
      const rotPct = (adjustedAmount / portfolioUsd) * 100;
      if (rotPct > maxRotPct) {
        adjustedAmount = portfolioUsd * maxRotPct / 100;
      }
    }

    // 4b. Memecoin combined cap (not applicable to rebalances — buy is always USDC)
    if (!proposal.isRebalance) {
      const memeCapPct = (this.runtimeConfig.get('MEMECOIN_CAP_PCT') as number | undefined) ?? 20;
      const memePositions = this.getMemePositionsUsd();
      const memeVeto = getMemecoincapVeto(proposal.buySymbol, proposal.sellAmount, memePositions, portfolioUsd, memeCapPct);
      if (memeVeto) {
        this.logDecision('memecoin_cap_veto', memeVeto);
        return { approved: false, vetoReason: memeVeto };
      }
    }

    // 5b & 6: Profit/fee gates — skip for rebalances (risk management, not profit-seeking)
    // Also skip for defensive USDC exits: cash preservation is always valid regardless of
    // estimated gain. Blocking exits to USDC in a falling market is the opposite of risk management.
    if (!proposal.isRebalance && proposal.buySymbol !== 'USDC') {
      const minProfitUsd = (this.runtimeConfig.get('MIN_ROTATION_PROFIT_USD') as number | undefined) ?? 0.01;
      const estimatedProfitUsd = adjustedAmount * (proposal.estimatedGainPct / 100);
      if (estimatedProfitUsd < minProfitUsd) {
        this.logDecision('risk_veto', `Profit $${estimatedProfitUsd.toFixed(2)} < min $${minProfitUsd}`);
        return { approved: false, vetoReason: `Estimated profit $${estimatedProfitUsd.toFixed(2)} below minimum $${minProfitUsd}` };
      }

      // Fee-ratio gate removed: estimatedGainPct is a score-based proxy, not a real gain
      // prediction. Quality is gated by ROTATION_BUY/SELL_THRESHOLD + MIN_ROTATION_SCORE_DELTA.
    }

    this.logDecision(proposal.isRebalance ? 'rebalance_approved' : 'risk_approved', detail);
    return { approved: true, adjustedAmount };
  }

  private getMemePositionsUsd(): Record<string, number> {
    const memes = db.prepare(
      `SELECT symbol FROM discovered_assets WHERE is_memecoin = 1 AND status = 'active'`
    ).all() as { symbol: string }[];

    const positions: Record<string, number> = {};
    for (const { symbol } of memes) {
      const balance = botState.assetBalances.get(symbol) ?? 0;
      const snap = (db.prepare(
        `SELECT price_usd FROM asset_snapshots WHERE symbol = ? ORDER BY timestamp DESC LIMIT 1`
      ).get(symbol) as { price_usd: number } | undefined);
      positions[symbol] = balance * (snap?.price_usd ?? 0);
    }
    return positions;
  }

  private logDecision(event: string, detail: string): void {
    queries.insertEvent.run(event, detail);
    logger.info(`RiskGuard: ${event} — ${detail.slice(0, 200)}`);
  }
}
