<script lang="ts">
  import { scores } from '../stores/scores';
  import type { ScoreData } from '../types';

  $: sorted = ($scores || []).slice().sort((a: ScoreData, b: ScoreData) => (b.score ?? 0) - (a.score ?? 0));

  function signalClass(signal: string): string {
    if (signal === 'buy') return 'bg-gain-soft text-gain';
    if (signal === 'sell') return 'bg-loss-soft text-loss';
    return 'bg-[var(--bg-inset)] text-[var(--text-muted)]';
  }

  function scoreClass(score: number): string {
    if (score > 0) return 'text-gain';
    if (score < 0) return 'text-loss';
    return 'text-[var(--text-muted)]';
  }

  // Center-anchored bar: score in [-100,100] maps to a bar that grows from
  // the 50% midline toward the right (positive) or left (negative).
  function barStyle(score: number): string {
    const clamped = Math.max(-100, Math.min(100, score ?? 0));
    const half = Math.abs(clamped) / 2; // 0..50
    if (clamped >= 0) {
      return `left: 50%; width: ${half}%;`;
    }
    return `left: ${50 - half}%; width: ${half}%;`;
  }

  // Extract signals as [label, signal] pairs from the candle signals object
  function getSignalEntries(item: ScoreData): Array<[string, { signal: string; strength: number }]> {
    if (!item.signals) return [];
    const entries: Array<[string, { signal: string; strength: number }]> = [];
    if (item.signals.candle15m) entries.push(['15m', item.signals.candle15m]);
    if (item.signals.candle1h) entries.push(['1h', item.signals.candle1h]);
    if (item.signals.candle24h) entries.push(['24h', item.signals.candle24h]);
    return entries;
  }
</script>

<div class="bg-[var(--bg-card)] rounded-[var(--radius-card)] border border-[var(--border)] shadow-[var(--shadow)] p-4">
  <div class="mb-3">
    <h2 class="text-sm font-semibold font-display text-[var(--text-primary)]">Opportunity scores</h2>
    <p class="text-xs text-[var(--text-muted)] mt-0.5">Internal optimizer signals. Higher = stronger buy case.</p>
  </div>

  {#if sorted.length === 0}
    <p class="text-sm text-[var(--text-muted)]">No scores available — waiting for candle data</p>
  {:else}
    <div class="space-y-3">
      {#each sorted as item}
        <div class="py-2 border-b border-[var(--border)] last:border-0">
          <!-- Symbol + score row -->
          <div class="flex items-center gap-3 mb-1.5">
            <span class="font-semibold text-sm w-14 text-[var(--text-primary)]">{item.symbol}</span>
            <span class="font-bold text-sm w-12 text-right font-mono tabular-nums {scoreClass(item.score ?? 0)}">
              {(item.score ?? 0) > 0 ? '+' : ''}{(item.score ?? 0).toFixed(1)}
            </span>
            <!-- Center-anchored score bar -->
            <div class="relative flex-1 h-1.5 bg-[var(--bg-inset)] rounded-full overflow-hidden">
              <span class="absolute left-1/2 top-0 bottom-0 w-px bg-[var(--border-hi)]"></span>
              <div
                class="absolute top-0 bottom-0 rounded-full transition-all duration-500"
                class:bg-gain={(item.score ?? 0) >= 0}
                class:bg-loss={(item.score ?? 0) < 0}
                style={barStyle(item.score ?? 0)}
              ></div>
            </div>
          </div>

          <!-- Signal pills -->
          <div class="flex gap-1 flex-wrap ml-0">
            {#each getSignalEntries(item) as [tf, sig]}
              <span class="text-[10px] font-bold px-1.5 py-0.5 rounded {signalClass(sig.signal)}">
                {tf} {(sig.signal ?? 'hold').toUpperCase()}
              </span>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
