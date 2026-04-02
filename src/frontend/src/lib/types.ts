export interface StatusData {
  status: string;
  lastPrice: number | null;
  ethBalance: number;
  usdcBalance: number;
  portfolioUsd: number;
  walletAddress: string | null;
  strategy: string;
  ethStrategy: string;
  mcpHealthy: boolean;
  optimizerEnabled: boolean;
  optimizerMode: string;
  lastTradeAt: string | null;
  dryRun: boolean;
  activeNetwork: string;
  availableNetworks: string[];
  assetBalances: Record<string, number>;
  pendingTokenCount: number;
}

export interface AssetData {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  status: 'pending' | 'active' | 'dismissed';
  price: number | null;
  balance: number | null;
  change24h: number | null;
  isNative: boolean;
  tradeMethod: string;
  priceSource: string;
  source: 'registry' | 'discovered';
  strategyConfig: {
    type: string;
    dropPct: number;
    risePct: number;
    smaShort: number;
    smaLong: number;
    gridLevels: number;
    gridUpperBound: number | null;
    gridLowerBound: number | null;
  };
}

export interface CandleData {
  open_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ScoreData {
  symbol: string;
  score: number;
  confidence: number;
  signals: {
    candle15m: { signal: string; strength: number; reason: string };
    candle1h: { signal: string; strength: number; reason: string };
    candle24h: { signal: string; strength: number; reason: string };
  };
  currentWeight: number;
  isHeld: boolean;
}

export interface RiskData {
  daily_pnl: number;
  daily_pnl_pct: number;
  daily_pnl_limit: number;
  rotations_today: number;
  max_daily_rotations: number;
  max_position_pct: number;
  max_position_limit: number;
  portfolio_floor: number;
  portfolio_usd: number;
  optimizer_enabled: boolean;
  optimizer_status: string;
  has_data: boolean;
}

export interface PerformanceData {
  current_usd: number;
  today: { change: number; change_pct: number; rotations: number };
  week: { change: number; change_pct: number };
  month: { change: number; change_pct: number };
  total: { change: number; change_pct: number; since: string | null };
  rotations: { total: number; recent_profitable: number; recent_total: number };
  portfolio_history: Array<{ timestamp: string; portfolio_usd: number }>;
  daily_pnl: Array<{ date: string; high_water: number; current_usd: number; rotations: number; realized_pnl: number }>;
}

export interface TradeData {
  id: number;
  timestamp: string;
  action: string;
  amount_eth: number;
  price_usd: number;
  reason: string;
  network: string;
  tx_hash: string | null;
  dry_run: number;
  symbol: string | null;
  strategy: string | null;
}

export interface SettingsData {
  [key: string]: string | number | boolean | number[] | undefined;
}
