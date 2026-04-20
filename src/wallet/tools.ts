import type { CdpWalletClient } from './client.js';
import { getTokenBalance } from './erc20.js';
import { fetchPriceFeedId, fetchPrice, getTokenPrices } from './prices.js';
import { SwapService } from './swap.js';
import type { SwapPrice, SwapResult } from './swap.js';
export type { SwapPrice, SwapResult } from './swap.js';
import { ASSET_REGISTRY } from '../assets/registry.js';
import { logger } from '../core/logger.js';

const TOKEN_ADDRESSES_BY_NETWORK: Record<string, Record<string, string>> = {
  'base-sepolia': {
    ETH:  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
  'base-mainnet': {
    ETH:  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
};

// Fallback for type usage — resolved at runtime via getTokenAddress()
export const TOKEN_ADDRESSES = TOKEN_ADDRESSES_BY_NETWORK['base-sepolia'] as {
  ETH: string; USDC: string;
};

export type TokenSymbol = string;

export interface WalletDetails {
  address: string;
  network: string;
  balance: string; // in ETH
}

export interface TokenPrice {
  [coinId: string]: { usd: number };
}

export class CoinbaseTools {
  private swapService: SwapService;

  constructor(private walletClient: CdpWalletClient) {
    this.swapService = new SwapService(walletClient);
  }

  getTokenAddress(symbol: string): string {
    const net = this.walletClient.network;
    const fromMap = (TOKEN_ADDRESSES_BY_NETWORK[net] ?? TOKEN_ADDRESSES_BY_NETWORK['base-sepolia'])[symbol];
    if (fromMap) return fromMap;
    // Fall back to ASSET_REGISTRY for tokens like CBBTC, CBETH
    const asset = ASSET_REGISTRY.find(a => a.symbol === symbol);
    return asset?.addresses?.[net as 'base-mainnet' | 'base-sepolia'] ?? asset?.addresses?.['base-mainnet'] ?? '';
  }

  async getWalletDetails(): Promise<WalletDetails> {
    const address = this.walletClient.address;
    if (!address) throw new Error('Wallet not initialised — call init() first');

    const network = this.walletClient.network;
    const balance = await getTokenBalance(
      '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      address,
      network,
      18,
    );

    return {
      address,
      network,
      balance: balance.toString(),
    };
  }

  async getErc20Balance(tokenAddress: string): Promise<number> {
    const address = this.walletClient.address;
    if (!address) throw new Error('Wallet not initialised');
    const network = this.walletClient.network;

    // Resolve decimals from registry if possible
    const asset = ASSET_REGISTRY.find(
      a => Object.values(a.addresses).some(v => v?.toLowerCase() === tokenAddress.toLowerCase())
    );
    return getTokenBalance(tokenAddress, address, network, asset?.decimals);
  }

  getErc20BalanceBySymbol(symbol: TokenSymbol): Promise<number> {
    return this.getErc20Balance(this.getTokenAddress(symbol));
  }

  async getSwapPrice(fromSymbol: TokenSymbol, toSymbol: TokenSymbol, amount: string): Promise<SwapPrice> {
    return this.swapService.getSwapPrice(
      this.getTokenAddress(fromSymbol),
      this.getTokenAddress(toSymbol),
      amount,
      this.walletClient.network,
    );
  }

  async swap(fromSymbol: TokenSymbol, toSymbol: TokenSymbol, amount: string): Promise<SwapResult> {
    return this.swapService.swap(
      this.getTokenAddress(fromSymbol),
      this.getTokenAddress(toSymbol),
      amount,
      this.walletClient.network,
    );
  }

  async getTokenPrices(tokens: string[]): Promise<TokenPrice> {
    return getTokenPrices(tokens);
  }

  async fetchPriceFeedId(symbol: string): Promise<string> {
    return fetchPriceFeedId(symbol);
  }

  async fetchPrice(priceFeedId: string): Promise<number> {
    return fetchPrice(priceFeedId);
  }

  async requestFaucetFunds(assetId = 'eth'): Promise<string> {
    const address = this.walletClient.address;
    if (!address) throw new Error('Wallet not initialised');

    const network = this.walletClient.network;
    if (network !== 'base-sepolia') {
      throw new Error(`requestFaucetFunds is only available on testnet (current: ${network})`);
    }

    logger.info(`Requesting faucet funds: ${assetId} → ${address}`);
    const result = await this.walletClient.sdk.evm.requestFaucet({
      address: address as `0x${string}`,
      network: 'base-sepolia',
      token: assetId as any,
    });
    return result.transactionHash ?? 'faucet_requested';
  }

  /**
   * Get a price quote for receiving a specific amount of the `to` token.
   * Two-step estimation: reference 1-unit quote → derive fromAmount → real quote.
   */
  async getSwapQuoteForReceiveAmount(
    from: TokenSymbol,
    to: TokenSymbol,
    desiredToAmount: string,
  ): Promise<SwapPrice> {
    // Step 1: Reference quote for rate (fromAmount is always '1')
    const refQuote = await this.getSwapPrice(from, to, '1');
    const rate = parseFloat(refQuote.toAmount);
    if (!rate || isNaN(rate) || rate <= 0) {
      throw new Error('Could not determine exchange rate from reference quote');
    }

    const estimatedFrom = (parseFloat(desiredToAmount) / rate).toFixed(8);

    // Step 2: Real quote
    return this.getSwapPrice(from, to, estimatedFrom);
  }

  /**
   * Route a swap through Enso Finance — supports any ERC20 with Base liquidity.
   * Mainnet only. tokenIn/tokenOut must be contract addresses.
   * Note: Enso is not available via CDP SDK directly; falls back to 0x or throws.
   */
  async ensoRoute(
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
    _slippage = 50,
  ): Promise<SwapResult> {
    logger.warn('ensoRoute: Enso Finance not available via CDP SDK — routing via CDP swap instead');
    return this.swapService.swap(tokenIn, tokenOut, amountIn, this.walletClient.network);
  }
}
