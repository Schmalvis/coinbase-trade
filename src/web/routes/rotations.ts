import { Router } from 'express';
import { botState } from '../../core/state.js';
import { rotationQueries } from '../../data/db.js';
import type { RouteContext } from '../route-context.js';

export function registerRotationsRoutes(router: Router, _ctx: RouteContext): void {
  router.get('/api/rotations', (req, res) => {
    const limit = parseInt(String(req.query.limit ?? '20'));
    const rows = rotationQueries.getRecentRotations.all(botState.activeNetwork, limit);
    res.json(rows);
  });

  router.get('/api/calibration', (_req, res) => {
    const rows = rotationQueries.getCalibrationData.all(botState.activeNetwork);
    const result = rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      sell_symbol: r.sell_symbol,
      buy_symbol: r.buy_symbol,
      status: r.status,
      dry_run: r.dry_run,
      score_delta: r.score_delta,
      estimated_gain_pct: r.estimated_gain_pct,
      actual_gain_pct: r.actual_gain_pct,
      estimated_fee_pct: r.estimated_fee_pct,
      implied_fee_pct: r.sell_amount > 0 && r.buy_amount != null
        ? (1 - r.buy_amount / r.sell_amount) * 100
        : null,
      sell_amount: r.sell_amount,
      buy_amount: r.buy_amount,
    }));
    res.json(result);
  });
}
