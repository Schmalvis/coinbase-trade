<script lang="ts">
  import { assets } from '../stores/assets';
  import { setTab } from '../stores/nav';

  $: holdings = ($assets ?? [])
    .filter(a => (a.price ?? 0) * (a.balance ?? 0) > 0.01)
    .map(a => ({ ...a, value: (a.price ?? 0) * (a.balance ?? 0) }))
    .sort((a, b) => b.value - a.value);

  $: totalValue = holdings.reduce((sum, a) => sum + a.value, 0);

  function fmtUsd(v: number): string {
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtBalance(bal: number | null | undefined): string {
    if (bal == null) return '--';
    if (bal >= 1) return bal.toLocaleString(undefined, { maximumFractionDigits: 4 });
    return bal.toPrecision(4);
  }

  function fmtChange(change: number | null | undefined): string {
    if (change == null) return '--';
    return (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
  }

  function weight(value: number): number {
    if (totalValue === 0) return 0;
    return (value / totalValue) * 100;
  }
</script>

<div class="bg-[var(--bg-card)] rounded-[var(--radius-card)] border border-[var(--border)] shadow-[var(--shadow)] p-4">
  <div class="flex items-center justify-between mb-3">
    <h2 class="text-sm font-semibold font-display text-[var(--text-primary)]">Holdings</h2>
    <button class="text-xs text-clay hover:text-clay-hover font-medium" on:click={() => setTab('assets')}>Manage →</button>
  </div>

  {#if holdings.length === 0}
    <p class="text-sm text-[var(--text-muted)] py-2">No holdings yet.</p>
  {:else}
    <div class="space-y-3">
      {#each holdings as h (h.address)}
        <div>
          <div class="flex items-center justify-between gap-2">
            <div class="min-w-0">
              <span class="font-semibold text-sm text-[var(--text-primary)]">{h.symbol}</span>
              <span class="text-xs text-[var(--text-muted)] ml-1.5 hidden sm:inline">{h.name ?? ''}</span>
            </div>
            <div class="flex items-center gap-3 shrink-0">
              <span class="text-xs text-[var(--text-secondary)] font-mono tabular-nums">{fmtBalance(h.balance)}</span>
              <span class="text-sm font-mono tabular-nums text-[var(--text-primary)] w-20 text-right">{fmtUsd(h.value)}</span>
              <span
                class="text-xs font-mono tabular-nums w-16 text-right"
                class:text-gain={(h.change24h ?? 0) > 0}
                class:text-loss={(h.change24h ?? 0) < 0}
                class:text-[var(--text-muted)]={h.change24h == null}
              >{fmtChange(h.change24h)}</span>
            </div>
          </div>
          <div class="w-full h-0.5 bg-[var(--border)] rounded-full mt-1.5">
            <div class="h-full bg-clay rounded-full" style="width: {Math.min(weight(h.value), 100)}%"></div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
