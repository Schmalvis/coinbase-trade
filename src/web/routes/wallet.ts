import { Router } from 'express';
import { botState } from '../../core/state.js';
import { queries, settingQueries } from '../../data/db.js';
import { logger } from '../../core/logger.js';
import type { RouteContext } from '../route-context.js';

export function registerWalletRoutes(router: Router, _ctx: RouteContext): void {
  router.post('/api/wallet/reset', (_req, res) => {
    settingQueries.upsertSetting.run('EXPECTED_WALLET_ADDRESS', '');
    botState.setWalletAddress(null);
    queries.insertEvent.run('wallet_reset', 'Expected wallet address cleared via web API');
    logger.info('Expected wallet address cleared via web API');
    res.json({ ok: true });
  });

  router.post('/api/network', (req, res) => {
    const { network } = req.body as { network?: string };
    if (!network) return res.status(400).json({ error: 'network required' });
    try {
      botState.setNetwork(network);
      logger.info(`Network switched to ${network} via web UI`);
      res.json({ ok: true, activeNetwork: network });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
