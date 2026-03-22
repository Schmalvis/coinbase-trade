import { Router } from 'express';
import { botState } from '../../core/state.js';
import { discoveredAssetQueries } from '../../data/db.js';
import type { DiscoveredAssetRow } from '../../data/db.js';
import { logger } from '../../core/logger.js';
import { assetsForNetwork } from '../../assets/registry.js';
import type { RouteContext } from '../route-context.js';

export function registerTradingRoutes(router: Router, ctx: RouteContext): void {
  const { tools, executor } = ctx;

  router.get('/api/quote', async (req, res) => {
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

  router.post('/api/trade', async (req, res) => {
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

  router.post('/api/trade/enso', async (req, res) => {
    const { tokenIn, tokenOut, amountIn } = req.body as { tokenIn?: string; tokenOut?: string; amountIn?: string };
    if (!tokenIn || !tokenOut || !amountIn) {
      return res.status(400).json({ error: 'tokenIn, tokenOut, amountIn are required' });
    }
    if (botState.activeNetwork !== 'base-mainnet') {
      return res.status(400).json({ error: 'Enso routing is only available on base-mainnet' });
    }
    // C2: Allowlist — only trade tokens that are registered or explicitly enabled
    const network = botState.activeNetwork;
    const registryAddrs = assetsForNetwork(network)
      .map(a => a.addresses[network as keyof typeof a.addresses]?.toLowerCase())
      .filter((a): a is string => !!a);
    const discoveredAddrs = (discoveredAssetQueries.getActiveAssets.all(network) as DiscoveredAssetRow[]).map(a => a.address.toLowerCase());
    const allowlist = new Set([...registryAddrs, ...discoveredAddrs]);
    if (!allowlist.has(tokenIn.toLowerCase()) && !allowlist.has(tokenOut.toLowerCase())) {
      return res.status(400).json({ error: 'Token address not in allowlist — enable the asset first' });
    }
    try {
      const result = await executor.executeEnso(tokenIn, tokenOut, amountIn);
      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Enso trade rejected: ${msg}`);
      res.status(400).json({ error: msg });
    }
  });

  router.post('/api/control/:action', (req, res) => {
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

  router.post('/api/faucet', async (req, res) => {
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
}
