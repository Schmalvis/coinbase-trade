export interface StatusData {
  status: string;
  ethPrice: number | null;
  ethBalance: number;
  usdcBalance: number;
  portfolioUsd: number;
  walletAddress: string | null;
  network: string;
  strategy: string;
  mcpHealthy: boolean;
  optimizerEnabled: boolean;
  optimizerMode: string;
  lastTradeAt: string | null;
}

export interface AssetData {
  address: string;
  symbol: string;
  name: string;
  status: 'pending' | 'active' | 'dismissed';
  strategy: string;
  price: number;
  balance: number;
  value: number;
  weight: number;
  score: number | null;
  change24h: number | null;
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
  sma_use_ema: number;
  sma_volume_filter: number;
  sma_rsi_filter: number;
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
  signals: Record<string, { signal: string; strength: number }>;
}

export interface RiskData {
  dailyPnl: { value: number; limit: number } | null;
  rotationsToday: { count: number; limit: number } | null;
  maxPosition: { symbol: string; pct: number; limit: number } | null;
  portfolioFloor: { value: number; floor: number } | null;
  optimizerStatus: string;
}

export interface PerformanceData {
  today: { pnl: number; pct: number };
  week: { pnl: number; pct: number };
  month: { pnl: number; pct: number };
  total: { pnl: number; pct: number };
  portfolioHistory: { timestamp: string; value: number }[];
  priceHistory: { timestamp: string; price: number }[];
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
}

export interface SettingsData {
  [key: string]: string | number | boolean;
}
