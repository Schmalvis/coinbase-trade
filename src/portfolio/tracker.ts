import { CoinbaseTools } from '../mcp/tools.js';
import { queries, discoveredAssetQueries, settingQueries, type DiscoveredAssetRow } from '../data/db.js';
import { botState } from '../core/state.js';
import { logger } from '../core/logger.js';
import type { RuntimeConfig } from '../core/runtime-config.js';
import { assetsForNetwork, type AssetDefinition } from '../assets/registry.js';
import { AlchemyService } from '../services/alchemy.js';
import type { CandleService } from '../services/candles.js';

const pythFeedIds = new Map<string, string>(); // pythSymbol → feedId
let polling = false;

export async function startPortfolioTracker(
  tools: CoinbaseTools,
  runtimeConfig: RuntimeConfig,
  alchemyService?: AlchemyService,
  candleService?: CandleService,
): Promise<() => void> {
  logger.info('Portfolio tracker started');

  async function fetchAssetPrice(asset: AssetDefinition): Promise<number> {
    if (asset.priceSource === 'fixed') {
      return asset.fixedPrice ?? 1;
    }
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

      // Wallet address integrity check — scoped per network since each network has its own wallet
      const walletAddress = (wallet as any).address as string | undefined;
      if (walletAddress) {
        const settingKey = `EXPECTED_WALLET_ADDRESS_${network}`;
        const stored = settingQueries.getSetting.get(settingKey);
        if (!stored || !stored.value) {
          settingQueries.upsertSetting.run(settingKey, walletAddress);
          botState.setWalletAddress(walletAddress);
          logger.info(`Wallet address established for ${network}: ${walletAddress}`);
        } else if (walletAddress.toLowerCase() !== stored.value.toLowerCase()) {
          const msg = `⚠️ WALLET ADDRESS CHANGED on ${network}: expected ${stored.value}, got ${walletAddress}`;
          logger.error(msg);
          botState.setStatus('paused');
          botState.emitAlert(msg);
          // Intentionally do NOT update stored.value — preserve expected address for next comparison
        } else {
          botState.setWalletAddress(walletAddress);
        }
      } else {
        // walletAddress absent in response
        const settingKey = `EXPECTED_WALLET_ADDRESS_${network}`;
        const stored = settingQueries.getSetting.get(settingKey);
        if (stored?.value) {
          logger.warn(`Wallet address absent in MCP response (expected ${stored.value} on ${network})`);
        }
      }

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
          if (price > 0) candleService?.recordSpotPrice(asset.symbol, network, price);

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

      if (alchemyService) {
        try {
          const network = botState.activeNetwork;
          const wallet = await tools.getWalletDetails();
          const walletAddress = (wallet as any).address;
          if (!walletAddress) throw new Error('wallet address unavailable');

          // Fetch all ERC20 balances
          const tokenBalances = await alchemyService.getTokenBalances(walletAddress, network);

          // Build hex balance lookup: contractAddress (lowercase) → hex balance
          const hexBalanceMap = new Map<string, string>();
          for (const tb of tokenBalances) {
            hexBalanceMap.set(tb.contractAddress.toLowerCase(), tb.tokenBalance);
          }

          // Skip tokens already in static registry (by address or symbol)
          const networkAssets = assetsForNetwork(network);
          const registryAddresses = new Set(
            networkAssets.map(a => {
              const addr = a.addresses[network as keyof typeof a.addresses];
              return addr ? addr.toLowerCase() : null;
            }).filter(Boolean)
          );
          const registrySymbols = new Set(networkAssets.map(a => a.symbol.toUpperCase()));

          // Insert new tokens (INSERT OR IGNORE — status='pending' by default)
          for (const tb of tokenBalances) {
            const addr = tb.contractAddress.toLowerCase();
            if (registryAddresses.has(addr)) continue;

            const existing = discoveredAssetQueries.getAssetByAddress.get(tb.contractAddress, network);
            if (!existing) {
              try {
                const meta = await alchemyService.getTokenMetadata(tb.contractAddress, network);
                // Skip tokens whose symbol matches a registry asset (e.g., WETH vs ETH)
                if (registrySymbols.has(meta.symbol.toUpperCase())) {
                  logger.debug(`Skipping discovered ${meta.symbol} — matches registry asset`);
                  continue;
                }
                discoveredAssetQueries.upsertDiscoveredAsset.run({
                  address: tb.contractAddress,
                  network,
                  symbol: meta.symbol,
                  name: meta.name,
                  decimals: meta.decimals,
                });
                logger.debug(`Discovered new token: ${meta.symbol} (${tb.contractAddress})`);
              } catch (err) {
                logger.debug(`Skipping token ${tb.contractAddress}: metadata unavailable`);
              }
            }
          }

          // Update pendingTokenCount
          const allDiscovered = discoveredAssetQueries.getDiscoveredAssets.all(network) as DiscoveredAssetRow[];
          const pendingCount = allDiscovered.filter(r => r.status === 'pending').length;
          botState.setPendingTokenCount(pendingCount);

          // Price all active+pending discovered assets via DefiLlama
          // Skip registry assets — they're already priced/balanced by the main poll loop above
          const activePending = allDiscovered.filter(r => r.status !== 'dismissed' && !registrySymbols.has(r.symbol.toUpperCase()));
          for (const row of activePending) {
            try {
              const prices = await tools.getTokenPrices([`base:${row.address}`]);
              const price = (prices[`base:${row.address}`] as any)?.usd ?? 0;
              queries.insertAssetSnapshot.run({ symbol: row.symbol, price_usd: price, balance: 0 });

              // Update balance from hex balance
              const hexBal = hexBalanceMap.get(row.address.toLowerCase());
              const humanBalance = hexBal
                ? Number(BigInt(hexBal)) / Math.pow(10, row.decimals)
                : 0;
              botState.updateAssetBalance(row.symbol, humanBalance);
              if (price > 0) candleService?.recordSpotPrice(row.symbol, network, price);
            } catch (err) {
              logger.error(`Failed to price/balance discovered asset ${row.symbol}`, err);
            }
          }
        } catch (err) {
          logger.warn('Alchemy discovery step failed, skipping', err);
        }
      }
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
