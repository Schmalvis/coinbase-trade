export interface AlchemyTokenBalance {
  contractAddress: string;
  tokenBalance: string;  // hex-encoded, e.g. "0x1a2b..."
}

export class AlchemyService {
  constructor(private readonly apiKey: string) {}

  private baseUrl(network: string): string {
    const host = network === 'base-mainnet'
      ? 'base-mainnet.g.alchemy.com'
      : 'base-sepolia.g.alchemy.com';
    return `https://${host}/v2/${this.apiKey}`;
  }

  private async post(network: string, body: unknown): Promise<unknown> {
    const res = await fetch(this.baseUrl(network), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Alchemy HTTP ${res.status}`);
    const json = await res.json() as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(`Alchemy RPC error: ${json.error.message}`);
    return json.result;
  }

  async getTokenBalances(walletAddress: string, network: string): Promise<AlchemyTokenBalance[]> {
    const result = await this.post(network, {
      jsonrpc: '2.0', method: 'alchemy_getTokenBalances',
      params: [walletAddress, 'erc20'], id: 1,
    }) as { tokenBalances: AlchemyTokenBalance[] };
    return result.tokenBalances;
  }

  async getTokenMetadata(contractAddress: string, network: string): Promise<{ symbol: string; name: string; decimals: number }> {
    return this.post(network, {
      jsonrpc: '2.0', method: 'alchemy_getTokenMetadata',
      params: [contractAddress], id: 1,
    }) as Promise<{ symbol: string; name: string; decimals: number }>;
  }
}
