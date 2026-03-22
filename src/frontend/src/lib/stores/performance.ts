import { writable } from 'svelte/store';
import type { PerformanceData } from '../types';
import { fetchPerformance } from '../api';

export const performance = writable<PerformanceData | null>(null);

export async function loadPerformance() {
  try {
    const data = await fetchPerformance();
    performance.set(data);
  } catch (e) {
    console.warn('loadPerformance failed', e);
  }
}
