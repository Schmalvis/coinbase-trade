import { writable } from 'svelte/store';
import type { AssetData } from '../types';
import { fetchAssets } from '../api';

export const assets = writable<AssetData[]>([]);

export async function loadAssets() {
  try {
    const data = await fetchAssets();
    if (!Array.isArray(data)) {
      console.warn('loadAssets: expected array, got', typeof data, data);
      return;
    }
    assets.set(data);
  } catch (e) {
    console.warn('loadAssets failed', e);
  }
}
