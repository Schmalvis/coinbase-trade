import { writable } from 'svelte/store';
import type { RiskData } from '../types';
import { fetchRisk } from '../api';

export const risk = writable<RiskData | null>(null);

export async function loadRisk() {
  try {
    const data = await fetchRisk();
    risk.set(data);
  } catch (e) {
    console.warn('loadRisk failed', e);
  }
}
