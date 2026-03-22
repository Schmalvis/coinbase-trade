import { writable } from 'svelte/store';
import type { ScoreData } from '../types';
import { fetchScores } from '../api';

export const scores = writable<ScoreData[]>([]);

export async function loadScores() {
  try {
    const data = await fetchScores();
    scores.set(data);
  } catch (e) {
    console.warn('loadScores failed', e);
  }
}
