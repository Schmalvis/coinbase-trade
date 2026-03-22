import { Router } from 'express';
import type { RouteContext } from '../route-context.js';

export function registerOptimizerRoutes(router: Router, ctx: RouteContext): void {
  const { engine } = ctx;

  router.post('/api/optimizer/toggle', (req, res) => {
    const { enabled } = req.body;
    if (enabled) engine.enableOptimizer();
    else engine.disableOptimizer();
    res.json({ ok: true, enabled: engine.optimizerEnabled });
  });
}
