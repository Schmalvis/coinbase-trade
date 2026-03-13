import { CoinbaseTools } from '../mcp/tools.js';
import { queries } from '../data/db.js';
import { botState } from '../core/state.js';
import { logger } from '../core/logger.js';
import type { RuntimeConfig } from '../core/runtime-config.js';
import { assetsForNetwork, type AssetDefinition } from '../assets/registry.js';

const pythFeedIds = new Map<string, string>(); // pythSymbol → feedId
let polling = false;

export async function startPortfolioTracker(
  tools: CoinbaseTools,
  runtimeConfig: RuntimeConfig,
): Promise<() => void> {
  logger.info('Portfolio tracker started');

  async function fetchAssetPrice(asset: AssetDefinition): Promise<number> {
    if (asset.priceSource === 'pyth' && asset.pythSymbol) {
      let feedId = pythFeedIds.get(asset.pythSymbol);
      if (!feedId) {
        feedId = await tools.fetchPriceFeedId(asset.pythSymbol) as unknown as string;
        pythFeedIds.set(asset.pythSymbol, feedId);
      }
      return tools.fetchPrice(feedId);
    }
    if (asset.priceSource === 'defillama') {
      const network = botState.activeNetwork;
      const addr = asset.addresses[network as keyof typeof asset.addresses];
      if (!addr) return 0;
      const prices = await tools.getTokenPrices([`base:${addr}`]);
      const key = `base:${addr}`;
      return (prices[key] as any)?.usd ?? 0;
    }
    return 0;
  }

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const network = botState.activeNetwork;
      const assets  = assetsForNetwork(network);
      const wallet  = await tools.getWalletDetails();
      const balanceStr = (wallet as any).balance ?? (wallet as any).nativeBalance ?? '0';
      const ethBalance = parseFloat(String(balanceStr)) || 0;

      let portfolioUsd = 0;

      for (const asset of assets) {
        try {
          let balance: number;
          let price: number;

          if (asset.isNative) {
            balance = ethBalance;
            price   = await fetchAssetPrice(asset);
          } else {
            const addr = asset.addresses[network as keyof typeof asset.addresses]!;
            [balance, price] = await Promise.all([
              tools.getErc20Balance(addr),
              fetchAssetPrice(asset),
            ]);
          }

          portfolioUsd += balance * price;
          queries.insertAssetSnapshot.run({ symbol: asset.symbol, price_usd: price, balance });
          botState.updateAssetBalance(asset.symbol, balance);

          // Keep legacy price_snapshots alive for ETH (existing /api/prices default)
          if (asset.symbol === 'ETH') {
            queries.insertSnapshot.run({ eth_price: price, eth_balance: balance, portfolio_usd: 0 });
            botState.updatePrice(price);
          }

          logger.debug(`${asset.symbol}: balance=${balance} price=$${price.toFixed(2)}`);
        } catch (err) {
          logger.error(`Failed to poll ${asset.symbol}`, err);
        }
      }

      queries.insertPortfolioSnapshot.run({ portfolio_usd: portfolioUsd });
      logger.info(`Portfolio: $${portfolioUsd.toFixed(2)}`);
    } catch (err) {
      logger.error('Portfolio tracker poll failed', err);
    } finally {
      polling = false;
    }
  };

  let intervalId: ReturnType<typeof setInterval> | null = null;

  const startPolling = () => {
    if (intervalId) clearInterval(intervalId);
    const ms = (runtimeConfig.get('POLL_INTERVAL_SECONDS') as number) * 1000;
    intervalId = setInterval(poll, ms);
    logger.info(`Portfolio tracker polling every ${ms}ms`);
  };

  runtimeConfig.subscribe('POLL_INTERVAL_SECONDS', () => startPolling());

  await poll();
  startPolling();

  return poll;
}
