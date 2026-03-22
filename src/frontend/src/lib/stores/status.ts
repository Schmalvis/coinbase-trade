import { writable } from 'svelte/store';
import type { StatusData } from '../types';
import { fetchStatus } from '../api';

export const status = writable<StatusData | null>(null);

export async function loadStatus() {
  try {
    const data = await fetchStatus();
    status.set(data);
  } catch (e) {
    console.warn('loadStatus failed', e);
  }
}
