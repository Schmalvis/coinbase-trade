<script lang="ts">
  import { risk } from '../stores/risk';

  function fmtPct(v: number) {
    return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  }

  function fmtUsd(v: number) {
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Daily P&L bar: how far from the loss limit (limit is negative)
  // If pnl=-2 and limit=-5, pct used = 2/5 = 40%
  function dailyPnlBar(value: number, limit: number): number {
    if (limit === 0) return 0;
    const used = Math.abs(Math.min(value, 0)) / Math.abs(limit);
    return Math.min(used * 100, 100);
  }

  function rotationsBar(count: number, limit: number): number {
    if (limit === 0) return 0;
    return Math.min((count / limit) * 100, 100);
  }

  function positionBar(pct: number, limit: number): number {
    if (limit === 0) return 0;
    return Math.min((pct / limit) * 100, 100);
  }

  function floorBar(value: number, floor: number): number {
    if (floor === 0) return 0;
    // Show how close to the floor: full bar = at floor, empty = 2x floor away
    const ratio = (value - floor) / floor;
    return Math.max(0, Math.min(100, 100 - ratio * 50));
  }

  $: isEmpty =
    !$risk ||
    ($risk.dailyPnl === null &&
      $risk.rotationsToday === null &&
      $risk.maxPosition === null &&
      $risk.portfolioFloor === null &&
      $risk.optimizerStatus === 'Disabled');

  $: optimizerColor =
    $risk?.optimizerStatus === 'Active'
      ? 'text-accent-green'
      : $risk?.optimizerStatus === 'Risk-Off'
      ? 'text-yellow-400'
      : 'text-[var(--text-muted)]';

  $: optimizerDot =
    $risk?.optimizerStatus === 'Active'
      ? 'bg-accent-green'
      : $risk?.optimizerStatus === 'Risk-Off'
      ? 'bg-yellow-400'
      : 'bg-gray-500';
</script>

<div class="bg-[var(--bg-card)] rounded-xl border border-[var(--border)] p-4">
  <div class="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-3">Risk Monitor</div>

  {#if isEmpty}
    <div class="text-xs text-[var(--text-muted)] py-2">
      Enable the portfolio optimizer in Settings to activate risk monitoring.
    </div>
  {:else}
    <div class="grid grid-cols-2 md:grid-cols-5 gap-6">

      <!-- Daily P&L -->
      <div>
        <div class="text-xs text-[var(--text-muted)] mb-1">Daily P&amp;L</div>
        {#if $risk?.dailyPnl !== null && $risk?.dailyPnl !== undefined}
          {@const v = $risk.dailyPnl.value}
          {@const lim = $risk.dailyPnl.limit}
          <div class="text-xl font-bold {v >= 0 ? 'text-accent-green' : 'text-red-400'}">{fmtPct(v)}</div>
          <div class="text-[10px] text-[var(--text-muted)] mt-1">limit: {fmtPct(lim)}</div>
          <div class="w-full h-1 bg-[var(--border)] rounded-full mt-2">
            <div
              class="h-full rounded-full {v >= 0 ? 'bg-accent-green' : 'bg-red-400'}"
              style="width: {dailyPnlBar(v, lim)}%"
            ></div>
          </div>
        {:else}
          <div class="text-xl font-bold text-[var(--text-muted)]">—</div>
        {/if}
      </div>

      <!-- Rotations Today -->
      <div>
        <div class="text-xs text-[var(--text-muted)] mb-1">Rotations Today</div>
        {#if $risk?.rotationsToday !== null && $risk?.rotationsToday !== undefined}
          {@const c = $risk.rotationsToday.count}
          {@const lim = $risk.rotationsToday.limit}
          <div class="text-xl font-bold text-[var(--text-primary)]">{c} / {lim}</div>
          <div class="text-[10px] text-[var(--text-muted)] mt-1">daily max</div>
          <div class="w-full h-1 bg-[var(--border)] rounded-full mt-2">
            <div
              class="h-full rounded-full bg-blue-400"
              style="width: {rotationsBar(c, lim)}%"
            ></div>
          </div>
        {:else}
          <div class="text-xl font-bold text-[var(--text-muted)]">—</div>
        {/if}
      </div>

      <!-- Max Position -->
      <div>
        <div class="text-xs text-[var(--text-muted)] mb-1">Max Position</div>
        {#if $risk?.maxPosition !== null && $risk?.maxPosition !== undefined}
          {@const sym = $risk.maxPosition.symbol}
          {@const pct = $risk.maxPosition.pct}
          {@const lim = $risk.maxPosition.limit}
          {@const warn = pct > lim * 0.8}
          <div class="text-xl font-bold {warn ? 'text-yellow-400' : 'text-[var(--text-primary)]'}">
            {sym} {pct.toFixed(1)}%
          </div>
          <div class="text-[10px] text-[var(--text-muted)] mt-1">limit: {lim}%</div>
          <div class="w-full h-1 bg-[var(--border)] rounded-full mt-2">
            <div
              class="h-full rounded-full {warn ? 'bg-yellow-400' : 'bg-blue-400'}"
              style="width: {positionBar(pct, lim)}%"
            ></div>
          </div>
        {:else}
          <div class="text-xl font-bold text-[var(--text-muted)]">—</div>
        {/if}
      </div>

      <!-- Portfolio Floor -->
      <div>
        <div class="text-xs text-[var(--text-muted)] mb-1">Portfolio Floor</div>
        {#if $risk?.portfolioFloor !== null && $risk?.portfolioFloor !== undefined}
          {@const val = $risk.portfolioFloor.value}
          {@const fl = $risk.portfolioFloor.floor}
          {@const nearFloor = val < fl * 1.2}
          <div class="text-xl font-bold {nearFloor ? 'text-red-400' : 'text-accent-green'}">{fmtUsd(val)}</div>
          <div class="text-[10px] text-[var(--text-muted)] mt-1">floor: {fmtUsd(fl)}</div>
          <div class="w-full h-1 bg-[var(--border)] rounded-full mt-2">
            <div
              class="h-full rounded-full {nearFloor ? 'bg-red-400' : 'bg-accent-green'}"
              style="width: {floorBar(val, fl)}%"
            ></div>
          </div>
        {:else}
          <div class="text-xl font-bold text-[var(--text-muted)]">—</div>
        {/if}
      </div>

      <!-- Optimizer Status -->
      <div>
        <div class="text-xs text-[var(--text-muted)] mb-1">Optimizer</div>
        <div class="flex items-center gap-2 mt-1">
          <span class="inline-block w-2.5 h-2.5 rounded-full {optimizerDot}"></span>
          <span class="text-xl font-bold {optimizerColor}">{$risk?.optimizerStatus ?? '—'}</span>
        </div>
      </div>

    </div>
  {/if}
</div>
