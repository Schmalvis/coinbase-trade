import type { MCPClient } from './client.js';

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
      // Parse text like "- Native Balance: 0.05 ETH"
      const addressMatch = raw.match(/Address:\s*(0x[a-fA-F0-9]+)/);
      const balanceMatch = raw.match(/Native Balance:\s*([\d.]+)\s*ETH/);
      const networkMatch = raw.match(/Network ID:\s*(\S+)/);
      return {
        address: addressMatch?.[1] ?? '',
        network: networkMatch?.[1] ?? 'base-sepolia',
        balance: balanceMatch?.[1] ?? '0',
      };
    }
    return raw;
  }

  async getSwapPrice(fromAsset: string, toAsset: string, amount: string): Promise<SwapPrice> {
    return this.mcp.callTool('CdpEvmWalletActionProvider_get_swap_price', {
      fromAssetId: fromAsset,
      toAssetId: toAsset,
      amount,
    });
  }

  async swap(fromAsset: string, toAsset: string, amount: string): Promise<SwapResult> {
    return this.mcp.callTool('CdpEvmWalletActionProvider_swap', {
      fromAssetId: fromAsset,
      toAssetId: toAsset,
      amount,
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
}
