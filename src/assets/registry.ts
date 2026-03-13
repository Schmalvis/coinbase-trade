export type PriceSource = 'pyth' | 'defillama';
export type TradeMethod = 'agentkit' | 'enso' | 'none';

export interface AssetDefinition {
  symbol:      string;
  decimals:    number;
  addresses: {
    'base-mainnet'?: string;
    'base-sepolia'?: string;
  };
  priceSource: PriceSource;
  pythSymbol?: string;     // Pyth ticker (e.g. 'BTC' for CBBTC)
  tradeMethod: TradeMethod;
  isNative?:   boolean;    // true for ETH (balance via wallet details, not ERC20)
}

export const ASSET_REGISTRY: AssetDefinition[] = [
  {
    symbol: 'ETH',
    decimals: 18,
    addresses: {
      'base-mainnet': '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      'base-sepolia': '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    },
    priceSource: 'pyth',
    pythSymbol: 'ETH',
    tradeMethod: 'agentkit',
    isNative: true,
  },
  {
    symbol: 'USDC',
    decimals: 6,
    addresses: {
      'base-mainnet': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    },
    priceSource: 'defillama',
    tradeMethod: 'agentkit',
  },
  {
    symbol: 'CBBTC',
    decimals: 8,
    addresses: {
      'base-mainnet': '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    },
    priceSource: 'pyth',
    pythSymbol: 'BTC',
    tradeMethod: 'agentkit',
  },
  {
    symbol: 'CBETH',
    decimals: 18,
    addresses: {
      'base-mainnet': '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
    },
    priceSource: 'defillama',  // Pyth only has ETH/USD, not cbETH/USD
    tradeMethod: 'agentkit',
  },
];

/** Return assets available on the given network */
export function assetsForNetwork(network: string): AssetDefinition[] {
  return ASSET_REGISTRY.filter(
    a => a.addresses[network as keyof typeof a.addresses] !== undefined
  );
}

/** Look up a single asset by symbol (throws if not found) */
export function getAsset(symbol: string): AssetDefinition {
  const a = ASSET_REGISTRY.find(a => a.symbol === symbol);
  if (!a) throw new Error(`Asset not found in registry: ${symbol}`);
  return a;
}
