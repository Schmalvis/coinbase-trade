<script lang="ts">
  import { scores } from '../stores/scores';
  import type { ScoreData } from '../types';

  $: sorted = ($scores || []).slice().sort((a: ScoreData, b: ScoreData) => b.score - a.score);

  function signalClass(signal: string): string {
    if (signal === 'buy') return 'bg-green-500/20 text-green-400';
    if (signal === 'sell') return 'bg-red-500/20 text-red-400';
    return 'bg-[var(--border)] text-[var(--text-muted)]';
  }

  function scoreColor(score: number): string {
    if (score > 20) return 'text-green-400';
    if (score < -20) return 'text-red-400';
    if (score > 0) return 'text-green-300';
    if (score < 0) return 'text-red-300';
    return 'text-[var(--text-muted)]';
  }

  function scoreBar(score: number): number {
    // Clamp to [-100, 100], map to [0, 100]%
    return Math.round((Math.max(-100, Math.min(100, score)) + 100) / 2);
  }
</script>

<div class="bg-[var(--bg-card)] rounded-xl border border-[var(--border)] p-4">
  <div class="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-3">
    Opportunity Scores
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
            <span class="font-bold text-sm w-12 text-right font-mono {scoreColor(item.score)}">
              {item.score > 0 ? '+' : ''}{item.score.toFixed(1)}
            </span>
            <!-- Mini score bar -->
            <div class="flex-1 h-1.5 bg-[var(--bg-primary)] rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-all duration-500"
                class:bg-green-400={item.score >= 0}
                class:bg-red-400={item.score < 0}
                style="width: {scoreBar(item.score)}%; margin-left: {item.score < 0 ? scoreBar(item.score) + '%' : '50%'}; {item.score < 0 ? 'margin-left:' + scoreBar(item.score) + '%; width:' + (50 - scoreBar(item.score)) + '%' : 'margin-left:50%; width:' + (scoreBar(item.score) - 50) + '%'}"
              ></div>
            </div>
          </div>

          <!-- Signal pills -->
          <div class="flex gap-1 flex-wrap ml-0">
            {#each Object.entries(item.signals || {}) as [tf, sig]}
              <span class="text-[10px] font-bold px-1.5 py-0.5 rounded {signalClass(sig.signal)}">
                {tf} {sig.signal.toUpperCase()}
              </span>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
