import { Router } from 'express';
import { botState } from '../../core/state.js';
import { candleQueries } from '../../data/db.js';
import type { RouteContext } from '../route-context.js';

export function registerCandlesRoutes(router: Router, ctx: RouteContext): void {
  const { optimizer } = ctx;

  router.get('/api/candles', (req, res) => {
    const { symbol, interval = '15m', limit = '100' } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const rows = candleQueries.getCandles.all(String(symbol), botState.activeNetwork, String(interval), parseInt(String(limit)));
    res.json(rows);
  });

  router.get('/api/scores', (_req, res) => {
    res.json(optimizer?.getLatestScores() ?? []);
  });
}
