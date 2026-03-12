import { CoinbaseTools, TOKEN_ADDRESSES } from '../mcp/tools.js';
import { queries } from '../data/db.js';
import { botState } from '../core/state.js';
import { logger } from '../core/logger.js';
import { config } from '../config.js';

let ethPriceFeedId: string | null = null;
let polling = false;

export async function startPortfolioTracker(tools: CoinbaseTools): Promise<() => void> {
  logger.info('Portfolio tracker started');

  // Fetch price feed ID once at startup
  try {
    ethPriceFeedId = await tools.fetchPriceFeedId('ETH') as unknown as string;
    logger.info(`ETH price feed ID: ${ethPriceFeedId}`);
  } catch (err) {
    logger.error('Failed to fetch ETH price feed ID', err);
  }

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const walletPromise = tools.getWalletDetails();
      const pricePromise = ethPriceFeedId
        ? tools.fetchPrice(ethPriceFeedId)
        : Promise.resolve(0);
      const usdcPromise = tools.getErc20Balance(TOKEN_ADDRESSES.USDC);

      const [wallet, ethPrice, usdcBalance] = await Promise.all([walletPromise, pricePromise, usdcPromise]);

      logger.debug('Wallet response', wallet);
      logger.debug('Price response', ethPrice);

      const balanceStr = (wallet as any).balance ?? (wallet as any).nativeBalance ?? '0';
      const ethBalance = parseFloat(String(balanceStr)) || 0;
      const price = parseFloat(String(ethPrice)) || 0;
      const portfolioUsd = ethBalance * price + usdcBalance;

      queries.insertSnapshot.run({
        eth_price: price,
        eth_balance: ethBalance,
        portfolio_usd: portfolioUsd,
      });

      botState.updatePrice(price);
      botState.updateBalance(ethBalance);
      botState.updateUsdcBalance(usdcBalance);

      logger.info(`Portfolio: ${ethBalance.toFixed(6)} ETH + ${usdcBalance.toFixed(2)} USDC @ $${price.toFixed(2)} = $${portfolioUsd.toFixed(2)}`);
    } catch (err) {
      logger.error('Portfolio tracker poll failed', err);
    } finally {
      polling = false;
    }
  };

  // Immediate first poll
  await poll();

  // Then on interval
  setInterval(poll, config.POLL_INTERVAL_SECONDS * 1000);

  // Return poll function so callers can trigger an immediate re-poll (e.g. on network switch)
  return poll;
}
