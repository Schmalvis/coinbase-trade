import type { MCPClient } from './client.js';

// Contract addresses on base-sepolia
export const TOKEN_ADDRESSES = {
  ETH:  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
} as const;

export type TokenSymbol = keyof typeof TOKEN_ADDRESSES;

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

  async getSwapPrice(fromSymbol: TokenSymbol, toSymbol: TokenSymbol, amount: string): Promise<SwapPrice> {
    return this.mcp.callTool('CdpEvmWalletActionProvider_get_swap_price', {
      fromToken: TOKEN_ADDRESSES[fromSymbol],
      toToken: TOKEN_ADDRESSES[toSymbol],
      fromAmount: amount,
    });
  }

  async swap(fromSymbol: TokenSymbol, toSymbol: TokenSymbol, amount: string): Promise<SwapResult> {
    return this.mcp.callTool('CdpEvmWalletActionProvider_swap', {
      fromToken: TOKEN_ADDRESSES[fromSymbol],
      toToken: TOKEN_ADDRESSES[toSymbol],
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
}
