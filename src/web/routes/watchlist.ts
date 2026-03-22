import { Router } from 'express';
import { botState } from '../../core/state.js';
import type { RouteContext } from '../route-context.js';

export function registerWatchlistRoutes(router: Router, ctx: RouteContext): void {
  const { watchlistManager } = ctx;

  router.get('/api/watchlist', (_req, res) => {
    res.json(watchlistManager?.getAll(botState.activeNetwork) ?? []);
  });

  router.post('/api/watchlist', (req, res) => {
    const { symbol, network, address, coinbasePair } = req.body;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    watchlistManager?.add(symbol, network ?? botState.activeNetwork, address, coinbasePair);
    res.json({ ok: true });
  });

  router.delete('/api/watchlist/:symbol', (req, res) => {
    watchlistManager?.remove(req.params.symbol, botState.activeNetwork);
    res.json({ ok: true });
  });
}
