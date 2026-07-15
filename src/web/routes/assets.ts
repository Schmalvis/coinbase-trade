import { Router } from 'express';
import { botState } from '../../core/state.js';
import { queries, discoveredAssetQueries, candleQueries, runTransaction } from '../../data/db.js';
import type { DiscoveredAssetRow } from '../../data/db.js';
import { TCP_MIN_1H_CANDLES } from '../../strategy/constants.js';
import { assetsForNetwork } from '../../assets/registry.js';
import type { RouteContext } from '../route-context.js';
import { rowToAssetParams } from '../../trading/engine.js';

function validateAssetParams(p: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if ('strategyType' in p && !['threshold', 'sma', 'grid', 'momentum-burst', 'volatility-breakout', 'trend-continuation'].includes(p.strategyType as string)) {
    errors.push('strategyType must be threshold, sma, grid, momentum-burst, volatility-breakout, or trend-continuation');
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

function checkTcpCandleRequirement(symbol: string, network: string): string | null {
  const candles = candleQueries.getCandles.all(symbol, network, '1h', TCP_MIN_1H_CANDLES) as unknown[];
  if (candles.length < TCP_MIN_1H_CANDLES) {
    return `trend-continuation requires ${TCP_MIN_1H_CANDLES} × 1h candles for ${symbol} — only ${candles.length} available. Wait until more price history accumulates (approximately ${Math.ceil((TCP_MIN_1H_CANDLES - candles.length) / 24)} more days).`;
  }
  return null;
}

// C7 — promotion quality gate. A discovered token must not become tradeable until it has a
// stable positive price AND a viable two-way market. This blocks the root cause of the $0-price
// spam-token buys: illiquid/unpriceable tokens going active and then being bought with real USDC.
const PROMOTION_MIN_PRICED_SNAPSHOTS = 3;      // N consecutive snapshots all priced > $0
const PROMOTION_MAX_ROUNDTRIP_LOSS_PCT = 15;   // reject if a $2 buy→sell round-trip loses more than this
const PROMOTION_SHADOW_MS = 24 * 60 * 60 * 1000; // dry-run window after promotion

function isRegistrySymbol(symbol: string, network: string): boolean {
  return assetsForNetwork(network).some(a => a.symbol.toUpperCase() === symbol.toUpperCase());
}

async function assertPromotable(
  tools: RouteContext['tools'],
  row: DiscoveredAssetRow,
  network: string,
): Promise<{ ok: boolean; reason?: string }> {
  // 1. Price sanity — the N most-recent snapshots must all be priced > 0.
  const snaps = queries.recentAssetSnapshots.all(row.symbol, PROMOTION_MIN_PRICED_SNAPSHOTS) as { price_usd: number }[];
  if (snaps.length < PROMOTION_MIN_PRICED_SNAPSHOTS || !snaps.every(s => s.price_usd > 0)) {
    return { ok: false, reason: `${row.symbol}: needs ${PROMOTION_MIN_PRICED_SNAPSHOTS} consecutive priced (>$0) snapshots before it can be enabled` };
  }
  if (!row.address) {
    return { ok: false, reason: `${row.symbol}: missing contract address — cannot verify liquidity` };
  }

  // 2. Round-trip quote USDC → token → USDC. Confirms real buy liquidity AND that the token
  //    can be sold back (basic honeypot / one-way-liquidity screen). Any quote failure blocks.
  try {
    const buyQuote = await tools.getSwapPrice('USDC' as any, row.symbol as any, '2', undefined, row.address);
    const tokenOut = parseFloat(buyQuote.toAmount);
    if (buyQuote.priceImpact === 'no_liquidity' || !(tokenOut > 0)) {
      return { ok: false, reason: `${row.symbol}: no buy liquidity (USDC→${row.symbol} quote empty)` };
    }
    const sellQuote = await tools.getSwapPrice(row.symbol as any, 'USDC' as any, tokenOut.toString(), row.address, undefined);
    const usdcBack = parseFloat(sellQuote.toAmount);
    if (sellQuote.priceImpact === 'no_liquidity' || !(usdcBack > 0)) {
      return { ok: false, reason: `${row.symbol}: cannot sell back (${row.symbol}→USDC quote empty — possible honeypot)` };
    }
    const roundtripLossPct = (1 - usdcBack / 2) * 100;
    if (roundtripLossPct > PROMOTION_MAX_ROUNDTRIP_LOSS_PCT) {
      return { ok: false, reason: `${row.symbol}: round-trip loss ${roundtripLossPct.toFixed(1)}% > ${PROMOTION_MAX_ROUNDTRIP_LOSS_PCT}% — too illiquid to trade` };
    }
  } catch (err) {
    return { ok: false, reason: `${row.symbol}: liquidity quote failed (${err instanceof Error ? err.message : String(err)}) — not enabled` };
  }

  return { ok: true };
}

export function registerAssetsRoutes(router: Router, ctx: RouteContext): void {
  const { engine, tools } = ctx;

  router.get('/api/assets', (_req, res) => {
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

  // POST /api/assets/bulk-enable — must be before /:address/enable
  router.post('/api/assets/bulk-enable', async (req, res) => {
    const { addresses } = req.body as { addresses: string[] };
    if (!Array.isArray(addresses) || addresses.length === 0) {
      return res.status(400).json({ error: 'addresses must be a non-empty array' });
    }
    const network = botState.activeNetwork;
    const allAssets = discoveredAssetQueries.getDiscoveredAssets.all(network) as DiscoveredAssetRow[];

    const assetByAddress = new Map(allAssets.map(r => [r.address.toLowerCase(), r]));
    const candidates: DiscoveredAssetRow[] = [];
    let skipped = 0;
    for (const address of addresses) {
      const row = assetByAddress.get(address.toLowerCase());
      if (!row || row.status !== 'pending') { skipped++; continue; }
      candidates.push(row);
    }

    // C7: run the promotion quality gate on each candidate; only those that pass go active.
    const toEnable: DiscoveredAssetRow[] = [];
    const rejected: string[] = [];
    for (const row of candidates) {
      if (!isRegistrySymbol(row.symbol, network)) {
        const gate = await assertPromotable(tools, row, network);
        if (!gate.ok) { rejected.push(gate.reason ?? row.symbol); skipped++; continue; }
      }
      toEnable.push(row);
    }

    runTransaction(() => {
      for (const row of toEnable) {
        discoveredAssetQueries.updateAssetStatus.run({ status: 'active', address: row.address, network });
        // C7: 24h shadow (dry-run) period after promotion for non-registry tokens.
        if (!isRegistrySymbol(row.symbol, network)) {
          discoveredAssetQueries.setShadowUntil.run({ shadow_until: Date.now() + PROMOTION_SHADOW_MS, symbol: row.symbol, network });
        }
      }
    });

    for (const row of toEnable) {
      engine.startAssetLoop(row.address, row.symbol, rowToAssetParams(row));
    }

    const allDiscovered = discoveredAssetQueries.getDiscoveredAssets.all(network) as DiscoveredAssetRow[];
    botState.setPendingTokenCount(allDiscovered.filter(r => r.status === 'pending').length);
    return res.json({ ok: true, succeeded: toEnable.length, skipped, rejected });
  });

  // POST /api/assets/bulk-dismiss — must be before /:address/dismiss
  router.post('/api/assets/bulk-dismiss', (req, res) => {
    const { addresses } = req.body as { addresses: string[] };
    if (!Array.isArray(addresses) || addresses.length === 0) {
      return res.status(400).json({ error: 'addresses must be a non-empty array' });
    }
    const network = botState.activeNetwork;
    const allAssets = discoveredAssetQueries.getDiscoveredAssets.all(network) as DiscoveredAssetRow[];

    const assetByAddress = new Map(allAssets.map(r => [r.address.toLowerCase(), r]));
    const toProcess: DiscoveredAssetRow[] = [];
    let skipped = 0;
    for (const address of addresses) {
      const row = assetByAddress.get(address.toLowerCase());
      if (!row || row.status !== 'pending') { skipped++; continue; }
      toProcess.push(row);
    }

    runTransaction(() => {
      for (const row of toProcess) {
        discoveredAssetQueries.dismissAsset.run(row.address, network);
      }
    });

    for (const row of toProcess) {
      engine.stopAssetLoop(row.symbol);
    }

    const allDiscovered = discoveredAssetQueries.getDiscoveredAssets.all(network) as DiscoveredAssetRow[];
    botState.setPendingTokenCount(allDiscovered.filter(r => r.status === 'pending').length);
    return res.json({ ok: true, succeeded: toProcess.length, skipped });
  });

  // POST /api/assets/:address/enable
  router.post('/api/assets/:address/enable', async (req, res) => {
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

    if (body.strategyType === 'trend-continuation') {
      const allForCheck = discoveredAssetQueries.getDiscoveredAssets.all(botState.activeNetwork) as DiscoveredAssetRow[];
      const rowForCheck = allForCheck.find(r =>
        r.address.toLowerCase() === (req.params.address as string).toLowerCase() ||
        r.symbol.toLowerCase() === (req.params.address as string).toLowerCase()
      );
      if (rowForCheck) {
        const candleErr = checkTcpCandleRequirement(rowForCheck.symbol, botState.activeNetwork);
        if (candleErr) return res.status(400).json({ error: candleErr });
      }
    }

    let row = discoveredAssetQueries.getAssetByAddress.get(address, network) as DiscoveredAssetRow | undefined;
    if (!row) {
      const allAssets = discoveredAssetQueries.getDiscoveredAssets.all(network) as DiscoveredAssetRow[];
      row = allAssets.find(r => r.address.toLowerCase() === address.toLowerCase() || r.symbol.toLowerCase() === address.toLowerCase());
    }
    if (!row) return res.status(404).json({ error: `Asset ${address} not found on ${network}` });

    // C7: quality gate — non-registry tokens must pass price-stability + round-trip liquidity
    // checks before going live. Registry assets (ETH/CBBTC/CBETH) are exempt.
    if (!isRegistrySymbol(row.symbol, network)) {
      const gate = await assertPromotable(tools, row, network);
      if (!gate.ok) return res.status(400).json({ error: gate.reason });
    }

    const dbAddress = row.address;
    const params = body as { strategyType: string; dropPct: number; risePct: number; smaShort: number; smaLong: number; smaUseEma?: boolean; smaVolumeFilter?: boolean; smaRsiFilter?: boolean };
    discoveredAssetQueries.updateAssetStrategyConfig.run({
      address: dbAddress, network,
      strategy: params.strategyType,
      drop_pct: params.dropPct,
      rise_pct: params.risePct,
      sma_short: params.smaShort,
      sma_long: params.smaLong,
      sma_use_ema: params.smaUseEma !== false ? 1 : 0,
      sma_volume_filter: params.smaVolumeFilter !== false ? 1 : 0,
      sma_rsi_filter: params.smaRsiFilter !== false ? 1 : 0,
    });
    discoveredAssetQueries.updateAssetStatus.run({
      status: 'active',
      address: dbAddress,
      network,
    });
    // C7: start a 24h shadow (dry-run) period for newly-promoted non-registry tokens so live
    // trades are deferred while behaviour is observed. Mirrors apply-status.ts semantics.
    if (!isRegistrySymbol(row.symbol, network)) {
      discoveredAssetQueries.setShadowUntil.run({ shadow_until: Date.now() + PROMOTION_SHADOW_MS, symbol: row.symbol, network });
    }
    // Re-read AFTER all writes so the live loop matches persisted state exactly
    // (sma flags, grid bounds incl. nulled-to-auto, defaulting applied by the write).
    const fresh = (discoveredAssetQueries.getAssetByAddress.get(dbAddress, network) as DiscoveredAssetRow | undefined) ?? row;
    engine.startAssetLoop(dbAddress, fresh.symbol, rowToAssetParams(fresh));
    const allDiscovered = discoveredAssetQueries.getDiscoveredAssets.all(network) as DiscoveredAssetRow[];
    botState.setPendingTokenCount(allDiscovered.filter(r => r.status === 'pending').length);
    return res.json({ ok: true });
  });

  // POST /api/assets/:address/dismiss
  router.post('/api/assets/:address/dismiss', (req, res) => {
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
  router.put('/api/assets/:address/config', (req, res) => {
    const { address } = req.params;
    const network = botState.activeNetwork;

    // Cascade: exact address → case-insensitive address → symbol fallback
    let row = discoveredAssetQueries.getAssetByAddress.get(address, network) as DiscoveredAssetRow | undefined;
    if (!row) {
      // Case-insensitive address match
      const allAssets = discoveredAssetQueries.getDiscoveredAssets.all(network) as DiscoveredAssetRow[];
      row = allAssets.find(r => r.address.toLowerCase() === address.toLowerCase());
    }
    if (!row) {
      // Symbol fallback (handles registry assets whose sentinel address differs from frontend)
      row = discoveredAssetQueries.getAssetBySymbol.get(address, network) as DiscoveredAssetRow | undefined;
    }
    if (!row) return res.status(404).json({ error: `Asset ${address} not found on ${network}` });

    const body = req.body as Record<string, unknown>;
    const errors = validateAssetParams(body);
    if (errors.length) return res.status(400).json({ error: errors[0] });

    if (body.strategyType === 'trend-continuation') {
      const candleErr = checkTcpCandleRequirement(row.symbol, network);
      if (candleErr) return res.status(400).json({ error: candleErr });
    }

    const params = body as { strategyType: string; dropPct: number; risePct: number; smaShort: number; smaLong: number; smaUseEma?: boolean; smaVolumeFilter?: boolean; smaRsiFilter?: boolean };
    const dbAddress = row.address; // use the address from DB, not the request param
    discoveredAssetQueries.updateAssetStrategyConfig.run({
      address: dbAddress, network,
      strategy: params.strategyType,
      drop_pct: params.dropPct,
      rise_pct: params.risePct,
      sma_short: params.smaShort,
      sma_long: params.smaLong,
      sma_use_ema: params.smaUseEma !== false ? 1 : 0,
      sma_volume_filter: params.smaVolumeFilter !== false ? 1 : 0,
      sma_rsi_filter: params.smaRsiFilter !== false ? 1 : 0,
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
    // Re-read AFTER all writes so the live loop matches persisted state exactly
    // (sma flags, grid bounds incl. nulled-to-auto, defaulting applied by the write).
    const fresh = (discoveredAssetQueries.getAssetByAddress.get(dbAddress, network) as DiscoveredAssetRow | undefined) ?? row;
    engine.reloadAssetConfig(dbAddress, fresh.symbol, rowToAssetParams(fresh));
    return res.json({ ok: true });
  });
}
