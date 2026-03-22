import { writable } from 'svelte/store';
import type { AssetData } from '../types';
import { fetchAssets } from '../api';

export const assets = writable<AssetData[]>([]);

export async function loadAssets() {
  try {
    const data = await fetchAssets();
    assets.set(data);
  } catch (e) {
    console.warn('loadAssets failed', e);
  }
}
