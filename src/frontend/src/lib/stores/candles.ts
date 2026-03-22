import { writable } from 'svelte/store';
import type { CandleData } from '../types';
import { fetchCandles } from '../api';

export const candles = writable<CandleData[]>([]);

export async function loadCandles(symbol: string, interval: string, limit = 100) {
  try {
    const data = await fetchCandles(symbol, interval, limit);
    candles.set(data);
  } catch (e) {
    console.warn('loadCandles failed', e);
  }
}
