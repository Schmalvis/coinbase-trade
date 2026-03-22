import { Router } from 'express';
import type { ConfigKey } from '../../core/runtime-config.js';
import type { RouteContext } from '../route-context.js';

export function registerSettingsRoutes(router: Router, ctx: RouteContext): void {
  const { runtimeConfig } = ctx;

  router.get('/api/settings', (_req, res) => {
    res.json(runtimeConfig.getAll());
  });

  router.post('/api/settings', (req, res) => {
    const { changes } = req.body as { changes?: Record<string, unknown> };
    if (!changes || typeof changes !== 'object') {
      return res.status(400).json({ error: 'Body must be { changes: { key: value, ... } }' });
    }
    try {
      runtimeConfig.setBatch(changes as Record<ConfigKey, unknown>);
      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const field = msg.split(':')[0].trim();
      res.status(400).json({ error: msg, field });
    }
  });

  router.get('/api/theme', (_req, res) => {
    res.json({ theme: runtimeConfig.get('DASHBOARD_THEME') ?? 'dark' });
  });

  router.put('/api/theme', (req, res) => {
    const { theme } = req.body;
    runtimeConfig.set('DASHBOARD_THEME', theme);
    res.json({ ok: true });
  });
}
