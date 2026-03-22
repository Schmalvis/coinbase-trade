import { loadStatus } from './status';
import { loadAssets } from './assets';
import { loadScores } from './scores';
import { loadRisk } from './risk';
import { loadPerformance } from './performance';

let intervalId: ReturnType<typeof setInterval> | undefined;

async function tick() {
  await Promise.all([loadStatus(), loadAssets(), loadScores(), loadRisk(), loadPerformance()]);
}

export function startPolling(ms = 5000) {
  tick(); // immediate first load
  intervalId = setInterval(tick, ms);
}

export function stopPolling() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = undefined;
  }
}
