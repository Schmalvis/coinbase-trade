import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { botState } from '../core/state.js';
import { queries, discoveredAssetQueries } from '../data/db.js';
import type { DiscoveredAssetRow } from '../data/db.js';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import { assetsForNetwork } from '../assets/registry.js';
import type { CoinbaseTools } from '../mcp/tools.js';
import type { RuntimeConfig, ConfigKey } from '../core/runtime-config.js';
import type { TradeExecutor } from '../trading/executor.js';
import type { TradingEngine } from '../trading/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function validateAssetParams(p: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if ('strategyType' in p && !['threshold', 'sma'].includes(p.strategyType as string)) {
    errors.push('strategyType must be threshold or sma');
  }
  for (const k of ['dropPct', 'risePct']) {
    if (k in p && (typeof p[k] !== 'number' || (p[k] as number) < 0.1)) {
      errors.push(`${k} must be a number >= 0.1`);
    }
  }
  if ('smaShort' in p && (typeof p.smaShort !== 'number' || !Number.isInteger(p.smaShort) || (p.smaShort as number) < 2)) {
    errors.push('smaShort must be an integer >= 2');
  }
  if ('smaLong' in p && (typeof p.smaLong !== 'number' || !Number.isInteger(p.smaLong) || (p.smaLong as number) < 3)) {
    errors.push('smaLong must be an integer >= 3');
  }
  return errors;
}

export function startWebServer(
  tools: CoinbaseTools,
  runtimeConfig: RuntimeConfig,
  executor: TradeExecutor,
  engine: TradingEngine,
): void {
  const app = express();
  app.use(express.json());

  // ── Status ──────────────────────────────────────────────────────────────────
  app.get('/api/status', (_req, res) => {
    let portfolioUsd = 0;
    for (const [sym, bal] of botState.assetBalances) {
      const priceRow = (queries.recentAssetSnapshots.all(sym, 1) as any[])[0];
      portfolioUsd += bal * (priceRow?.price_usd ?? 0);
    }
    res.json({
      status:            botState.status,
      lastPrice:         botState.lastPrice ?? 0,
      ethBalance:        botState.lastBalance ?? 0,
      usdcBalance:       botState.lastUsdcBalance ?? 0,
      portfolioUsd,
      lastTradeAt:       botState.lastTradeAt,
      dryRun:            runtimeConfig.get('DRY_RUN'),
      strategy:          runtimeConfig.get('STRATEGY'),
      activeNetwork:     botState.activeNetwork,
      availableNetworks: botState.availableNetworks,
      assetBalances:     Object.fromEntries(botState.assetBalances),
      pendingTokenCount: botState.pendingTokenCount,
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

  // ── Enso (custom token) trade ────────────────────────────────────────────────
  app.post('/api/trade/enso', async (req, res) => {
    const { tokenIn, tokenOut, amountIn } = req.body as { tokenIn?: string; tokenOut?: string; amountIn?: string };
    if (!tokenIn || !tokenOut || !amountIn) {
      return res.status(400).json({ error: 'tokenIn, tokenOut, amountIn are required' });
    }
    if (botState.activeNetwork !== 'base-mainnet') {
      return res.status(400).json({ error: 'Enso routing is only available on base-mainnet' });
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

  // ── Assets ──────────────────────────────────────────────────────────────────
  app.get('/api/assets', (_req, res) => {
    const network = botState.activeNetwork;

    const registryAssets = assetsForNetwork(network).map(a => {
      const sym = a.symbol;
      const priceRow = (queries.recentAssetSnapshots.all(sym, 1) as any[])[0];
      const price = priceRow?.price_usd ?? null;
      const old = (queries.recentAssetSnapshots.all(sym, 100) as any[])
        .find((r: any) => new Date(r.timestamp + 'Z').getTime() <= Date.now() - 86400000);
      const change24h = (price && old?.price_usd && old.price_usd !== 0)
        ? ((price - old.price_usd) / old.price_usd) * 100
        : null;
      return {
        symbol: sym,
        name: (a as any).name ?? sym,
        address: a.addresses[network as keyof typeof a.addresses] ?? null,
        decimals: a.decimals,
        balance: botState.assetBalances.get(sym) ?? null,
        price,
        change24h,
        isNative: a.isNative ?? false,
        tradeMethod: a.tradeMethod,
        priceSource: a.priceSource,
        status: 'active' as const,
        source: 'registry' as const,
        strategyConfig: {
          type: runtimeConfig.get('STRATEGY') as string,
          dropPct: runtimeConfig.get('PRICE_DROP_THRESHOLD_PCT') as number,
          risePct: runtimeConfig.get('PRICE_RISE_TARGET_PCT') as number,
          smaShort: runtimeConfig.get('SMA_SHORT_WINDOW') as number,
          smaLong: runtimeConfig.get('SMA_LONG_WINDOW') as number,
        },
      };
    });

    const allDiscovered = (discoveredAssetQueries.getDiscoveredAssets.all(network) as DiscoveredAssetRow[])
      .filter(d => d.status !== 'dismissed')
      .map(d => {
        const priceRow = (queries.recentAssetSnapshots.all(d.symbol, 1) as any[])[0];
        const price = priceRow?.price_usd ?? null;
        const old = (queries.recentAssetSnapshots.all(d.symbol, 100) as any[])
          .find((r: any) => new Date(r.timestamp + 'Z').getTime() <= Date.now() - 86400000);
        const change24h = (price && old?.price_usd && old.price_usd !== 0)
          ? ((price - old.price_usd) / old.price_usd) * 100
          : null;
        return {
          symbol: d.symbol,
          name: d.name,
          address: d.address,
          decimals: d.decimals,
          balance: botState.assetBalances.get(d.symbol) ?? null,
          price,
          change24h,
          isNative: false,
          tradeMethod: 'agentkit',
          priceSource: 'defillama',
          status: d.status,
          source: 'discovered' as const,
          strategyConfig: {
            type: d.strategy,
            dropPct: d.drop_pct,
            risePct: d.rise_pct,
            smaShort: d.sma_short,
            smaLong: d.sma_long,
          },
        };
      });

    res.json([...registryAssets, ...allDiscovered]);
  });

  // ── Asset management endpoints ───────────────────────────────────────────────

  // POST /api/assets/:address/enable
  app.post('/api/assets/:address/enable', (req, res) => {
    const { address } = req.params;
    const network = botState.activeNetwork;
    const body = req.body as Record<string, unknown>;

    // Validate params FIRST, then 404 check
    const errors = validateAssetParams(body);
    if (errors.length) return res.status(400).json({ error: errors[0] });

    const row = discoveredAssetQueries.getAssetByAddress.get(address, network) as DiscoveredAssetRow | undefined;
    if (!row) return res.status(404).json({ error: `Asset ${address} not found on ${network}` });

    const params = body as { strategyType: string; dropPct: number; risePct: number; smaShort: number; smaLong: number };
    discoveredAssetQueries.updateAssetStrategyConfig.run({
      address, network,
      strategy: params.strategyType,
      drop_pct: params.dropPct,
      rise_pct: params.risePct,
      sma_short: params.smaShort,
      sma_long: params.smaLong,
    });
    discoveredAssetQueries.updateAssetStatus.run({
      status: 'active',
      address,
      network,
    });
    engine.startAssetLoop(address, row.symbol, {
      strategyType: params.strategyType as 'threshold' | 'sma',
      dropPct: params.dropPct,
      risePct: params.risePct,
      smaShort: params.smaShort,
      smaLong: params.smaLong,
    });
    const allDiscovered = discoveredAssetQueries.getDiscoveredAssets.all(network) as DiscoveredAssetRow[];
    botState.setPendingTokenCount(allDiscovered.filter(r => r.status === 'pending').length);
    return res.json({ ok: true });
  });

  // POST /api/assets/:address/dismiss
  app.post('/api/assets/:address/dismiss', (req, res) => {
    const { address } = req.params;
    const network = botState.activeNetwork;
    const row = discoveredAssetQueries.getAssetByAddress.get(address, network) as DiscoveredAssetRow | undefined;
    if (!row) return res.status(404).json({ error: `Asset ${address} not found on ${network}` });
    discoveredAssetQueries.dismissAsset.run(address, network);
    engine.stopAssetLoop(row.symbol);
    const allDiscovered = discoveredAssetQueries.getDiscoveredAssets.all(network) as DiscoveredAssetRow[];
    botState.setPendingTokenCount(allDiscovered.filter(r => r.status === 'pending').length);
    return res.json({ ok: true });
  });

  // PUT /api/assets/:address/config
  app.put('/api/assets/:address/config', (req, res) => {
    const { address } = req.params;
    const network = botState.activeNetwork;

    const row = discoveredAssetQueries.getAssetByAddress.get(address, network) as DiscoveredAssetRow | undefined;
    if (!row) return res.status(404).json({ error: `Asset ${address} not found on ${network}` });

    const body = req.body as Record<string, unknown>;
    const errors = validateAssetParams(body);
    if (errors.length) return res.status(400).json({ error: errors[0] });

    const params = body as { strategyType: string; dropPct: number; risePct: number; smaShort: number; smaLong: number };
    discoveredAssetQueries.updateAssetStrategyConfig.run({
      address, network,
      strategy: params.strategyType,
      drop_pct: params.dropPct,
      rise_pct: params.risePct,
      sma_short: params.smaShort,
      sma_long: params.smaLong,
    });
    engine.reloadAssetConfig(address, row.symbol, {
      strategyType: params.strategyType as 'threshold' | 'sma',
      dropPct: params.dropPct,
      risePct: params.risePct,
      smaShort: params.smaShort,
      smaLong: params.smaLong,
    });
    return res.json({ ok: true });
  });

  // ── Prices & Trades ─────────────────────────────────────────────────────────
  app.get('/api/prices', (req, res) => {
    const limit  = parseInt((req.query.limit as string) ?? '288', 10);
    const symbol = (req.query.asset as string | undefined)?.toUpperCase();
    if (symbol) {
      res.json(queries.recentAssetSnapshots.all(symbol, limit));
      return;
    }
    res.json(queries.recentSnapshots.all(limit));
  });

  app.get('/api/portfolio', (req, res) => {
    const limit = parseInt((req.query.limit as string) ?? '288', 10);
    res.json(queries.recentPortfolioSnapshots.all(limit));
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
