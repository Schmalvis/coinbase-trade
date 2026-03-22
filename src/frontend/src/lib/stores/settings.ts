import { writable } from 'svelte/store';
import type { SettingsData } from '../types';
import { fetchSettings } from '../api';

export const settings = writable<SettingsData | null>(null);

export async function loadSettings() {
  try {
    const data = await fetchSettings();
    settings.set(data);
  } catch (e) {
    console.warn('loadSettings failed', e);
  }
}
