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
}
