export type Signal = 'buy' | 'sell' | 'hold';

export interface Snapshot {
  eth_price: number;
  eth_balance: number;
  portfolio_usd: number;
  timestamp: string;
}

export interface StrategyResult {
  signal: Signal;
  reason: string;
}

export interface Strategy {
  name: string;
  evaluate(snapshots: Snapshot[]): StrategyResult;
}
