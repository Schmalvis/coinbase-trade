import { Router } from 'express';
import { botState } from '../../core/state.js';
import { queries, discoveredAssetQueries } from '../../data/db.js';
import type { DiscoveredAssetRow } from '../../data/db.js';
import type { RouteContext } from '../route-context.js';

export function registerStatusRoutes(router: Router, ctx: RouteContext): void {
  const { runtimeConfig, engine, optimizer } = ctx;

  router.get('/api/status', (_req, res) => {
    // Use tracker's portfolio snapshot as the authoritative value (it has full MCP context)
    const latestSnapshot = (queries.recentPortfolioSnapshots?.all(1) as any[])?.[0];
    let portfolioUsd = latestSnapshot?.portfolio_usd ?? 0;

    // Fallback: compute from DB asset snapshots if no portfolio snapshot yet
    if (portfolioUsd === 0) {
      for (const [sym, bal] of botState.assetBalances) {
        let price: number;
        if (sym === 'USDC') {
          price = 1.0;
        } else {
          const snap = queries.getLatestAssetSnapshot?.get(sym) as { price_usd: number } | undefined;
          price = snap?.price_usd ?? (sym === 'ETH' ? (botState.lastPrice ?? 0) : 0);
        }
        portfolioUsd += bal * price;
      }
    }
    // Always read balances from DB snapshots — botState is unreliable (gets cleared between poll cycles)
    const ethSnap = queries.getLatestAssetSnapshot?.get('ETH') as { balance: number; price_usd: number } | undefined;
    const usdcSnap = queries.getLatestAssetSnapshot?.get('USDC') as { balance: number; price_usd: number } | undefined;
    const ethBal = ethSnap?.balance ?? botState.lastBalance ?? 0;
    const usdcBal = usdcSnap?.balance ?? botState.lastUsdcBalance ?? 0;
    const ethPrice = ethSnap?.price_usd ?? botState.lastPrice ?? 0;
    const ethAsset = discoveredAssetQueries.getAssetBySymbol?.get('ETH', botState.activeNetwork) as DiscoveredAssetRow | undefined;
    const ethStrategy = ethAsset?.strategy ?? runtimeConfig.get('STRATEGY');
    res.json({
      status:            botState.status,
      lastPrice:         ethPrice,
      ethBalance:        ethBal,
      usdcBalance:       usdcBal,
      portfolioUsd,
      lastTradeAt:       botState.lastTradeAt,
      dryRun:            runtimeConfig.get('DRY_RUN'),
      strategy:          runtimeConfig.get('STRATEGY'),
      ethStrategy,
      activeNetwork:     botState.activeNetwork,
      availableNetworks: botState.availableNetworks,
      assetBalances:     Object.fromEntries(botState.assetBalances),
      pendingTokenCount: botState.pendingTokenCount,
      walletAddress:     botState.walletAddress,
      optimizerEnabled:  engine.optimizerEnabled,
      optimizerMode:     optimizer?.isRiskOff ? 'risk-off' : 'normal',
    });
  });

  router.get('/api/networks', (_req, res) => {
    res.json({ active: botState.activeNetwork, available: botState.availableNetworks });
  });

  router.get('/api/wallet', async (_req, res) => {
    try {
      res.json(await ctx.tools.getWalletDetails());
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
