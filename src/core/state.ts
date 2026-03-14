import { availableNetworks } from '../config.js';

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
  private _activeNetwork: string = availableNetworks[0];
  private _assetBalances: Map<string, number> = new Map();
  private _pendingTokenCount = 0;
  private _mcpHealthy = true;

  private tradeListeners: ((n: TradeNotification) => void)[] = [];
  private statusListeners: ((s: BotStatus) => void)[] = [];
  private networkListeners: ((n: string) => void)[] = [];
  private alertListeners: ((msg: string) => void)[] = [];
  private _walletAddress: string | null = null;

  get status() { return this._status; }
  get lastPrice() { return this._lastPrice; }
  get lastBalance() { return this._lastBalance; }
  get lastUsdcBalance() { return this._lastUsdcBalance; }
  get lastTradeAt() { return this._lastTradeAt; }
  get activeNetwork() { return this._activeNetwork; }
  get availableNetworks() { return availableNetworks; }
  get isPaused() { return this._status !== 'running'; }
  get assetBalances(): ReadonlyMap<string, number> { return this._assetBalances; }
  get pendingTokenCount(): number { return this._pendingTokenCount; }
  get walletAddress(): string | null { return this._walletAddress; }
  get mcpHealthy(): boolean { return this._mcpHealthy; }

  setNetwork(network: string) {
    if (!availableNetworks.includes(network)) {
      throw new Error(`Network "${network}" not available. Options: ${availableNetworks.join(', ')}`);
    }
    this._activeNetwork = network;
    // Clear all stale data so UI and strategy don't use values from the previous network
    this._lastPrice = null;
    this._lastBalance = null;
    this._lastUsdcBalance = null;
    this._assetBalances.clear();
    this._pendingTokenCount = 0;
    this.networkListeners.forEach(l => l(network));
  }

  setStatus(s: BotStatus) {
    this._status = s;
    this.statusListeners.forEach(l => l(s));
  }

  setPendingTokenCount(n: number): void {
    this._pendingTokenCount = n;
  }

  setMcpHealthy(healthy: boolean): void { this._mcpHealthy = healthy; }

  updatePrice(price: number) { this._lastPrice = price; }

  updateAssetBalance(symbol: string, balance: number) {
    this._assetBalances.set(symbol, balance);
    if (symbol === 'ETH')  this._lastBalance = balance;
    if (symbol === 'USDC') this._lastUsdcBalance = balance;
  }

  updateBalance(balance: number) { this.updateAssetBalance('ETH', balance); }
  updateUsdcBalance(balance: number) { this.updateAssetBalance('USDC', balance); }
  recordTrade(at: Date) { this._lastTradeAt = at; }

  onTrade(listener: (n: TradeNotification) => void) { this.tradeListeners.push(listener); }
  onStatusChange(listener: (s: BotStatus) => void) { this.statusListeners.push(listener); }
  onNetworkChange(listener: (n: string) => void) { this.networkListeners.push(listener); }
  onAlert(listener: (msg: string) => void): void { this.alertListeners.push(listener); }

  setWalletAddress(addr: string | null): void { this._walletAddress = addr; }
  emitAlert(message: string): void { this.alertListeners.forEach(l => l(message)); }

  emitTrade(notification: TradeNotification) {
    this.tradeListeners.forEach(l => l(notification));
  }
}

export const botState = new BotState();
