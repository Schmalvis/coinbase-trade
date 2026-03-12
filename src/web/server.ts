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
    res.json({
      status: botState.status,
      lastPrice: botState.lastPrice,
      lastBalance: botState.lastBalance,
      portfolioUsd: botState.lastPrice && botState.lastBalance
        ? botState.lastPrice * botState.lastBalance
        : null,
      lastTradeAt: botState.lastTradeAt,
      dryRun: config.DRY_RUN,
      strategy: config.STRATEGY,
    });
  });

  app.get('/api/prices', (req, res) => {
    const limit = parseInt(req.query.limit as string ?? '288', 10); // 288 = 24h at 5min intervals
    const rows = queries.recentSnapshots.all(limit);
    res.json(rows);
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

  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.listen(config.WEB_PORT, '0.0.0.0', () => {
    logger.info(`Web dashboard: http://0.0.0.0:${config.WEB_PORT}`);
  });
}
