import { queries, dailyPnlQueries, rotationQueries } from '../data/db.js';
import { botState } from '../core/state.js';
import { logger } from '../core/logger.js';
import type { RuntimeConfig } from '../core/runtime-config.js';

export interface RotationProposal {
  sellSymbol: string;
  buySymbol: string;
  sellAmount: number;       // USD value
  estimatedGainPct: number;
  estimatedFeePct: number;
  buyTargetWeightPct: number; // what % of portfolio the buy asset would be after
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

    // 1. Portfolio floor
    const floor = this.runtimeConfig.get('PORTFOLIO_FLOOR_USD') as number;
    if (portfolioUsd < floor) {
      this.logDecision('risk_halt', `Portfolio floor breached: $${portfolioUsd} < $${floor}`);
      botState.setStatus('paused');
      botState.emitAlert(`PORTFOLIO FLOOR BREACHED ($${portfolioUsd.toFixed(2)} < $${floor}). ALL TRADING HALTED.`);
      return { approved: false, vetoReason: `Portfolio floor breached ($${portfolioUsd} < $${floor})` };
    }

    // 2. Daily loss limit
    const maxLossPct = this.runtimeConfig.get('MAX_DAILY_LOSS_PCT') as number;
    const todayPnl = dailyPnlQueries.getTodayPnl.get(network) as any;
    if (todayPnl && todayPnl.high_water > 0) {
      const lossPct = ((todayPnl.high_water - portfolioUsd) / todayPnl.high_water) * 100;
      if (lossPct > maxLossPct) {
        this.logDecision('risk_halt', `Daily loss: ${lossPct.toFixed(1)}% > ${maxLossPct}%`);
        botState.setStatus('paused');
        botState.emitAlert(`Daily loss limit hit (${lossPct.toFixed(1)}%). Trading paused.`);
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

    // 4. Position size limit
    const maxPosPct = this.runtimeConfig.get('MAX_POSITION_PCT') as number;
    let adjustedAmount = proposal.sellAmount;
    if (proposal.buyTargetWeightPct > maxPosPct) {
      const reduction = (proposal.buyTargetWeightPct - maxPosPct) / proposal.buyTargetWeightPct;
      adjustedAmount = proposal.sellAmount * (1 - reduction);
      if (adjustedAmount < portfolioUsd * 0.01) {
        this.logDecision('risk_veto', `Position limit: reduced amount too small`);
        return { approved: false, vetoReason: 'Position limit reduces rotation below minimum' };
      }
    }

    // 5. Single rotation size cap
    const maxRotPct = this.runtimeConfig.get('MAX_ROTATION_PCT') as number;
    const rotPct = (adjustedAmount / portfolioUsd) * 100;
    if (rotPct > maxRotPct) {
      adjustedAmount = portfolioUsd * maxRotPct / 100;
    }

    // 5b. Minimum absolute USD profit check
    const minProfitUsd = (this.runtimeConfig.get('MIN_ROTATION_PROFIT_USD') as number | undefined) ?? 1.0;
    const estimatedProfitUsd = adjustedAmount * (proposal.estimatedGainPct / 100);
    if (estimatedProfitUsd < minProfitUsd) {
      this.logDecision('risk_veto', `Profit $${estimatedProfitUsd.toFixed(2)} < min $${minProfitUsd}`);
      return { approved: false, vetoReason: `Estimated profit $${estimatedProfitUsd.toFixed(2)} below minimum $${minProfitUsd}` };
    }

    // 6. Fee check: require gain of at least 1.5× fees (not just break-even)
    if (proposal.estimatedGainPct < proposal.estimatedFeePct * 1.5) {
      this.logDecision('risk_veto', `Gain ${proposal.estimatedGainPct.toFixed(2)}% < 1.5× fees ${proposal.estimatedFeePct.toFixed(2)}%`);
      return { approved: false, vetoReason: `Gain (${proposal.estimatedGainPct.toFixed(2)}%) below 1.5× fee threshold (${(proposal.estimatedFeePct * 1.5).toFixed(2)}%)` };
    }

    this.logDecision('risk_approved', detail);
    return { approved: true, adjustedAmount };
  }

  private logDecision(event: string, detail: string): void {
    queries.insertEvent.run(event, detail);
    logger.info(`RiskGuard: ${event} — ${detail.slice(0, 200)}`);
  }
}
