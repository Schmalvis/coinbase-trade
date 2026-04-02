import { writable } from 'svelte/store';
import type { TradeData } from '../types';
import { fetchTrades } from '../api';

export const trades = writable<TradeData[]>([]);

export async function loadTrades() {
  try {
    const data = await fetchTrades(30);
    trades.set(data);
  } catch (e) {
    console.warn('loadTrades failed', e);
  }
}
