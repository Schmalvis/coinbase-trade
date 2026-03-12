import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { botState } from '../core/state.js';
import { queries } from '../data/db.js';
import { config } from '../config.js';
import { logger } from '../core/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startWebServer(): void {
  const app = express();
  app.use(express.json());

  app.get('/api/status', (_req, res) => {
    const eth = botState.lastBalance ?? 0;
    const usdc = botState.lastUsdcBalance ?? 0;
    const price = botState.lastPrice ?? 0;
    res.json({
      status: botState.status,
      lastPrice: price,
      ethBalance: eth,
      usdcBalance: usdc,
      portfolioUsd: price * eth + usdc,
      lastTradeAt: botState.lastTradeAt,
      dryRun: config.DRY_RUN,
      strategy: config.STRATEGY,
      activeNetwork: botState.activeNetwork,
      availableNetworks: botState.availableNetworks,
    });
  });

  app.get('/api/networks', (_req, res) => {
    res.json({
      active: botState.activeNetwork,
      available: botState.availableNetworks,
    });
  });

  app.get('/api/prices', (req, res) => {
    const limit = parseInt(req.query.limit as string ?? '288', 10);
    res.json(queries.recentSnapshots.all(limit));
  });

  app.get('/api/trades', (req, res) => {
    const limit = parseInt(req.query.limit as string ?? '20', 10);
    res.json(queries.recentTrades.all(limit));
  });

  app.post('/api/control/:action', (req, res) => {
    const { action } = req.params;
    if (action === 'pause') {
      botState.setStatus('paused');
      res.json({ ok: true, status: 'paused' });
    } else if (action === 'resume') {
      botState.setStatus('running');
      res.json({ ok: true, status: 'running' });
    } else {
      res.status(400).json({ error: 'Unknown action' });
    }
  });

  app.post('/api/network', (req, res) => {
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

  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.listen(config.WEB_PORT, '0.0.0.0', () => {
    logger.info(`Web dashboard: http://0.0.0.0:${config.WEB_PORT}`);
  });
}
