import type { MCPClient } from './client.js';
import { ASSET_REGISTRY } from '../assets/registry.js';

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

export interface SwapPrice {
  fromToken: string;
  toToken: string;
  fromAmount: string;
  toAmount: string;
  priceImpact?: string;
}

export interface SwapResult {
  txHash: string;
  status: string;
}

export interface TokenPrice {
  [coinId: string]: { usd: number };
}

export class CoinbaseTools {
  constructor(private mcp: MCPClient) {}

  getTokenAddress(symbol: string): string {
    const net = this.mcp.network;
    const fromMap = (TOKEN_ADDRESSES_BY_NETWORK[net] ?? TOKEN_ADDRESSES_BY_NETWORK['base-sepolia'])[symbol];
    if (fromMap) return fromMap;
    // Fall back to ASSET_REGISTRY for tokens like CBBTC, CBETH
    const asset = ASSET_REGISTRY.find(a => a.symbol === symbol);
    return asset?.addresses?.[net as 'base-mainnet' | 'base-sepolia'] ?? asset?.addresses?.['base-mainnet'] ?? '';
  }

  async getWalletDetails(): Promise<WalletDetails> {
    const raw = await this.mcp.callTool<WalletDetails | string>('WalletActionProvider_get_wallet_details', {});
    if (typeof raw === 'string') {
      const addressMatch = raw.match(/Address:\s*(0x[a-fA-F0-9]{40})/);
      // Prefer the ETH-denominated balance line; fall back to WEI conversion
      const ethMatch = raw.match(/Native Balance:\s*([\d.]+)\s*ETH/);
      const weiMatch = raw.match(/Native Balance:\s*(\d+)\s*WEI/);
      const networkMatch = raw.match(/Network ID:\s*(\S+)/);
      const balance = ethMatch
        ? ethMatch[1]
        : weiMatch ? (parseInt(weiMatch[1]) / 1e18).toString() : '0';
      return {
        address: addressMatch?.[1] ?? '',
        network: networkMatch?.[1] ?? 'base-sepolia',
        balance,
      };
    }
    return raw;
  }

  async getErc20Balance(tokenAddress: string): Promise<number> {
    const raw = await this.mcp.callTool<string>('ERC20ActionProvider_get_balance', { tokenAddress });
    if (typeof raw !== 'string') return 0;
    // Response: "Balance of TOKEN (...) at address 0x... is 1.5"
    const match = raw.match(/is\s+([\d.]+)\s*$/);
    return match ? parseFloat(match[1]) : 0;
  }

  getErc20BalanceBySymbol(symbol: TokenSymbol): Promise<number> {
    return this.getErc20Balance(this.getTokenAddress(symbol));
  }

  async getSwapPrice(fromSymbol: TokenSymbol, toSymbol: TokenSymbol, amount: string): Promise<SwapPrice> {
    return this.mcp.callTool('CdpEvmWalletActionProvider_get_swap_price', {
      fromToken: this.getTokenAddress(fromSymbol),
      toToken: this.getTokenAddress(toSymbol),
      fromAmount: amount,
    });
  }

  async swap(fromSymbol: TokenSymbol, toSymbol: TokenSymbol, amount: string): Promise<SwapResult> {
    return this.mcp.callTool('CdpEvmWalletActionProvider_swap', {
      fromToken: this.getTokenAddress(fromSymbol),
      toToken: this.getTokenAddress(toSymbol),
      fromAmount: amount,
    });
  }

  async getTokenPrices(tokens: string[]): Promise<TokenPrice> {
    return this.mcp.callTool('DefiLlamaActionProvider_get_token_prices', { tokens });
  }

  async fetchPriceFeedId(symbol: string): Promise<string> {
    const result = await this.mcp.callTool<{ priceFeedID?: string } | string>(
      'PythActionProvider_fetch_price_feed',
      { tokenSymbol: symbol }
    );
    if (typeof result === 'object' && result.priceFeedID) return result.priceFeedID;
    if (typeof result === 'string') return result;
    throw new Error(`Unexpected price feed response: ${JSON.stringify(result)}`);
  }

  async fetchPrice(priceFeedId: string): Promise<number> {
    const result = await this.mcp.callTool<{ price?: string | number; usd?: number } | number | string>(
      'PythActionProvider_fetch_price',
      { priceFeedID: priceFeedId }
    );
    if (typeof result === 'number') return result;
    if (typeof result === 'string') return parseFloat(result);
    if (typeof result === 'object' && result !== null) {
      const p = result.price ?? result.usd;
      return p !== undefined ? parseFloat(String(p)) : 0;
    }
    return 0;
  }

  async requestFaucetFunds(assetId = 'eth'): Promise<string> {
    const result = await this.mcp.callTool<string>('CdpApiActionProvider_request_faucet_funds', { assetId });
    return typeof result === 'string' ? result : JSON.stringify(result);
  }

  /**
   * Get a price quote for receiving a specific amount of the `to` token.
   * Uses two-step estimation since the MCP tool only accepts fromAmount.
   *
   * 1. Get rate from a 1-unit reference quote
   * 2. Estimate fromAmount = desiredToAmount / rate
   * 3. Get real quote with estimated fromAmount
   */
  async getSwapQuoteForReceiveAmount(
    from: TokenSymbol,
    to: TokenSymbol,
    desiredToAmount: string,
  ): Promise<SwapPrice> {
    // Step 1: Reference quote for rate
    const refQuote = await this.getSwapPrice(from, to, '1');
    const refFrom = parseFloat(refQuote.fromAmount);
    const refTo   = parseFloat(refQuote.toAmount);
    if (!refTo || isNaN(refTo) || refTo <= 0) throw new Error('Could not determine exchange rate from reference quote');

    const rate = refTo / refFrom; // toAmount per 1 unit of fromToken
    const estimatedFrom = (parseFloat(desiredToAmount) / rate).toFixed(8);

    // Step 2: Real quote
    return this.getSwapPrice(from, to, estimatedFrom);
  }

  /**
   * Route a swap through Enso Finance — supports any ERC20 token with Base liquidity.
   * mainnet only. tokenIn/tokenOut must be contract addresses (use ETH sentinel for native ETH).
   */
  async ensoRoute(
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
    slippage = 50,
  ): Promise<SwapResult> {
    const result = await this.mcp.callTool<SwapResult | string>(
      'EnsoActionProvider_route',
      { tokenIn, tokenOut, amountIn, slippage, network: 'base-mainnet' },
    );
    if (typeof result === 'string') {
      const hashMatch = result.match(/0x[a-fA-F0-9]{64}/);
      return { txHash: hashMatch?.[0] ?? '', status: 'executed' };
    }
    return result;
  }
}
