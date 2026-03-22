import type {
  StatusData,
  AssetData,
  CandleData,
  ScoreData,
  RiskData,
  PerformanceData,
  TradeData,
  SettingsData,
} from './types';

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    if (res.status === 401) {
      // Session expired — redirect to login
      window.location.href = '/auth/login';
      throw new Error('Session expired');
    }
    const text = await res.text().catch(() => '');
    console.error(`API GET ${url} failed: ${res.status} ${res.statusText}`, text);
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function put<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function del<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: 'DELETE', credentials: 'same-origin' });
  return res.json();
}

// Status
export const fetchStatus = () => get<StatusData>('/api/status');
export const fetchNetworks = () => get<{ networks: string[]; active: string }>('/api/networks');

// Assets
export const fetchAssets = () => get<AssetData[]>('/api/assets');
export const enableAsset = (address: string, config?: any) =>
  post<{ ok: boolean; error?: string }>(`/api/assets/${encodeURIComponent(address)}/enable`, config);
export const dismissAsset = (address: string) =>
  post<{ ok: boolean }>(`/api/assets/${encodeURIComponent(address)}/dismiss`);
export const saveAssetConfig = (address: string, config: any) =>
  put<{ ok: boolean; error?: string }>(`/api/assets/${encodeURIComponent(address)}/config`, config);

// Candles
export const fetchCandles = (symbol: string, interval: string, limit = 100) =>
  get<CandleData[]>(`/api/candles?symbol=${symbol}&interval=${interval}&limit=${limit}`);

// Scores
export const fetchScores = () => get<ScoreData[]>('/api/scores');

// Risk
export const fetchRisk = () => get<RiskData>('/api/risk');

// Performance
export const fetchPerformance = () => get<PerformanceData>('/api/performance');

// Trades
export const fetchTrades = (limit = 20) => get<TradeData[]>(`/api/trades?limit=${limit}`);

// Settings
export const fetchSettings = () => get<SettingsData>('/api/settings');
export const saveSettings = (settings: Record<string, any>) =>
  post<{ ok: boolean; error?: string; field?: string }>('/api/settings', settings);

// Trading
export const executeTrade = (action: string, from?: string, to?: string, amount?: string) =>
  post<{ ok: boolean; txHash?: string; dryRun?: boolean }>('/api/trade', { action, from, to, amount });
export const executeControl = (action: string) => post<{ ok: boolean }>(`/api/control/${action}`);

// Network
export const switchNetwork = (network: string) => post<{ ok: boolean }>('/api/network', { network });

// Wallet
export const resetWallet = () => post<{ ok: boolean }>('/api/wallet/reset');

// Watchlist
export const fetchWatchlist = () => get<any[]>('/api/watchlist');
export const addToWatchlist = (symbol: string, network: string, address?: string) =>
  post<{ ok: boolean }>('/api/watchlist', { symbol, network, address });
export const removeFromWatchlist = (symbol: string) => del<{ ok: boolean }>(`/api/watchlist/${symbol}`);

// Optimizer
export const toggleOptimizer = (enabled: boolean) =>
  post<{ ok: boolean }>('/api/optimizer/toggle', { enabled });

// Theme
export const fetchTheme = () => get<{ theme: string }>('/api/theme');
export const saveTheme = (theme: string) => put<{ ok: boolean }>('/api/theme', { theme });

// Faucet
export const requestFaucet = (assetId: string) => post<{ ok: boolean }>('/api/faucet', { assetId });

// Auth
export const logout = () => post<{ ok: boolean }>('/auth/logout');
