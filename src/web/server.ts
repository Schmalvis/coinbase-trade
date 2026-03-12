import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { botState } from '../core/state.js';
import { queries } from '../data/db.js';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import type { CoinbaseTools } from '../mcp/tools.js';
import type { RuntimeConfig, ConfigKey } from '../core/runtime-config.js';
import type { TradeExecutor } from '../trading/executor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startWebServer(tools: CoinbaseTools, runtimeConfig: RuntimeConfig, executor: TradeExecutor): void {
  const app = express();
  app.use(express.json());

  // ── Status ──────────────────────────────────────────────────────────────────
  app.get('/api/status', (_req, res) => {
    const eth   = botState.lastBalance ?? 0;
    const usdc  = botState.lastUsdcBalance ?? 0;
    const price = botState.lastPrice ?? 0;
    res.json({
      status:           botState.status,
      lastPrice:        price,
      ethBalance:       eth,
      usdcBalance:      usdc,
      portfolioUsd:     price * eth + usdc,
      lastTradeAt:      botState.lastTradeAt,
      dryRun:           runtimeConfig.get('DRY_RUN'),   // live value
      strategy:         runtimeConfig.get('STRATEGY'),  // live value
      activeNetwork:    botState.activeNetwork,
      availableNetworks: botState.availableNetworks,
    });
  });

  app.get('/api/networks', (_req, res) => {
    res.json({ active: botState.activeNetwork, available: botState.availableNetworks });
  });

  // ── Wallet ──────────────────────────────────────────────────────────────────
  app.get('/api/wallet', async (_req, res) => {
    try {
      res.json(await tools.getWalletDetails());
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Settings ────────────────────────────────────────────────────────────────
  app.get('/api/settings', (_req, res) => {
    res.json(runtimeConfig.getAll());
  });

  app.post('/api/settings', (req, res) => {
    const { changes } = req.body as { changes?: Record<string, unknown> };
    if (!changes || typeof changes !== 'object') {
      return res.status(400).json({ error: 'Body must be { changes: { key: value, ... } }' });
    }
    try {
      runtimeConfig.setBatch(changes as Record<ConfigKey, unknown>);
      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Extract field name from message (format: "KEY: reason")
      const field = msg.split(':')[0].trim();
      res.status(400).json({ error: msg, field });
    }
  });

  // ── Quote ───────────────────────────────────────────────────────────────────
  app.get('/api/quote', async (req, res) => {
    const { from, to, amount, side = 'from' } = req.query as Record<string, string>;
    if (!from || !to || !amount) {
      return res.status(400).json({ error: 'from, to, amount are required query params' });
    }
    try {
      const quote = side === 'to'
        ? await tools.getSwapQuoteForReceiveAmount(from as any, to as any, amount)
        : await tools.getSwapPrice(from as any, to as any, amount);
      res.json(quote);
    } catch (err: unknown) {
      res.status(503).json({ error: `Could not fetch quote: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // ── Trade ───────────────────────────────────────────────────────────────────
  app.post('/api/trade', async (req, res) => {
    const { from, to, fromAmount } = req.body as { from?: string; to?: string; fromAmount?: string };
    if (!from || !to || !fromAmount) {
      return res.status(400).json({ error: 'from, to, fromAmount are required' });
    }
    try {
      const result = await executor.executeManual(from as any, to as any, fromAmount);
      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Manual trade rejected: ${msg}`);
      res.status(400).json({ error: msg });
    }
  });

  // ── Prices & Trades ─────────────────────────────────────────────────────────
  app.get('/api/prices', (req, res) => {
    const limit = parseInt((req.query.limit as string) ?? '288', 10);
    res.json(queries.recentSnapshots.all(limit));
  });

  app.get('/api/trades', (req, res) => {
    const limit = parseInt((req.query.limit as string) ?? '20', 10);
    res.json(queries.recentTrades.all(limit));
  });

  // ── Bot controls ────────────────────────────────────────────────────────────
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

  // ── Faucet ──────────────────────────────────────────────────────────────────
  app.post('/api/faucet', async (req, res) => {
    if (botState.activeNetwork.includes('mainnet')) {
      return res.status(400).json({ error: 'Faucet not available on mainnet' });
    }
    const { assetId = 'eth' } = req.body as { assetId?: string };
    try {
      logger.info(`Faucet requested for ${assetId} on ${botState.activeNetwork}`);
      const result = await tools.requestFaucetFunds(assetId);
      logger.info(`Faucet result: ${result}`);
      res.json({ ok: true, result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Faucet error: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── Network ─────────────────────────────────────────────────────────────────
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
