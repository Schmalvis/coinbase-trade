import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { botState } from '../core/state.js';
import { queries, discoveredAssetQueries, settingQueries, candleQueries, rotationQueries, dailyPnlQueries, portfolioSnapshotQueries } from '../data/db.js';
import type { DiscoveredAssetRow } from '../data/db.js';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import { assetsForNetwork } from '../assets/registry.js';
import type { CoinbaseTools } from '../mcp/tools.js';
import type { RuntimeConfig, ConfigKey } from '../core/runtime-config.js';
import type { TradeExecutor } from '../trading/executor.js';
import type { TradingEngine } from '../trading/engine.js';
import type { PortfolioOptimizer } from '../trading/optimizer.js';
import type { WatchlistManager } from '../portfolio/watchlist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function validateAssetParams(p: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if ('strategyType' in p && !['threshold', 'sma', 'grid'].includes(p.strategyType as string)) {
    errors.push('strategyType must be threshold, sma, or grid');
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
  optimizer?: PortfolioOptimizer,
  watchlistManager?: WatchlistManager,
): void {
  const app = express();
  app.use(express.json());

  // ── Status ──────────────────────────────────────────────────────────────────
  app.get('/api/status', (_req, res) => {
    // Use tracker's portfolio snapshot as the authoritative value (it has full MCP context)
    const latestSnapshot = (queries.recentPortfolioSnapshots?.all(1) as any[])?.[0];
    let portfolioUsd = latestSnapshot?.portfolio_usd ?? 0;

    // Fallback: compute from botState if no snapshot yet
    if (portfolioUsd === 0) {
      for (const [sym, bal] of botState.assetBalances) {
        let price: number;
        if (sym === 'USDC') {
          price = 1.0;
        } else if (sym === 'ETH' && botState.lastPrice) {
          price = botState.lastPrice;
        } else {
          const priceRow = (queries.recentAssetSnapshots.all(sym, 1) as any[])[0];
          price = priceRow?.price_usd ?? 0;
        }
        portfolioUsd += bal * price;
      }
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
      walletAddress:     botState.walletAddress,
      mcpHealthy:        botState.mcpHealthy,
      optimizerEnabled:  engine.optimizerEnabled,
      optimizerMode:     optimizer?.isRiskOff ? 'risk-off' : 'normal',
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

    // Single source: discovered_assets table (registry assets are seeded there on boot)
    const allAssets = (discoveredAssetQueries.getDiscoveredAssets.all(network) as DiscoveredAssetRow[])
      .filter(d => d.status !== 'dismissed');

    // Deduplicate by symbol — first occurrence wins (registry-seeded come first)
    const seen = new Set<string>();
    const deduped = allAssets.filter(d => {
      if (seen.has(d.symbol)) return false;
      seen.add(d.symbol);
      return true;
    });

    // Look up registry metadata for richer asset info
    const registryMap = new Map(assetsForNetwork(network).map(a => [a.symbol, a]));

    const result = deduped.map(d => {
      const reg = registryMap.get(d.symbol);
      let price: number | null;
      if (d.symbol === 'USDC') {
        price = 1.0;
      } else if (d.symbol === 'ETH' && botState.lastPrice) {
        price = botState.lastPrice;
      } else {
        const priceRow = (queries.recentAssetSnapshots.all(d.symbol, 1) as any[])[0];
        price = priceRow?.price_usd ?? null;
      }
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
        isNative: reg?.isNative ?? false,
        tradeMethod: reg?.tradeMethod ?? 'agentkit',
        priceSource: reg?.priceSource ?? 'defillama',
        status: d.status,
        source: (reg ? 'registry' : 'discovered') as 'registry' | 'discovered',
        strategyConfig: {
          type: d.strategy,
          dropPct: d.drop_pct,
          risePct: d.rise_pct,
          smaShort: d.sma_short,
          smaLong: d.sma_long,
          gridLevels: d.grid_levels,
          gridUpperBound: d.grid_upper_bound,
          gridLowerBound: d.grid_lower_bound,
        },
      };
    });

    res.json(result);
  });

  // ── Asset management endpoints ───────────────────────────────────────────────

  // POST /api/assets/:address/enable
  app.post('/api/assets/:address/enable', (req, res) => {
    const { address } = req.params;
    const network = botState.activeNetwork;
    const body = req.body as Record<string, unknown>;

    // Check all required fields are present
    const required = ['strategyType', 'dropPct', 'risePct', 'smaShort', 'smaLong'];
    const missing = required.filter(k => !(k in body));
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

    // Validate params FIRST, then 404 check
    const errors = validateAssetParams(body);
    if (errors.length) return res.status(400).json({ error: errors[0] });

    let row = discoveredAssetQueries.getAssetByAddress.get(address, network) as DiscoveredAssetRow | undefined;
    if (!row) {
      const allAssets = discoveredAssetQueries.getDiscoveredAssets.all(network) as DiscoveredAssetRow[];
      row = allAssets.find(r => r.address.toLowerCase() === address.toLowerCase() || r.symbol.toLowerCase() === address.toLowerCase());
    }
    if (!row) return res.status(404).json({ error: `Asset ${address} not found on ${network}` });

    const dbAddress = row.address;
    const params = body as { strategyType: string; dropPct: number; risePct: number; smaShort: number; smaLong: number };
    discoveredAssetQueries.updateAssetStrategyConfig.run({
      address: dbAddress, network,
      strategy: params.strategyType,
      drop_pct: params.dropPct,
      rise_pct: params.risePct,
      sma_short: params.smaShort,
      sma_long: params.smaLong,
    });
    discoveredAssetQueries.updateAssetStatus.run({
      status: 'active',
      address: dbAddress,
      network,
    });
    engine.startAssetLoop(dbAddress, row.symbol, {
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
    let row = discoveredAssetQueries.getAssetByAddress.get(address, network) as DiscoveredAssetRow | undefined;
    if (!row) {
      const allAssets = discoveredAssetQueries.getDiscoveredAssets.all(network) as DiscoveredAssetRow[];
      row = allAssets.find(r => r.address.toLowerCase() === address.toLowerCase() || r.symbol.toLowerCase() === address.toLowerCase());
    }
    if (!row) return res.status(404).json({ error: `Asset ${address} not found on ${network}` });
    discoveredAssetQueries.dismissAsset.run(row.address, network);
    engine.stopAssetLoop(row.symbol);
    const allDiscovered = discoveredAssetQueries.getDiscoveredAssets.all(network) as DiscoveredAssetRow[];
    botState.setPendingTokenCount(allDiscovered.filter(r => r.status === 'pending').length);
    return res.json({ ok: true });
  });

  // PUT /api/assets/:address/config
  app.put('/api/assets/:address/config', (req, res) => {
    const { address } = req.params;
    const network = botState.activeNetwork;

    // Try by address first, then fall back to symbol lookup (handles address mismatches from seeding)
    let row = discoveredAssetQueries.getAssetByAddress.get(address, network) as DiscoveredAssetRow | undefined;
    if (!row) {
      // address might be a symbol or the DB has a different address form
      const allActive = discoveredAssetQueries.getActiveAssets.all(network) as DiscoveredAssetRow[];
      row = allActive.find(r => r.address.toLowerCase() === address.toLowerCase() || r.symbol.toLowerCase() === address.toLowerCase());
    }
    if (!row) return res.status(404).json({ error: `Asset ${address} not found on ${network}` });

    const body = req.body as Record<string, unknown>;
    const errors = validateAssetParams(body);
    if (errors.length) return res.status(400).json({ error: errors[0] });

    const params = body as { strategyType: string; dropPct: number; risePct: number; smaShort: number; smaLong: number };
    const dbAddress = row.address; // use the address from DB, not the request param
    discoveredAssetQueries.updateAssetStrategyConfig.run({
      address: dbAddress, network,
      strategy: params.strategyType,
      drop_pct: params.dropPct,
      rise_pct: params.risePct,
      sma_short: params.smaShort,
      sma_long: params.smaLong,
    });
    if (params.strategyType === 'grid') {
      const gridLevels = Number(body.grid_levels) || 10;
      const gridUpperBound = body.grid_upper_bound != null ? Number(body.grid_upper_bound) : null;
      const gridLowerBound = body.grid_lower_bound != null ? Number(body.grid_lower_bound) : null;
      const gridManualOverride = (gridUpperBound != null && gridLowerBound != null) ? 1 : 0;
      discoveredAssetQueries.updateGridConfig.run({
        grid_levels: gridLevels, grid_upper_bound: gridUpperBound,
        grid_lower_bound: gridLowerBound, grid_manual_override: gridManualOverride,
        address: dbAddress, network,
      });
    }
    engine.reloadAssetConfig(dbAddress, row.symbol, {
      strategyType: params.strategyType as 'threshold' | 'sma' | 'grid',
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

  // ── Wallet reset ────────────────────────────────────────────────────────────
  app.post('/api/wallet/reset', (_req, res) => {
    settingQueries.upsertSetting.run('EXPECTED_WALLET_ADDRESS', '');
    botState.setWalletAddress(null);
    queries.insertEvent.run('wallet_reset', 'Expected wallet address cleared via web API');
    logger.info('Expected wallet address cleared via web API');
    res.json({ ok: true });
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

  // ── Candles ────────────────────────────────────────────────────────────────
  app.get('/api/candles', (req, res) => {
    const { symbol, interval = '15m', limit = '100' } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const rows = candleQueries.getCandles.all(String(symbol), botState.activeNetwork, String(interval), parseInt(String(limit)));
    res.json(rows);
  });

  // ── Scores ────────────────────────────────────────────────────────────────
  app.get('/api/scores', (_req, res) => {
    res.json(optimizer?.getLatestScores() ?? []);
  });

  // ── Rotations ─────────────────────────────────────────────────────────────
  app.get('/api/rotations', (req, res) => {
    const limit = parseInt(String(req.query.limit ?? '20'));
    const rows = rotationQueries.getRecentRotations.all(botState.activeNetwork, limit);
    res.json(rows);
  });

  // ── Risk ──────────────────────────────────────────────────────────────────
  app.get('/api/risk', (_req, res) => {
    const network = botState.activeNetwork;
    const todayPnl = dailyPnlQueries.getTodayPnl.get(network) as any;
    const rotCount = rotationQueries.getTodayRotationCount.get(network);

    // Compute current portfolio value for floor comparison
    let portfolioUsd = 0;
    for (const [sym, bal] of botState.assetBalances) {
      if (sym === 'USDC') portfolioUsd += bal;
      else if (sym === 'ETH' && botState.lastPrice) portfolioUsd += bal * botState.lastPrice;
      else {
        const priceRow = (queries.recentAssetSnapshots.all(sym, 1) as any[])[0];
        portfolioUsd += bal * (priceRow?.price_usd ?? 0);
      }
    }

    const pnl = todayPnl ? (portfolioUsd - (todayPnl.high_water ?? portfolioUsd)) : 0;
    const maxLoss = runtimeConfig.get('MAX_DAILY_LOSS_PCT') as number;
    const maxRot = runtimeConfig.get('MAX_DAILY_ROTATIONS') as number;
    const floor = runtimeConfig.get('PORTFOLIO_FLOOR_USD') as number;

    // Find highest position weight among non-USDC assets
    let maxPositionPct = 0;
    if (portfolioUsd > 0) {
      for (const [sym, bal] of botState.assetBalances) {
        if (sym === 'USDC') continue;
        let price = 0;
        if (sym === 'ETH' && botState.lastPrice) price = botState.lastPrice;
        else {
          const row = (queries.recentAssetSnapshots.all(sym, 1) as any[])[0];
          price = row?.price_usd ?? 0;
        }
        const pct = (bal * price) / portfolioUsd * 100;
        if (pct > maxPositionPct) maxPositionPct = pct;
      }
    }

    res.json({
      daily_pnl: pnl,
      daily_pnl_limit: maxLoss,
      rotations_today: (rotCount as any)?.cnt ?? 0,
      max_daily_rotations: maxRot,
      max_position_pct: maxPositionPct,
      portfolio_floor: floor,
      portfolio_usd: portfolioUsd,
      optimizer_status: !engine.optimizerEnabled ? 'disabled' : (optimizer?.isRiskOff ? 'risk-off' : 'active'),
      has_data: !!todayPnl,
    });
  });

  // ── Watchlist ─────────────────────────────────────────────────────────────
  app.get('/api/watchlist', (_req, res) => {
    res.json(watchlistManager?.getAll(botState.activeNetwork) ?? []);
  });

  app.post('/api/watchlist', (req, res) => {
    const { symbol, network, address, coinbasePair } = req.body;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    watchlistManager?.add(symbol, network ?? botState.activeNetwork, address, coinbasePair);
    res.json({ ok: true });
  });

  app.delete('/api/watchlist/:symbol', (req, res) => {
    watchlistManager?.remove(req.params.symbol, botState.activeNetwork);
    res.json({ ok: true });
  });

  // ── Optimizer toggle ──────────────────────────────────────────────────────
  app.post('/api/optimizer/toggle', (req, res) => {
    const { enabled } = req.body;
    if (enabled) engine.enableOptimizer();
    else engine.disableOptimizer();
    res.json({ ok: true, enabled: engine.optimizerEnabled });
  });

  // ── Performance / P&L ───────────────────────────────────────────────────
  app.get('/api/performance', (req, res) => {
    const network = botState.activeNetwork;
    const days = parseInt(String(req.query.days ?? '30'));

    // Portfolio value history (for chart)
    const snapshots = portfolioSnapshotQueries.getRecentSnapshots.all(days * 24 * 60); // ~1 per minute
    // Thin to ~1 per hour for response size
    const thinned: Array<{ timestamp: string; portfolio_usd: number }> = [];
    let lastHour = '';
    for (const s of snapshots.reverse()) {
      const hour = s.timestamp.slice(0, 13);
      if (hour !== lastHour) {
        thinned.push({ timestamp: s.timestamp, portfolio_usd: s.portfolio_usd });
        lastHour = hour;
      }
    }

    // Daily P&L history
    const dailyPnl = dailyPnlQueries.getRecentDailyPnl.all(network, days) as Array<{
      date: string; high_water: number; current_usd: number; rotations: number; realized_pnl: number;
    }>;

    // Compute aggregated metrics
    const todayPnl = dailyPnlQueries.getTodayPnl.get(network) as any;
    const currentUsd = todayPnl?.current_usd ?? 0;
    const todayHighWater = todayPnl?.high_water ?? currentUsd;
    const todayChange = todayHighWater > 0 ? currentUsd - todayHighWater : 0;
    const todayChangePct = todayHighWater > 0 ? (todayChange / todayHighWater) * 100 : 0;

    // 7-day and 30-day P&L from daily snapshots
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);

    const oldest7d = dailyPnl.filter(d => d.date >= sevenDaysAgo);
    const oldest30d = dailyPnl.filter(d => d.date >= thirtyDaysAgo);

    const startValue7d = oldest7d.length > 0 ? oldest7d[oldest7d.length - 1].current_usd : currentUsd;
    const startValue30d = oldest30d.length > 0 ? oldest30d[oldest30d.length - 1].current_usd : currentUsd;

    const change7d = currentUsd - startValue7d;
    const change30d = currentUsd - startValue30d;
    const change7dPct = startValue7d > 0 ? (change7d / startValue7d) * 100 : 0;
    const change30dPct = startValue30d > 0 ? (change30d / startValue30d) * 100 : 0;

    // Total P&L since first snapshot
    const firstSnapshot = thinned.length > 0 ? thinned[0] : null;
    const totalChange = firstSnapshot ? currentUsd - firstSnapshot.portfolio_usd : 0;
    const totalChangePct = firstSnapshot && firstSnapshot.portfolio_usd > 0
      ? (totalChange / firstSnapshot.portfolio_usd) * 100 : 0;

    // Rotation stats
    const totalRotations = dailyPnl.reduce((sum, d) => sum + d.rotations, 0);
    const recentRotations = rotationQueries.getRecentRotations.all(network, 20) as any[];
    const profitableRotations = recentRotations.filter(r => r.status === 'executed' && (r.actual_gain_pct ?? r.estimated_gain_pct) > 0).length;

    res.json({
      current_usd: currentUsd,
      today: { change: todayChange, change_pct: todayChangePct, rotations: todayPnl?.rotations ?? 0 },
      week: { change: change7d, change_pct: change7dPct },
      month: { change: change30d, change_pct: change30dPct },
      total: { change: totalChange, change_pct: totalChangePct, since: firstSnapshot?.timestamp ?? null },
      rotations: { total: totalRotations, recent_profitable: profitableRotations, recent_total: recentRotations.length },
      portfolio_history: thinned,
      daily_pnl: dailyPnl.reverse(),
    });
  });

  // ── Theme ─────────────────────────────────────────────────────────────────
  app.get('/api/theme', (_req, res) => {
    res.json({ theme: runtimeConfig.get('DASHBOARD_THEME') ?? 'dark' });
  });

  app.put('/api/theme', (req, res) => {
    const { theme } = req.body;
    runtimeConfig.set('DASHBOARD_THEME', theme);
    res.json({ ok: true });
  });

  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.listen(config.WEB_PORT, '0.0.0.0', () => {
    logger.info(`Web dashboard: http://0.0.0.0:${config.WEB_PORT}`);
  });
}
