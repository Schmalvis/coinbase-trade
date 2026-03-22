// Shared mutable state used across all frontend modules
declare const Chart: any;

export const appState = {
  assetList: [] as any[],
  activeChartAsset: 'ETH',
  activeTimeframe: '15m',
  expandedAssetAddress: null as string | null,
  fullWalletAddress: '',
  walletExpanded: false,
  availableNetworks: [] as string[],
  activeNetwork: '',
  scoresData: {} as Record<string, any>,
  settingsCache: {} as Record<string, any>,
  selectedStrategy: 'threshold',
  tradePair: { from: 'ETH', to: 'USDC' },
  tradeSide: 'from' as string,
  tradeQuotedFromAmount: null as string | null,
  tradeMode: 'standard' as string,
  // Chart instances
  priceChart: null as any,
  portfolioChart: null as any,
  candleChart: null as any,
  pnlChart: null as any,
};
