import { Router } from 'express';
import { botState } from '../../core/state.js';
import { queries, dailyPnlQueries, rotationQueries } from '../../data/db.js';
import type { RouteContext } from '../route-context.js';

export function registerRiskRoutes(router: Router, ctx: RouteContext): void {
  const { runtimeConfig, engine, optimizer } = ctx;

  router.get('/api/risk', (_req, res) => {
    const network = botState.activeNetwork;
    const todayPnl = dailyPnlQueries.getTodayPnl.get(network) as any;
    const rotCount = rotationQueries.getTodayRotationCount.get(network);

    // Compute current portfolio value for floor comparison
    let portfolioUsd = 0;
    for (const [sym, bal] of botState.assetBalances) {
      if (sym === 'USDC') portfolioUsd += bal;
      else if (sym === 'ETH' && botState.lastPrice) portfolioUsd += bal * botState.lastPrice;
      else {
        const priceRow = (queries.recentAssetSnapshots.all(sym, 1) as any[])[0];
        portfolioUsd += bal * (priceRow?.price_usd ?? 0);
      }
    }

    const pnl = todayPnl ? (portfolioUsd - (todayPnl.high_water ?? portfolioUsd)) : 0;
    const maxLoss = runtimeConfig.get('MAX_DAILY_LOSS_PCT') as number;
    const maxRot = runtimeConfig.get('MAX_DAILY_ROTATIONS') as number;
    const floor = runtimeConfig.get('PORTFOLIO_FLOOR_USD') as number;

    // Find highest position weight among non-USDC assets
    let maxPositionPct = 0;
    if (portfolioUsd > 0) {
      for (const [sym, bal] of botState.assetBalances) {
        if (sym === 'USDC') continue;
        let price = 0;
        if (sym === 'ETH' && botState.lastPrice) price = botState.lastPrice;
        else {
          const row = (queries.recentAssetSnapshots.all(sym, 1) as any[])[0];
          price = row?.price_usd ?? 0;
        }
        const pct = (bal * price) / portfolioUsd * 100;
        if (pct > maxPositionPct) maxPositionPct = pct;
      }
    }

    const dailyPnlPct = portfolioUsd > 0 ? (pnl / portfolioUsd) * 100 : 0;
    const maxPosCfg = runtimeConfig.get('MAX_POSITION_PCT') as number;

    res.json({
      daily_pnl: pnl,
      daily_pnl_pct: dailyPnlPct,
      daily_pnl_limit: maxLoss,
      rotations_today: (rotCount as any)?.cnt ?? 0,
      max_daily_rotations: maxRot,
      max_position_pct: maxPositionPct,
      max_position_limit: maxPosCfg,
      portfolio_floor: floor,
      portfolio_usd: portfolioUsd,
      optimizer_enabled: !!engine.optimizerEnabled,
      optimizer_status: !engine.optimizerEnabled ? 'disabled' : (optimizer?.isRiskOff ? 'risk-off' : 'active'),
      has_data: !!todayPnl,
    });
  });
}
