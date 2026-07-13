<script lang="ts">
  import { performance } from '../stores/performance';

  function fmtPnl(v: number | null | undefined): string {
    if (v == null) return '--';
    return (v >= 0 ? '+$' : '-$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtPct(v: number | null | undefined): string {
    if (v == null) return '--';
    return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  }
</script>

{#if $performance}
  <div class="grid grid-cols-2 lg:grid-cols-1 lg:h-full gap-3">
    {#each [
      { label: 'Today', pnl: $performance.today?.change, pct: $performance.today?.change_pct },
      { label: '7 days', pnl: $performance.week?.change, pct: $performance.week?.change_pct },
      { label: '30 days', pnl: $performance.month?.change, pct: $performance.month?.change_pct },
      { label: 'Total', pnl: $performance.total?.change, pct: $performance.total?.change_pct },
    ] as item}
      <div class="bg-[var(--bg-card)] rounded-[var(--radius-card)] border border-[var(--border)] shadow-[var(--shadow)] p-3.5">
        <div class="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)] mb-1">{item.label}</div>
        <div class="text-base font-semibold font-mono tabular-nums" class:text-gain={(item.pnl ?? 0) >= 0} class:text-loss={(item.pnl ?? 0) < 0}>
          {fmtPnl(item.pnl)}
        </div>
        <div class="text-xs font-mono tabular-nums" class:text-gain={(item.pct ?? 0) >= 0} class:text-loss={(item.pct ?? 0) < 0}>
          {fmtPct(item.pct)}
        </div>
      </div>
    {/each}
  </div>
{/if}
