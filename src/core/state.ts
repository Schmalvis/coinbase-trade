export type BotStatus = 'running' | 'paused' | 'stopped';

export interface TradeNotification {
  action: 'buy' | 'sell';
  amountEth: number;
  priceUsd: number;
  txHash?: string;
  dryRun: boolean;
  reason: string;
  timestamp: Date;
}

class BotState {
  private _status: BotStatus = 'paused';
  private _lastPrice: number | null = null;
  private _lastBalance: number | null = null;
  private _lastUsdcBalance: number | null = null;
  private _lastTradeAt: Date | null = null;

  private tradeListeners: ((n: TradeNotification) => void)[] = [];
  private statusListeners: ((s: BotStatus) => void)[] = [];

  get status() { return this._status; }
  get lastPrice() { return this._lastPrice; }
  get lastBalance() { return this._lastBalance; }
  get lastUsdcBalance() { return this._lastUsdcBalance; }
  get lastTradeAt() { return this._lastTradeAt; }
  get isPaused() { return this._status !== 'running'; }

  setStatus(s: BotStatus) {
    this._status = s;
    this.statusListeners.forEach(l => l(s));
  }

  updatePrice(price: number) { this._lastPrice = price; }
  updateBalance(balance: number) { this._lastBalance = balance; }
  updateUsdcBalance(balance: number) { this._lastUsdcBalance = balance; }
  recordTrade(at: Date) { this._lastTradeAt = at; }

  onTrade(listener: (n: TradeNotification) => void) {
    this.tradeListeners.push(listener);
  }

  onStatusChange(listener: (s: BotStatus) => void) {
    this.statusListeners.push(listener);
  }

  emitTrade(notification: TradeNotification) {
    this.tradeListeners.forEach(l => l(notification));
  }
}

export const botState = new BotState();
